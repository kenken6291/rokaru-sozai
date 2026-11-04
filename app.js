/**
 * app.js — ご当地スーパー・銘菓発掘図鑑
 * ──────────────────────────────────────────────────────────────
 * 構成: GitHub Pages(フロント) + GAS(API) + Googleスプレッドシート(DB)
 *      + Googleドライブ(写真保存) + Gemini API(説明文生成・読み上げ)
 * 会員認証は auth.js（window.Auth）。このファイルは auth.js の後に読み込むこと。
 *
 * v2.0.0
 *   - バージョン表示（ヘッダー・フッター・使い方）
 *   - 使い方モーダル
 *   - 公開範囲3段階: 🔒非公開(既定) / 👥指定した人だけ / 🌐みんなに公開
 *   - 共有管理画面: 投稿の公開状況を一覧でワンタップ切替、共有相手（共有コード）の追加・削除
 *   - LINE・共有シート・リンクコピーでその場で送信（?item=ID で該当記録を開く）
 *   - 音声入力: 言葉の間が空いても自動で聞き取りを再開（もう一度押すまで継続）
 *   - 読み上げ: 本文だけを音声化（「〜で読み上げてください」等の指示文を除去）
 *
 * セキュリティ方針:
 *   - XSS対策: createElement + textContent でDOM構築
 *   - 作成・編集・削除・公開範囲変更はセッション必須。権限判定はGAS側
 *   - 閲覧権限（非公開・限定公開）もGAS側で判定し、見てよい投稿だけが返る
 *   - ローカルキャッシュには「みんなに公開」の投稿のみ保存
 * ──────────────────────────────────────────────────────────────
 */

"use strict";

/* ============================================================
   設定
   ============================================================ */
const APP_VERSION      = "2.0.0";
const APP_VERSION_DATE = "2026-11-04";

const LOCAL_CACHE_KEY = "gotouchi_items_cache_v1";

const CATEGORY_EMOJI = {
  "惣菜": "🍱", "銘菓": "🍡", "珍味": "🐟", "飲み物": "🧃", "その他": "📦",
  "レストラン": "🍽️", "居酒屋": "🏮", "バー": "🍸"
};

const VIS_LABEL = {
  private: "🔒 非公開",
  members: "👥 指定した人だけ",
  public:  "🌐 みんなに公開"
};

const MAX_PHOTO_EDGE = 1280;
const PHOTO_QUALITY  = 0.82;

/* ============================================================
   アプリ状態
   ============================================================ */
let state = {
  items:        [],
  contacts:     [],      // 自分の共有相手 [{userId, nickname}]
  addedMe:      [],      // 自分を共有相手にしている人
  filterTag:    "all",
  searchQuery:  "",
  sortOrder:    "newest",
  isLoading:    true,
  isOnline:     false,
  editingId:    null,
  editingPhotoUrl: "",
  pendingPhoto: null,
  removePhotoFlag: false,
  formSharedWith: [],    // 投稿フォームで選んだ共有相手
  deepLinkId:   new URLSearchParams(location.search).get("item"),
  detailItemId: null,
};

/* ============================================================
   GAS APIラッパー
   ============================================================ */
async function callApi(action, payload) {
  const res = await fetch(GAS_API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, payload: payload || {} })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/* ============================================================
   公開範囲ヘルパー
   ============================================================ */
function visOf(item) {
  const v = item && item.visibility;
  if (v === "private" || v === "members" || v === "public") return v;
  return "public"; // 旧データ（空欄）は従来どおり公開
}
const isPrivate = (item) => visOf(item) === "private";
const isMine    = (item) => Auth.isLoggedIn() && !!Auth.getUserId() && item.userId === Auth.getUserId();
const sharedList = (item) => Array.isArray(item.sharedWith) ? item.sharedWith : [];

/* ============================================================
   ローカルキャッシュ
   ============================================================ */
function cacheItems(items) {
  const publicOnly = items.filter(it => visOf(it) === "public");
  try { localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(publicOnly)); } catch (e) {}
}
function loadCachedItems() {
  try { return JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY)) || []; } catch (e) { return []; }
}
function fetchList() {
  return callApi("list", { sessionToken: Auth.getSessionToken() });
}

/* ============================================================
   初期化
   ============================================================ */
async function init() {
  renderVersion();
  bindEvents();
  setLoadingUI(true);

  try {
    const res = await fetchList();
    if (!res.ok) throw new Error(res.error || "読み込みに失敗しました");
    state.items    = res.items;
    state.isOnline = true;
    cacheItems(res.items);
  } catch (err) {
    console.warn("API接続失敗 → キャッシュ表示に切り替え:", err);
    state.items    = loadCachedItems();
    state.isOnline = false;
    showToast("⚠️ サーバーに接続できません。保存済みの表示のみ行っています");
  }

  state.isLoading = false;
  setLoadingUI(false);
  renderCards();
  updateLoginOnlyTags();
  tryOpenDeepLink(false);

  Auth.onLoginChange(async () => {
    updateLoginOnlyTags();
    renderCards();
    if (!Auth.isLoggedIn()) {
      state.contacts = []; state.addedMe = [];
      closeModal("shareModal", true);
    }
    if (state.isOnline) {
      await refreshItems();
      if (Auth.isLoggedIn()) await loadContacts();
      tryOpenDeepLink(true);
    }
  });

  if (Auth.isLoggedIn() && state.isOnline) loadContacts();
  fetchApiVersion();
}

/* ============================================================
   バージョン表示
   ============================================================ */
function renderVersion() {
  document.getElementById("headerVersion").textContent = "v" + APP_VERSION;
  document.getElementById("footerVersion").textContent = `ご当地スーパー・銘菓発掘図鑑 v${APP_VERSION}（${APP_VERSION_DATE}）`;
  document.getElementById("helpVersion").textContent   = `v${APP_VERSION}（${APP_VERSION_DATE}）`;
}
async function fetchApiVersion() {
  try {
    const res = await callApi("version", {});
    if (res.ok && res.version) {
      const f = document.getElementById("footerVersion");
      f.textContent += ` ／ API v${res.version}`;
      document.getElementById("helpVersion").textContent += ` ／ API v${res.version}`;
    }
  } catch (e) { /* 旧API（version未対応）の場合は表示しない */ }
}

/* ============================================================
   共有リンク（?item=ID）で開く
   ============================================================ */
function tryOpenDeepLink(afterLogin) {
  if (!state.deepLinkId) return;
  const item = state.items.find(it => it.id === state.deepLinkId);
  if (item) {
    state.deepLinkId = null;
    history.replaceState(null, "", location.pathname);
    openDetailModal(item);
    return;
  }
  if (!Auth.isLoggedIn()) {
    if (!afterLogin) {
      showToast("🔐 この記録は共有された方だけが見られます。ログインしてください", 5000);
      Auth.openAuthModal("login");
    }
    return;
  }
  if (Auth.getUserId()) {
    state.deepLinkId = null;
    history.replaceState(null, "", location.pathname);
    showToast("⚠️ この記録は見る権限がないか、削除されています", 4500);
  }
}

/* ============================================================
   ログイン時のみ表示するフィルター
   ============================================================ */
function updateLoginOnlyTags() {
  const loggedIn = Auth.isLoggedIn();
  document.querySelectorAll("[data-login-only]").forEach(el => { el.hidden = !loggedIn; });
  if (!loggedIn && ["mine","shared","members","private"].includes(state.filterTag)) {
    state.filterTag = "all";
    document.querySelectorAll(".tag-btn").forEach(b => b.classList.toggle("active", b.dataset.tag === "all"));
  }
}

function setLoadingUI(loading) {
  const el = document.getElementById("loadingIndicator");
  if (!el) return;
  el.hidden = !loading;
  el.style.display = loading ? "flex" : "none";
}

/* ============================================================
   イベントバインド
   ============================================================ */
function bindEvents() {
  document.getElementById("btnOpenPost").addEventListener("click", () => {
    if (!Auth.requireLogin()) return;
    openPostModal();
  });
  document.getElementById("btnClosePost").addEventListener("click", closePostModal);
  document.getElementById("btnCloseDetail").addEventListener("click", closeDetailModal);

  // 背景クリックで閉じる
  [["postModal", closePostModal], ["detailModal", closeDetailModal],
   ["shareModal", () => closeModal("shareModal")], ["helpModal", () => closeModal("helpModal")]]
    .forEach(([id, fn]) => {
      document.getElementById(id).addEventListener("click", (e) => { if (e.target === e.currentTarget) fn(); });
    });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("shareModal").hidden)  { closeModal("shareModal"); return; }
    if (!document.getElementById("helpModal").hidden)   { closeModal("helpModal"); return; }
    if (!document.getElementById("postModal").hidden)   closePostModal();
    if (!document.getElementById("detailModal").hidden) closeDetailModal();
  });

  // 検索・フィルター・並び順
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.searchQuery = e.target.value.trim(); renderCards();
  });
  document.querySelectorAll(".tag-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filterTag = btn.dataset.tag;
      document.querySelectorAll(".tag-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderCards();
    });
  });
  document.getElementById("sortSelect").addEventListener("change", (e) => {
    state.sortOrder = e.target.value; renderCards();
  });

  // 使い方・規約
  const openHelp = (e) => { if (e) e.preventDefault(); openModal("helpModal"); };
  document.getElementById("btnHelp").addEventListener("click", openHelp);
  document.getElementById("linkFooterHelp").addEventListener("click", openHelp);
  document.getElementById("btnCloseHelp").addEventListener("click", () => closeModal("helpModal"));
  document.getElementById("linkFooterTerms").addEventListener("click", (e) => { e.preventDefault(); Auth.openTermsView(); });
  document.getElementById("btnHelpTerms").addEventListener("click", () => Auth.openTermsView());

  // 共有管理
  document.getElementById("btnShareManager").addEventListener("click", () => openShareManager("posts"));
  document.getElementById("btnCloseShare").addEventListener("click", () => closeModal("shareModal"));
  document.querySelectorAll(".share-tab").forEach(t =>
    t.addEventListener("click", () => switchShareTab(t.dataset.shareTab)));
  document.getElementById("btnAddContact").addEventListener("click", handleAddContact);
  document.getElementById("addContactCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); handleAddContact(); }
  });
  document.getElementById("btnCopyShareCode").addEventListener("click", () => {
    const code = Auth.getShareCode();
    if (code) copyText(code, "📋 共有コードをコピーしました");
  });
  document.getElementById("btnLineShareCode").addEventListener("click", () => {
    const code = Auth.getShareCode();
    if (!code) return;
    sendToLine(
      `「ご当地スーパー・銘菓発掘図鑑」の私の共有コードは【${code}】です。\n` +
      `ログイン後「👥 共有」→「共有相手」でこのコードを追加してね。お互いに追加すると、記録を見せ合えます。\n` +
      appBaseUrl()
    );
  });
  document.getElementById("btnInviteLine").addEventListener("click", () => {
    sendToLine(
      `旅先のご当地グルメを記録する「発掘図鑑」を使っています。\n` +
      `会員登録したら「👥 共有」にある共有コードを教えてね。記録を見せ合えます！\n` +
      appBaseUrl()
    );
  });

  // 投稿フォーム
  initStarRating();
  initPhotoField();
  document.getElementById("itemComment").addEventListener("input", (e) => {
    document.getElementById("charCount").textContent = `${e.target.value.length} / 200`;
  });
  document.getElementById("btnGenerateDesc").addEventListener("click", handleGenerateDescription);
  document.getElementById("postForm").addEventListener("submit", handleFormSubmit);
  document.querySelectorAll('input[name="visibility"]').forEach(r =>
    r.addEventListener("change", updateMemberPickerVisibility));
  document.getElementById("btnPickerAddContact").addEventListener("click", () => openShareManager("contacts"));

  // 音声入力
  document.querySelectorAll(".btn-mic").forEach(btn => {
    btn.addEventListener("click", () => VoiceInput.toggle(document.getElementById(btn.dataset.micTarget), btn));
  });
}

/* ============================================================
   星評価
   ============================================================ */
function initStarRating() {
  const stars = document.querySelectorAll(".star");
  let currentRating = 3;
  setStars(stars, currentRating);
  stars.forEach((star) => {
    const val = parseInt(star.dataset.value, 10);
    star.addEventListener("mouseenter", () => highlightStars(stars, val));
    star.addEventListener("mouseleave", () => highlightStars(stars, parseInt(document.getElementById("ratingValue").value, 10) || currentRating));
    const choose = () => {
      currentRating = val;
      document.getElementById("ratingValue").value = val;
      highlightStars(stars, val);
    };
    star.addEventListener("click", choose);
    star.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") choose(); });
  });
}
function setStars(stars, value) {
  stars.forEach(s => s.classList.toggle("active", parseInt(s.dataset.value) <= value));
}
function highlightStars(stars, value) {
  stars.forEach(s => {
    const v = parseInt(s.dataset.value);
    s.classList.toggle("active", v <= value);
    s.classList.toggle("hover",  v <= value);
  });
}

/* ============================================================
   写真
   ============================================================ */
function initPhotoField() {
  document.getElementById("itemPhoto").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast("❌ 画像ファイルを選択してください");
      e.target.value = "";
      return;
    }
    try {
      const { base64, mimeType } = await resizeImageToBase64(file, MAX_PHOTO_EDGE, PHOTO_QUALITY);
      state.pendingPhoto    = { base64, mimeType };
      state.removePhotoFlag = false;
      showPhotoPreview(base64);
    } catch (err) {
      console.error("画像処理エラー:", err);
      showToast("❌ 画像の読み込みに失敗しました");
    }
  });
  document.getElementById("btnRemovePhoto").addEventListener("click", () => {
    state.pendingPhoto    = null;
    state.removePhotoFlag = true;
    document.getElementById("itemPhoto").value = "";
    hidePhotoPreview();
  });
}

function resizeImageToBase64(file, maxEdge, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("画像の読み込みに失敗しました"));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxEdge || height > maxEdge) {
          const scale = maxEdge / Math.max(width, height);
          width  = Math.round(width  * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve({ base64: canvas.toDataURL("image/jpeg", quality), mimeType: "image/jpeg" });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
function showPhotoPreview(dataUrl) {
  document.getElementById("photoPreviewImg").src = dataUrl;
  document.getElementById("photoPreview").hidden = false;
}
function hidePhotoPreview() {
  document.getElementById("photoPreview").hidden = true;
  document.getElementById("photoPreviewImg").src = "";
}

/* ============================================================
   読み上げ・AI文の整形（「〜で読み上げてください」等の指示文を除去）
   ※ GAS側の cleanNarrationText と同じルール
   ============================================================ */
function cleanNarrationText(text) {
  let s = String(text || "").replace(/\r/g, "").trim();
  const patterns = [
    /^[^\n。]{0,40}?(で|を|に|風に|ように|調で)\s*(読み上げ|朗読|ナレーション|音読)[^\n。]{0,10}?(てください|て下さい|ください|下さい|します|してね|て)[。．!！:：、\s]*/,
    /^(以下|次)(は|の|を)[^\n。]{0,30}(文章|テキスト|内容|紹介文|コメント|原稿)[^\n。]{0,20}?(です[:：。]|[:：]|です)\s*/,
    /^(承知(いた)?しました|かしこまりました|了解(いた)?しました)[。!！、\s]*/,
    /^[（(【\[][^）)】\]]{0,30}(声|トーン|口調|スタイル|読み|ナレーション)[^）)】\]]{0,30}[）)】\]]\s*/
  ];
  for (let i = 0; i < 3; i++) {
    const before = s;
    patterns.forEach(p => { s = s.replace(p, "").trim(); });
    if (s === before) break;
  }
  return s.replace(/^["“「『]+|["”」』]+$/g, "").trim();
}

/* ============================================================
   Gemini: 説明文自動生成
   ============================================================ */
async function handleGenerateDescription() {
  const itemName  = document.getElementById("itemName").value.trim();
  const storeName = document.getElementById("storeName").value.trim();
  const region    = document.getElementById("regionTag").value;
  const category  = document.querySelector('input[name="category"]:checked')?.value ?? "その他";

  if (!itemName || !region) {
    showToast("⚠️ 商品名と地域を入力してから生成してください");
    return;
  }
  const btn = document.getElementById("btnGenerateDesc");
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "✨ 生成中...";
  try {
    const res = await callApi("generateDescription", { itemName, storeName, region, category });
    if (!res.ok) throw new Error(res.error || "生成に失敗しました");
    const text = cleanNarrationText(res.text).slice(0, 200);
    document.getElementById("itemComment").value = text;
    document.getElementById("charCount").textContent = `${text.length} / 200`;
  } catch (err) {
    console.error("説明文生成エラー:", err);
    showToast("❌ " + (err.message || "説明文の生成に失敗しました"));
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/* ============================================================
   投稿フォーム: 共有相手ピッカー
   ============================================================ */
function currentFormVisibility() {
  return document.querySelector('input[name="visibility"]:checked')?.value ?? "private";
}
function updateMemberPickerVisibility() {
  const vis = currentFormVisibility();
  document.getElementById("memberPicker").hidden = vis !== "members";
  const hint = document.getElementById("visibilityHint");
  hint.textContent = {
    private: "自分だけが見られます。あとから「👥 共有」画面でいつでも変更できます",
    members: "選んだ人がログインしたときだけ表示されます",
    public:  "ログインしていない人を含め、誰でも見られます"
  }[vis];
  if (vis === "members") renderMemberPicker();
}
function renderMemberPicker() {
  const list = document.getElementById("memberPickerList");
  list.innerHTML = "";
  if (state.contacts.length === 0) {
    const p = document.createElement("p");
    p.className = "form-hint";
    p.textContent = "まだ共有相手がいません。下の「＋ 共有相手を追加する」から登録してください。";
    list.appendChild(p);
    return;
  }
  state.contacts.forEach(c => {
    const chip = document.createElement("button");
    chip.type = "button";
    const on = state.formSharedWith.includes(c.userId);
    chip.className = "member-chip" + (on ? " is-on" : "");
    chip.textContent = (on ? "✓ " : "") + c.nickname;
    chip.setAttribute("aria-pressed", on ? "true" : "false");
    chip.addEventListener("click", () => {
      const i = state.formSharedWith.indexOf(c.userId);
      if (i === -1) state.formSharedWith.push(c.userId); else state.formSharedWith.splice(i, 1);
      renderMemberPicker();
    });
    list.appendChild(chip);
  });
}

/* ============================================================
   バリデーション・送信
   ============================================================ */
function validateForm() {
  let valid = true;
  [
    { id: "itemName",  errId: "itemNameError",  msg: "商品名を入力してください" },
    { id: "storeName", errId: "storeNameError", msg: "店舗名を入力してください" },
    { id: "regionTag", errId: "regionTagError", msg: "地域を選択してください"  },
  ].forEach(({ id, errId, msg }) => {
    const el = document.getElementById(id);
    const er = document.getElementById(errId);
    if (!el.value.trim()) { el.classList.add("is-error"); er.textContent = msg; valid = false; }
    else { el.classList.remove("is-error"); er.textContent = ""; }
  });
  return valid;
}

async function handleFormSubmit(e) {
  e.preventDefault();
  VoiceInput.stop();
  if (!Auth.requireLogin()) return;
  if (!validateForm()) return;
  if (!state.isOnline) { showToast("⚠️ サーバーに接続できていないため投稿できません"); return; }

  const visibility = currentFormVisibility();
  if (visibility === "members" && state.formSharedWith.length === 0) {
    if (!confirm("見せる相手がまだ選ばれていません。\nこのまま保存すると、今は自分だけが見られる状態になります。保存しますか？")) return;
  }

  const submitBtn = document.getElementById("btnSubmit");
  const isEditing = state.editingId !== null;
  submitBtn.disabled    = true;
  submitBtn.textContent = "⏳ 保存中...";

  const payload = {
    itemName:  document.getElementById("itemName").value.trim(),
    storeName: document.getElementById("storeName").value.trim(),
    region:    document.getElementById("regionTag").value,
    category:  document.querySelector('input[name="category"]:checked')?.value ?? "その他",
    rating:    parseInt(document.getElementById("ratingValue").value, 10) || 3,
    comment:   document.getElementById("itemComment").value.trim(),
    storeUrl:  document.getElementById("storeUrl").value.trim(),
    visibility,
    sharedWith: [...state.formSharedWith],
    sessionToken: Auth.getSessionToken(),
  };
  if (state.pendingPhoto) {
    payload.photoBase64   = state.pendingPhoto.base64;
    payload.photoMimeType = state.pendingPhoto.mimeType;
  }
  if (state.removePhotoFlag) payload.removePhoto = true;
  if (isEditing) payload.id = state.editingId;

  try {
    const res = await callApi(isEditing ? "update" : "create", payload);
    if (!res.ok) throw new Error(res.error || "保存に失敗しました");
    await refreshItems();
    closePostModal();
    const label = VIS_LABEL[visibility];
    showToast(isEditing ? `✏️ 修正しました（${label}）` : `📌 図鑑に登録しました（${label}）`);
  } catch (err) {
    console.error("保存エラー:", err);
    showToast("❌ " + (err.message || "保存に失敗しました。もう一度お試しください"));
  } finally {
    submitBtn.disabled    = false;
    submitBtn.textContent = state.editingId !== null ? "✏️ 修正を保存する" : "📌 図鑑に登録する";
  }
}

async function refreshItems() {
  try {
    const res = await fetchList();
    if (res.ok) {
      state.items = res.items;
      cacheItems(res.items);
      renderCards();
    }
  } catch (err) {
    console.warn("再取得に失敗:", err);
  }
}

function resetForm() {
  VoiceInput.stop();
  document.getElementById("postForm").reset();
  document.getElementById("charCount").textContent = "0 / 200";
  document.getElementById("ratingValue").value     = 3;
  setStars(document.querySelectorAll(".star"), 3);
  ["itemName","storeName","regionTag"].forEach(id => document.getElementById(id).classList.remove("is-error"));
  ["itemNameError","storeNameError","regionTagError"].forEach(id => document.getElementById(id).textContent = "");
  hidePhotoPreview();
  // 公開設定は既定で「非公開」
  const privRadio = document.querySelector('input[name="visibility"][value="private"]');
  if (privRadio) privRadio.checked = true;
  state.formSharedWith  = [];
  updateMemberPickerVisibility();
  state.pendingPhoto     = null;
  state.removePhotoFlag  = false;
  state.editingPhotoUrl  = "";
  state.editingId = null;
  document.getElementById("postModalTitle").textContent = "新しく記録する";
  document.getElementById("btnSubmit").textContent      = "📌 図鑑に登録する";
}

/* ============================================================
   モーダル開閉
   ============================================================ */
function anyModalOpen(exceptId) {
  return [...document.querySelectorAll(".modal-overlay")].some(m => m.id !== exceptId && !m.hidden);
}
function openModal(id, focusId) {
  const modal = document.getElementById(id);
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add("is-open"));
  document.body.style.overflow = "hidden";
  if (focusId) setTimeout(() => document.getElementById(focusId)?.focus(), 300);
}
function closeModal(id, immediate) {
  const modal = document.getElementById(id);
  if (!modal || modal.hidden) return;
  modal.classList.remove("is-open");
  const finish = () => {
    modal.hidden = true;
    if (!anyModalOpen(id)) document.body.style.overflow = "";
  };
  if (immediate) { finish(); return; }
  modal.addEventListener("transitionend", finish, { once: true });
}

function openPostModal(item = null) {
  if (item) {
    resetForm();
    state.editingId        = item.id;
    state.editingPhotoUrl  = item.photoUrl || "";
    document.getElementById("postModalTitle").textContent = "記録を修正する";
    document.getElementById("btnSubmit").textContent      = "✏️ 修正を保存する";
    document.getElementById("itemName").value    = item.itemName;
    document.getElementById("storeName").value   = item.storeName;
    document.getElementById("storeUrl").value    = item.storeUrl ?? "";
    document.getElementById("regionTag").value   = item.region;
    document.getElementById("itemComment").value = item.comment ?? "";
    document.getElementById("charCount").textContent = `${(item.comment ?? "").length} / 200`;
    const catRadio = document.querySelector(`input[name="category"][value="${item.category}"]`);
    if (catRadio) catRadio.checked = true;
    const rating = Number(item.rating) || 3;
    document.getElementById("ratingValue").value = rating;
    setStars(document.querySelectorAll(".star"), rating);
    if (item.photoUrl) showPhotoPreview(item.photoUrl); else hidePhotoPreview();
    const visRadio = document.querySelector(`input[name="visibility"][value="${visOf(item)}"]`);
    if (visRadio) visRadio.checked = true;
    state.formSharedWith = [...sharedList(item)];
    updateMemberPickerVisibility();
  } else {
    resetForm();
  }
  openModal("postModal", "itemName");
}

const closePostModal   = () => { resetForm(); closeModal("postModal"); };
const closeDetailModal = () => { Narrator.stop(); state.detailItemId = null; closeModal("detailModal"); };

function openDetailModal(item) {
  state.detailItemId = item.id;
  renderDetailBody(item);
  openModal("detailModal");
}

/* ============================================================
   カード一覧
   ============================================================ */
function getFilteredItems() {
  let items = [...state.items];
  const uid = Auth.getUserId();
  switch (state.filterTag) {
    case "all": break;
    case "mine":    items = uid ? items.filter(it => it.userId === uid) : []; break;
    case "shared":  items = items.filter(it => it.sharedToMe); break;
    case "members": items = uid ? items.filter(it => it.userId === uid && visOf(it) === "members") : []; break;
    case "private": items = uid ? items.filter(it => it.userId === uid && isPrivate(it)) : []; break;
    default:        items = items.filter(it => it.region === state.filterTag);
  }
  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    items = items.filter(it =>
      String(it.itemName).toLowerCase().includes(q) ||
      String(it.storeName).toLowerCase().includes(q) ||
      String(it.region).toLowerCase().includes(q)
    );
  }
  items.sort((a, b) => {
    if (state.sortOrder === "newest") return new Date(b.createdAt) - new Date(a.createdAt);
    if (state.sortOrder === "oldest") return new Date(a.createdAt) - new Date(b.createdAt);
    if (state.sortOrder === "rating") return b.rating - a.rating;
    return 0;
  });
  return items;
}

function renderCards() {
  const grid    = document.getElementById("cardGrid");
  const empty   = document.getElementById("emptyState");
  const countEl = document.getElementById("resultsCount");
  const items   = getFilteredItems();

  grid.innerHTML = "";
  if (items.length === 0) { empty.hidden = false; countEl.textContent = ""; return; }
  empty.hidden = true;
  countEl.textContent = `${items.length} 件`;
  items.forEach(item => grid.appendChild(buildCard(item)));
}

function buildThumb(item, className, placeholderClass) {
  const wrap = document.createElement("div");
  wrap.className = className;
  const makePh = () => {
    const ph = document.createElement("div");
    ph.className   = placeholderClass;
    ph.textContent = CATEGORY_EMOJI[item.category] ?? "📦";
    return ph;
  };
  if (item.photoUrl) {
    const img = document.createElement("img");
    img.src = item.photoUrl; img.alt = item.itemName; img.loading = "lazy";
    img.addEventListener("error", () => { img.remove(); wrap.prepend(makePh()); });
    wrap.appendChild(img);
  } else {
    wrap.appendChild(makePh());
  }
  return wrap;
}

/** カード・詳細に表示する公開範囲バッジの文言 */
function visibilityBadgeText(item) {
  if (item.sharedToMe) return `📨 ${item.nickname || "誰か"}さんから`;
  if (!isMine(item)) return "";
  const v = visOf(item);
  if (v === "private") return "🔒 非公開";
  if (v === "members") return `👥 ${sharedList(item).length}人に公開`;
  return "";
}

function buildCard(item) {
  const card = document.createElement("li");
  const v = visOf(item);
  card.className = "item-card" + (v === "private" ? " is-private" : "") + (v === "members" ? " is-members" : "");
  card.setAttribute("role", "listitem");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-label", `${item.itemName}（${item.storeName}）`);

  const thumb = buildThumb(item, "card-thumb", "card-thumb-placeholder");
  const stamp = document.createElement("div");
  stamp.className = "region-stamp"; stamp.dataset.region = item.region;
  stamp.textContent = String(item.region).replace("・", "\n");
  stamp.setAttribute("aria-hidden", "true");
  thumb.appendChild(stamp);
  const badgeText = visibilityBadgeText(item);
  if (badgeText) {
    const badge = document.createElement("span");
    badge.className = "private-badge" + (item.sharedToMe ? " private-badge--shared" : "") + (v === "members" ? " private-badge--members" : "");
    badge.textContent = badgeText;
    thumb.appendChild(badge);
  }
  card.appendChild(thumb);

  const body = document.createElement("div");
  body.className = "card-body";
  const cat   = document.createElement("p"); cat.className = "card-category";
  cat.textContent = `${CATEGORY_EMOJI[item.category] ?? "📦"} ${item.category}`;
  const name  = document.createElement("h3"); name.className = "card-name";
  name.textContent = item.itemName;
  const store = document.createElement("p"); store.className = "card-store";
  store.textContent = `🏪 ${item.storeName}`;
  const poster = document.createElement("p"); poster.className = "card-poster";
  poster.textContent = `投稿: ${item.nickname || "不明"}`;
  const stars = document.createElement("div"); stars.className = "card-stars";
  stars.setAttribute("aria-label", `評価 ${item.rating} 点`);
  stars.innerHTML = buildStarsHTML(item.rating);
  body.append(cat, name, store, poster, stars);
  card.appendChild(body);

  if (state.isOnline) {
    const dot = document.createElement("div"); dot.className = "sync-dot";
    dot.title = "クラウド同期済み"; dot.setAttribute("aria-hidden", "true");
    card.appendChild(dot);
  }

  const openDetail = () => openDetailModal(item);
  card.addEventListener("click", openDetail);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(); }
  });
  return card;
}

function buildStarsHTML(rating) {
  let html = "";
  for (let i = 1; i <= 5; i++) html += `<span class="${i <= rating ? "" : "empty"}">★</span>`;
  return html;
}

/* ============================================================
   公開範囲コントロール（詳細画面・共有管理一覧で共通）
   🔒 / 👥 / 🌐 の切り替えと、👥のときの相手オン/オフ
   ============================================================ */
function buildSharingControls(item, onChanged) {
  const wrap = document.createElement("div");
  wrap.className = "sharing-ctrl";

  const seg = document.createElement("div");
  seg.className = "seg";
  const chipsWrap = document.createElement("div");
  chipsWrap.className = "member-chips member-chips--inline";

  let busy = false;

  async function save(nextVis, nextShared) {
    if (busy) return;
    busy = true; wrap.classList.add("is-busy");
    const prevVis = item.visibility, prevShared = sharedList(item).slice();
    item.visibility = nextVis; item.sharedWith = nextShared;
    paint();
    try {
      const res = await callApi("setSharing", {
        id: item.id, visibility: nextVis, sharedWith: nextShared, sessionToken: Auth.getSessionToken()
      });
      if (!res.ok) throw new Error(res.error || "変更に失敗しました");
      item.visibility = res.visibility; item.sharedWith = res.sharedWith;
      const stItem = state.items.find(x => x.id === item.id);
      if (stItem && stItem !== item) { stItem.visibility = item.visibility; stItem.sharedWith = item.sharedWith; }
      cacheItems(state.items);
      renderCards();
      if (onChanged) onChanged();
    } catch (err) {
      item.visibility = prevVis; item.sharedWith = prevShared;
      showToast("❌ " + (err.message || "変更に失敗しました"));
    } finally {
      busy = false; wrap.classList.remove("is-busy");
      paint();
    }
  }

  const segDefs = [["private", "🔒 非公開"], ["members", "👥 指定"], ["public", "🌐 公開"]];
  const segBtns = segDefs.map(([v, label]) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "seg-btn"; b.textContent = label; b.dataset.vis = v;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (visOf(item) === v) return;
      if (v === "public" && !confirm(`「${item.itemName}」をみんなに公開しますか？\n（ログインしていない人も見られます）`)) return;
      save(v, sharedList(item).slice());
    });
    seg.appendChild(b);
    return b;
  });

  function paint() {
    const v = visOf(item);
    segBtns.forEach(b => {
      const on = b.dataset.vis === v;
      b.classList.toggle("is-on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    chipsWrap.innerHTML = "";
    chipsWrap.hidden = v !== "members";
    if (v !== "members") return;
    if (state.contacts.length === 0) {
      const a = document.createElement("button");
      a.type = "button"; a.className = "btn-link-small";
      a.textContent = "共有相手がいません → ＋追加する";
      a.addEventListener("click", (e) => { e.stopPropagation(); openShareManager("contacts"); });
      chipsWrap.appendChild(a);
      return;
    }
    const current = sharedList(item);
    state.contacts.forEach(c => {
      const on = current.includes(c.userId);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "member-chip" + (on ? " is-on" : "");
      chip.textContent = (on ? "✓ " : "") + c.nickname;
      chip.setAttribute("aria-pressed", on ? "true" : "false");
      chip.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = current.filter(id => id !== c.userId);
        if (!on) next.push(c.userId);
        save("members", next);
      });
      chipsWrap.appendChild(chip);
    });
    if (current.length === 0) {
      const p = document.createElement("span");
      p.className = "member-chips-note";
      p.textContent = "← 見せる人を押して選択（未選択の間は自分だけ）";
      chipsWrap.appendChild(p);
    }
  }

  paint();
  wrap.append(seg, chipsWrap);
  return wrap;
}

/* ============================================================
   詳細モーダル
   ============================================================ */
function renderDetailBody(item) {
  const body = document.getElementById("detailBody");
  body.innerHTML = "";

  body.appendChild(buildThumb(item, "detail-hero", "detail-hero-placeholder"));

  const meta    = document.createElement("div"); meta.className = "detail-meta";
  const catEl   = document.createElement("span"); catEl.className = "detail-category";
  catEl.textContent = `${CATEGORY_EMOJI[item.category] ?? "📦"} ${item.category}`;
  const regionEl = document.createElement("span"); regionEl.className = "detail-region";
  regionEl.textContent = item.region;
  meta.append(catEl, regionEl);
  const badgeText = visibilityBadgeText(item);
  if (badgeText) {
    const privEl = document.createElement("span"); privEl.className = "detail-private";
    privEl.textContent = badgeText;
    meta.appendChild(privEl);
  }
  const starsEl = document.createElement("div"); starsEl.className = "detail-stars";
  starsEl.setAttribute("aria-label", `評価 ${item.rating} 点`);
  starsEl.innerHTML = buildStarsHTML(item.rating);
  meta.appendChild(starsEl);
  body.appendChild(meta);

  const nameEl = document.createElement("h3"); nameEl.className = "detail-name";
  nameEl.textContent = item.itemName;
  body.appendChild(nameEl);

  const storeEl = document.createElement("p"); storeEl.className = "detail-store";
  storeEl.textContent = `🏪 ${item.storeName}`;
  body.appendChild(storeEl);

  const posterEl = document.createElement("p"); posterEl.className = "detail-poster";
  posterEl.textContent = `投稿者: ${item.nickname || "不明"}`;
  body.appendChild(posterEl);

  if (item.storeUrl && /^https?:\/\//i.test(item.storeUrl)) {
    const link = document.createElement("a");
    link.className = "detail-store-link";
    link.href = item.storeUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.textContent = "🔗 お店のページを見る";
    body.appendChild(link);
  }

  if (item.comment) {
    const commentEl = document.createElement("p"); commentEl.className = "detail-comment";
    commentEl.textContent = `"${item.comment}"`;
    body.appendChild(commentEl);
  }

  // 読み上げ
  const speakBtn = document.createElement("button");
  speakBtn.type = "button"; speakBtn.className = "btn-speak";
  speakBtn.textContent = "🔊 読み上げ";
  speakBtn.addEventListener("click", () => Narrator.toggle(buildNarration(item), speakBtn, item.id));
  body.appendChild(speakBtn);

  const dateEl = document.createElement("p"); dateEl.className = "detail-date";
  dateEl.textContent = `記録日: ${formatDate(item.createdAt)}`;
  if (state.isOnline) {
    const badge = document.createElement("span"); badge.className = "cloud-badge";
    badge.textContent = "☁️ クラウド同期済み";
    dateEl.appendChild(badge);
  }
  body.appendChild(dateEl);

  // その場で共有（LINEなど）
  body.appendChild(buildShareRow(item));

  if (isMine(item)) {
    // 公開範囲
    const visBox = document.createElement("div"); visBox.className = "detail-section";
    const visTitle = document.createElement("p"); visTitle.className = "detail-section-title";
    visTitle.textContent = "公開範囲（押すとすぐ切り替わります）";
    visBox.append(visTitle, buildSharingControls(item, () => {
      // バッジ表示を更新
      if (state.detailItemId === item.id) {
        const badge = body.querySelector(".detail-private");
        const t = visibilityBadgeText(item);
        if (badge) { badge.textContent = t; badge.hidden = !t; }
      }
    }));
    body.appendChild(visBox);

    const btnRow = document.createElement("div"); btnRow.className = "detail-btn-row";
    const editBtn = document.createElement("button"); editBtn.className = "btn-edit";
    editBtn.textContent = "✏️ 修正する";
    editBtn.addEventListener("click", () => {
      closeDetailModal();
      setTimeout(() => openPostModal(item), 300);
    });
    const delBtn = document.createElement("button"); delBtn.className = "btn-delete";
    delBtn.textContent = "🗑 削除";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`「${item.itemName}」を削除しますか？`)) return;
      delBtn.disabled = true; delBtn.textContent = "⏳ 削除中...";
      try {
        const res = await callApi("delete", { id: item.id, sessionToken: Auth.getSessionToken() });
        if (!res.ok) throw new Error(res.error || "削除に失敗しました");
        await refreshItems();
        closeDetailModal();
        showToast("🗑 削除しました");
      } catch (err) {
        showToast("❌ " + (err.message || "削除に失敗しました"));
        delBtn.disabled = false; delBtn.textContent = "🗑 削除";
      }
    });
    btnRow.append(editBtn, delBtn);
    body.appendChild(btnRow);
  } else if (Auth.isLoggedIn()) {
    const noteEl = document.createElement("p"); noteEl.className = "detail-date";
    noteEl.style.marginTop = "16px";
    noteEl.textContent = "※ 他のユーザーの投稿は編集・削除できません";
    body.appendChild(noteEl);
  }
}

/** 読み上げ用の文章（内容のみ。指示文は含めない） */
function buildNarration(item) {
  const parts = [
    `${item.itemName}。`,
    `お店は、${item.storeName}。`,
    `${item.region}の${item.category}です。`,
    `おすすめ度は、星${item.rating}つ。`
  ];
  if (item.comment) parts.push(cleanNarrationText(item.comment));
  return parts.join("");
}

/* ============================================================
   その場で共有（LINE / 共有シート / リンクコピー）
   ============================================================ */
function appBaseUrl() { return location.origin + location.pathname; }
function itemShareUrl(item) { return appBaseUrl() + "?item=" + encodeURIComponent(item.id); }
function itemShareText(item) {
  return `【ご当地発掘図鑑】${item.itemName}（${item.storeName}／${item.region}）`;
}

function sendToLine(text) {
  const url = "https://line.me/R/share?text=" + encodeURIComponent(text);
  window.open(url, "_blank", "noopener");
}

async function copyText(text, msg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(msg || "📋 コピーしました");
  } catch (e) {
    window.prompt("コピーしてお使いください", text);
  }
}

/** 共有前の確認（公開範囲によって相手が見られるかを案内） */
function confirmShareable(item) {
  if (!isMine(item)) return true;
  const v = visOf(item);
  if (v === "private") {
    return confirm("この記録は「🔒 非公開」なので、リンクを送っても相手は見られません。\n" +
      "見せたい場合は、先に公開範囲を「👥 指定」か「🌐 公開」に変えてください。\n\nこのまま送りますか？");
  }
  if (v === "members" && sharedList(item).length === 0) {
    return confirm("「👥 指定」ですが、まだ見せる相手が選ばれていません。\nこのまま送りますか？");
  }
  return true;
}

function buildShareRow(item) {
  const box = document.createElement("div"); box.className = "detail-section";
  const title = document.createElement("p"); title.className = "detail-section-title";
  title.textContent = "📤 この記録を送る";
  const row = document.createElement("div"); row.className = "share-row";

  const lineBtn = document.createElement("button");
  lineBtn.type = "button"; lineBtn.className = "btn-small btn-line";
  lineBtn.textContent = "LINEで送る";
  lineBtn.addEventListener("click", () => {
    if (!confirmShareable(item)) return;
    sendToLine(itemShareText(item) + "\n" + itemShareUrl(item));
  });
  row.appendChild(lineBtn);

  if (navigator.share) {
    const osBtn = document.createElement("button");
    osBtn.type = "button"; osBtn.className = "btn-small";
    osBtn.textContent = "📱 その他のアプリ";
    osBtn.addEventListener("click", async () => {
      if (!confirmShareable(item)) return;
      try {
        await navigator.share({ title: item.itemName, text: itemShareText(item), url: itemShareUrl(item) });
      } catch (e) { /* キャンセル時は何もしない */ }
    });
    row.appendChild(osBtn);
  }

  const copyBtn = document.createElement("button");
  copyBtn.type = "button"; copyBtn.className = "btn-small";
  copyBtn.textContent = "🔗 リンクをコピー";
  copyBtn.addEventListener("click", () => {
    if (!confirmShareable(item)) return;
    copyText(itemShareUrl(item), "🔗 リンクをコピーしました");
  });
  row.appendChild(copyBtn);

  box.append(title, row);
  if (isMine(item) && visOf(item) === "members") {
    const note = document.createElement("p"); note.className = "form-hint";
    note.textContent = "※ 指定した相手がログインしたときだけ表示されます";
    box.appendChild(note);
  }
  return box;
}

/* ============================================================
   共有管理モーダル
   ============================================================ */
async function loadContacts() {
  if (!Auth.isLoggedIn()) return;
  try {
    const res = await callApi("listContacts", { sessionToken: Auth.getSessionToken() });
    if (res.ok) {
      state.contacts = res.contacts || [];
      state.addedMe  = res.addedMe || [];
    }
  } catch (e) { console.warn("共有相手の取得に失敗:", e); }
}

async function openShareManager(tab) {
  if (!Auth.requireLogin()) return;
  switchShareTab(tab || "posts");
  openModal("shareModal");
  document.getElementById("myShareCode").textContent = Auth.getShareCode() || "--------";
  await loadContacts();
  renderShareManager();
}

function switchShareTab(tab) {
  document.querySelectorAll(".share-tab").forEach(t => t.classList.toggle("active", t.dataset.shareTab === tab));
  document.getElementById("sharePanePosts").hidden    = tab !== "posts";
  document.getElementById("sharePaneContacts").hidden = tab !== "contacts";
}

function renderShareManager() {
  document.getElementById("myShareCode").textContent = Auth.getShareCode() || "--------";
  renderSharePostList();
  renderContactList();
  if (!document.getElementById("postModal").hidden) renderMemberPicker();
}

function renderShareSummary(mine) {
  const c = { private: 0, members: 0, public: 0 };
  mine.forEach(it => { c[visOf(it)]++; });
  document.getElementById("shareSummary").textContent =
    `全${mine.length}件　🔒 非公開 ${c.private}　👥 指定 ${c.members}　🌐 公開 ${c.public}`;
}

function renderSharePostList() {
  const list = document.getElementById("sharePostList");
  list.innerHTML = "";
  const uid = Auth.getUserId();
  const mine = state.items.filter(it => it.userId === uid)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  document.getElementById("sharePostEmpty").hidden = mine.length > 0;
  renderShareSummary(mine);

  mine.forEach(item => {
    const li = document.createElement("li"); li.className = "share-post";
    const head = document.createElement("div"); head.className = "share-post-head";
    head.appendChild(buildThumb(item, "share-post-thumb", "share-post-ph"));
    const info = document.createElement("div"); info.className = "share-post-info";
    const n = document.createElement("p"); n.className = "share-post-name"; n.textContent = item.itemName;
    const s = document.createElement("p"); s.className = "share-post-store"; s.textContent = `${item.storeName}・${item.region}`;
    info.append(n, s);
    head.appendChild(info);
    const openBtn = document.createElement("button");
    openBtn.type = "button"; openBtn.className = "btn-small"; openBtn.textContent = "開く";
    openBtn.addEventListener("click", () => { closeModal("shareModal"); setTimeout(() => openDetailModal(item), 250); });
    head.appendChild(openBtn);
    li.appendChild(head);
    li.appendChild(buildSharingControls(item, () => renderShareSummary(state.items.filter(it => it.userId === uid))));
    list.appendChild(li);
  });
}

function renderContactList() {
  const list = document.getElementById("contactList");
  list.innerHTML = "";
  document.getElementById("contactEmpty").hidden = state.contacts.length > 0;
  const uid = Auth.getUserId();

  state.contacts.forEach(c => {
    const count = state.items.filter(it =>
      it.userId === uid && visOf(it) === "members" && sharedList(it).includes(c.userId)).length;
    const li = document.createElement("li"); li.className = "contact-item";
    const name = document.createElement("div"); name.className = "contact-name";
    const strong = document.createElement("strong"); strong.textContent = c.nickname;
    const small = document.createElement("span"); small.className = "contact-count";
    small.textContent = `　この人に公開中: ${count}件`;
    name.append(strong, small);

    const actions = document.createElement("div"); actions.className = "contact-actions";
    const stopBtn = document.createElement("button");
    stopBtn.type = "button"; stopBtn.className = "btn-small"; stopBtn.textContent = "公開を全部やめる";
    stopBtn.disabled = count === 0;
    stopBtn.addEventListener("click", async () => {
      if (!confirm(`${c.nickname}さんへの公開（${count}件）をすべてやめますか？\n（共有相手としては残ります）`)) return;
      stopBtn.disabled = true;
      try {
        const res = await callApi("stopSharingWith", { contactUserId: c.userId, sessionToken: Auth.getSessionToken() });
        if (!res.ok) throw new Error(res.error);
        await refreshItems();
        renderShareManager();
        showToast(`🔒 ${c.nickname}さんへの公開をやめました`);
      } catch (e) { showToast("❌ 変更に失敗しました"); stopBtn.disabled = false; }
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button"; delBtn.className = "btn-small btn-small--danger"; delBtn.textContent = "削除";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`${c.nickname}さんを共有相手から削除しますか？\n（この人への公開もすべて解除されます）`)) return;
      delBtn.disabled = true;
      try {
        const res = await callApi("removeContact", { contactUserId: c.userId, sessionToken: Auth.getSessionToken() });
        if (!res.ok) throw new Error(res.error);
        await refreshItems();
        await loadContacts();
        renderShareManager();
        showToast("🗑 共有相手を削除しました");
      } catch (e) { showToast("❌ 削除に失敗しました"); delBtn.disabled = false; }
    });
    actions.append(stopBtn, delBtn);
    li.append(name, actions);
    list.appendChild(li);
  });

  const addedWrap = document.getElementById("addedMeWrap");
  const addedList = document.getElementById("addedMeList");
  addedList.innerHTML = "";
  addedWrap.hidden = state.addedMe.length === 0;
  state.addedMe.forEach(a => {
    const li = document.createElement("li");
    const isMutual = state.contacts.some(c => c.userId === a.userId);
    li.textContent = `${a.nickname}さん` + (isMutual ? "（お互いに登録済み）" : "（あなたからは未登録：相手の共有コードを追加すると見せられます）");
    addedList.appendChild(li);
  });
}

async function handleAddContact() {
  const input = document.getElementById("addContactCode");
  const errEl = document.getElementById("addContactError");
  const btn = document.getElementById("btnAddContact");
  errEl.textContent = "";
  const code = input.value.trim();
  if (!code) { errEl.textContent = "共有コードを入力してください"; return; }
  btn.disabled = true; btn.textContent = "⏳";
  try {
    const res = await callApi("addContact", { shareCode: code, sessionToken: Auth.getSessionToken() });
    if (!res.ok) { errEl.textContent = res.error || "追加に失敗しました"; return; }
    input.value = "";
    await loadContacts();
    renderShareManager();
    showToast(`👥 ${res.contact.nickname}さんを共有相手に追加しました`);
  } catch (e) {
    errEl.textContent = "通信エラーが発生しました";
  } finally {
    btn.disabled = false; btn.textContent = "追加";
  }
}

/* ============================================================
   音声入力
   - continuous で聞き取り、ブラウザが無音で止めても自動で再開する
   - もう一度ボタンを押すまで（または長時間無音で）継続
   ============================================================ */
const VoiceInput = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const IDLE_LIMIT_MS = 90 * 1000; // 90秒まったく声がなければ自動終了

  let rec = null, active = false, target = null, button = null;
  let baseText = "", doneText = "", sessionFinal = "", interim = "";
  let lastHeard = 0, idleTimer = null, restartTimer = null;

  const statusEl = () => document.getElementById("micStatus");

  function setStatus(text) {
    const el = statusEl();
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || "";
  }

  function write() {
    if (!target) return;
    const max = Number(target.getAttribute("maxlength")) || 10000;
    target.value = (baseText + doneText + sessionFinal + interim).slice(0, max);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function startSession() {
    rec = new SR();
    rec.lang = "ja-JP";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    sessionFinal = ""; interim = "";

    rec.onresult = (e) => {
      let finals = "", inter = "";
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) {
          // 一部端末で前の確定結果を含んだ形で返ることがあるため重複を除く
          if (finals && t.startsWith(finals)) finals = t; else finals += t;
        } else {
          inter += t;
        }
      }
      sessionFinal = finals; interim = inter;
      lastHeard = Date.now();
      write();
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
        showToast("🎤 マイクが使えません。ブラウザのマイク許可を確認してください");
        stop();
      }
      // no-speech / aborted / network は onend で自動再開
    };
    rec.onend = () => {
      doneText += sessionFinal; sessionFinal = ""; interim = "";
      write();
      if (active) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(() => { if (active) { try { startSession(); } catch (_) {} } }, 200);
      }
    };
    try { rec.start(); } catch (e) { /* 二重startは無視 */ }
  }

  function start(el, btn) {
    if (!SR) { showToast("⚠️ このブラウザは音声入力に対応していません（Chrome・Edge・Safari推奨）"); return; }
    if (active) stop();
    target = el; button = btn;
    baseText = el.value.replace(/\s+$/, ""); // 既存の文字の後ろに続けて入力
    doneText = ""; sessionFinal = ""; interim = "";
    active = true; lastHeard = Date.now();
    button.classList.add("is-recording");
    button.dataset.label = button.textContent;
    button.textContent = button.classList.contains("btn-mic--wide") ? "⏹ 止める" : "⏹";
    setStatus("🎙 聞き取り中…（間が空いても続けます。終わったら「⏹」を押してください）");
    clearInterval(idleTimer);
    idleTimer = setInterval(() => {
      if (active && Date.now() - lastHeard > IDLE_LIMIT_MS) { stop(); showToast("🎤 しばらく声がなかったので音声入力を終了しました"); }
    }, 5000);
    startSession();
  }

  function stop() {
    if (!active) return;
    active = false;
    clearTimeout(restartTimer); clearInterval(idleTimer);
    try { rec && rec.stop(); } catch (e) {}
    doneText += sessionFinal; sessionFinal = ""; interim = "";
    write();
    if (button) {
      button.classList.remove("is-recording");
      button.textContent = button.dataset.label || "🎤";
    }
    setStatus("");
    rec = null; target = null; button = null;
  }

  function toggle(el, btn) {
    if (active && button === btn) stop(); else start(el, btn);
  }

  return { toggle, stop };
})();

/* ============================================================
   読み上げ
   - ログイン中: GAS経由のGemini TTS（本文のみ送信）
   - それ以外・失敗時: 端末の音声合成
   ============================================================ */
const Narrator = (() => {
  let audio = null, currentBtn = null, currentLabel = "", playingKey = null;
  const cache = new Map();

  function resetBtn() {
    if (currentBtn) { currentBtn.textContent = currentLabel || "🔊 読み上げ"; currentBtn.disabled = false; }
    currentBtn = null; playingKey = null;
  }

  function stop() {
    if (audio) { try { audio.pause(); } catch (e) {} audio = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    resetBtn();
  }

  function pcmToWavBlob(b64, mime) {
    const rate = Number((/rate=(\d+)/.exec(mime || "") || [])[1]) || 24000;
    const bin = atob(b64);
    const len = bin.length;
    const buf = new ArrayBuffer(44 + len);
    const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + len, true); w(8, "WAVE");
    w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, "data"); v.setUint32(40, len, true);
    const bytes = new Uint8Array(buf, 44);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([buf], { type: "audio/wav" });
  }

  function speakWithBrowser(text) {
    if (!window.speechSynthesis) { showToast("⚠️ この端末は読み上げに対応していません"); resetBtn(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP"; u.rate = 1.0;
    const ja = window.speechSynthesis.getVoices().find(v => /ja/i.test(v.lang));
    if (ja) u.voice = ja;
    u.onend = resetBtn; u.onerror = resetBtn;
    if (currentBtn) currentBtn.textContent = "⏹ 停止";
    window.speechSynthesis.speak(u);
  }

  async function toggle(rawText, btn, key) {
    if (currentBtn === btn) { stop(); return; }
    stop();
    const text = cleanNarrationText(rawText);
    if (!text) return;
    currentBtn = btn; currentLabel = btn.textContent; playingKey = key || text;

    // iOS対策: クリック直後に Audio を作って再生権限を確保
    audio = new Audio();
    audio.play().catch(() => {});

    if (!Auth.isLoggedIn() || !state.isOnline) { speakWithBrowser(text); return; }

    btn.textContent = "⏳ 準備中…"; btn.disabled = true;
    try {
      let url = cache.get(text);
      if (!url) {
        const res = await callApi("tts", { text, sessionToken: Auth.getSessionToken() });
        if (!res.ok || !res.audioBase64) throw new Error(res.error || "TTS失敗");
        const mime = res.mimeType || "";
        const blob = /wav|mpeg|mp3|ogg/i.test(mime)
          ? new Blob([Uint8Array.from(atob(res.audioBase64), c => c.charCodeAt(0))], { type: mime })
          : pcmToWavBlob(res.audioBase64, mime);
        url = URL.createObjectURL(blob);
        cache.set(text, url);
      }
      if (currentBtn !== btn) return; // 準備中に止められた
      btn.disabled = false; btn.textContent = "⏹ 停止";
      audio.src = url;
      audio.onended = resetBtn;
      audio.onerror = () => { audio = null; speakWithBrowser(text); };
      await audio.play();
    } catch (err) {
      console.warn("AI読み上げに失敗 → 端末の音声で読み上げ:", err);
      if (currentBtn !== btn) return;
      btn.disabled = false;
      audio = null;
      speakWithBrowser(text);
    }
  }

  // 音声リストの事前読み込み（Chrome対策）
  if (window.speechSynthesis) window.speechSynthesis.getVoices();

  return { toggle, stop };
})();

/* ============================================================
   ユーティリティ
   ============================================================ */
function formatDate(isoStr) {
  try {
    return new Date(isoStr).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric" });
  } catch { return ""; }
}

let toastTimer = null;
function showToast(msg, duration = 3200) {
  const toast = document.getElementById("toast");
  toast.textContent = msg; toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("is-show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("is-show");
    toast.addEventListener("transitionend", () => { toast.hidden = true; }, { once: true });
  }, duration);
}
window.showToast = showToast;

/* ============================================================
   起動
   ============================================================ */
document.addEventListener("DOMContentLoaded", init);
