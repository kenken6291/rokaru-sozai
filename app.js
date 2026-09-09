/**
 * app.js — ご当地スーパー・銘菓発掘図鑑
 * ──────────────────────────────────────────────────────────────
 * 構成: GitHub Pages(フロント) + GAS(API) + Googleスプレッドシート(DB)
 *      + Googleドライブ(写真保存) + Gemini API(説明文自動生成)
 * 会員認証は auth.js（window.Auth）が担当。このファイルはauth.jsの後に読み込むこと。
 * Firebaseは不使用。
 *
 * セキュリティ方針:
 *   - XSS対策: createElement + textContent ベースのDOM構築（サニタイズ処理はしない）
 *   - 投稿の作成・編集・削除は Auth.getSessionToken() が必須。GAS側でセッションと
 *     投稿のuserIdを突き合わせて権限判定する
 *   - APIキー（Gemini）はGAS側のスクリプトプロパティにのみ保持
 * ──────────────────────────────────────────────────────────────
 */

"use strict";

/* ============================================================
   設定
   ============================================================ */
// GAS_API_URL は auth.js で定義済み（このファイルより先に読み込む前提）

const LOCAL_CACHE_KEY = "gotouchi_items_cache_v1";

const CATEGORY_EMOJI = {
  "惣菜": "🍱", "銘菓": "🍡", "珍味": "🐟", "飲み物": "🧃", "その他": "📦"
};

const MAX_PHOTO_EDGE = 1280;   // 写真アップロード時の長辺の最大px
const PHOTO_QUALITY  = 0.82;   // JPEG圧縮品質

/* ============================================================
   アプリ状態
   ============================================================ */
let state = {
  items:        [],
  filterTag:    "all",
  searchQuery:  "",
  sortOrder:    "newest",
  isLoading:    true,
  isOnline:     false,
  editingId:    null,        // 編集中のアイテムID（nullなら新規）
  editingPhotoUrl: "",       // 編集中アイテムの既存写真URL
  pendingPhoto: null,        // { base64, mimeType } | null
  removePhotoFlag: false,
};

/* ============================================================
   GAS APIラッパー
   ============================================================ */
async function callApi(action, payload) {
  const res = await fetch(GAS_API_URL, {
    method: "POST",
    // text/plain指定でCORSプリフライトを回避（GAS側の established パターン）
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action, payload: payload || {} })
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

/* ============================================================
   ローカルキャッシュ（オフライン時の閲覧用フォールバック）
   ============================================================ */
function cacheItems(items) {
  try { localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(items)); } catch (e) { /* 容量不足は無視 */ }
}
function loadCachedItems() {
  try { return JSON.parse(localStorage.getItem(LOCAL_CACHE_KEY)) || []; } catch (e) { return []; }
}

/* ============================================================
   初期化
   ============================================================ */
async function init() {
  bindEvents();
  setLoadingUI(true);

  try {
    const res = await callApi("list");
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

  // ログイン状態が変わったら（ログイン/ログアウト/ニックネーム変更）カードを再描画
  Auth.onLoginChange(renderCards);
}

/* ============================================================
   ローディングUI
   ============================================================ */
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

  document.getElementById("postModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closePostModal();
  });
  document.getElementById("detailModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeDetailModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!document.getElementById("postModal").hidden)   closePostModal();
    if (!document.getElementById("detailModal").hidden) closeDetailModal();
  });

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

  initStarRating();
  initPhotoField();

  document.getElementById("itemComment").addEventListener("input", (e) => {
    document.getElementById("charCount").textContent = `${e.target.value.length} / 200`;
  });

  document.getElementById("btnGenerateDesc").addEventListener("click", handleGenerateDescription);

  document.getElementById("postForm").addEventListener("submit", handleFormSubmit);
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
    star.addEventListener("mouseleave", () => highlightStars(stars, currentRating));
    star.addEventListener("click", () => {
      currentRating = val;
      document.getElementById("ratingValue").value = val;
      highlightStars(stars, val);
    });
    star.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        currentRating = val;
        document.getElementById("ratingValue").value = val;
        highlightStars(stars, val);
      }
    });
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
   写真アップロード（Googleドライブ保存用）
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
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve({ base64: dataUrl, mimeType: "image/jpeg" });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function showPhotoPreview(dataUrl) {
  const wrap = document.getElementById("photoPreview");
  document.getElementById("photoPreviewImg").src = dataUrl;
  wrap.hidden = false;
}
function hidePhotoPreview() {
  document.getElementById("photoPreview").hidden = true;
  document.getElementById("photoPreviewImg").src = "";
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
    const textarea = document.getElementById("itemComment");
    textarea.value = res.text;
    document.getElementById("charCount").textContent = `${res.text.length} / 200`;
  } catch (err) {
    console.error("説明文生成エラー:", err);
    showToast("❌ " + (err.message || "説明文の生成に失敗しました"));
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/* ============================================================
   バリデーション
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
    if (!el.value.trim()) {
      el.classList.add("is-error"); er.textContent = msg; valid = false;
    } else {
      el.classList.remove("is-error"); er.textContent = "";
    }
  });
  return valid;
}

/* ============================================================
   フォーム送信（新規 & 編集共用）
   ============================================================ */
async function handleFormSubmit(e) {
  e.preventDefault();
  if (!Auth.requireLogin()) return;
  if (!validateForm()) return;
  if (!state.isOnline) {
    showToast("⚠️ サーバーに接続できていないため投稿できません");
    return;
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
    sessionToken: Auth.getSessionToken(),
  };
  if (state.pendingPhoto) {
    payload.photoBase64   = state.pendingPhoto.base64;
    payload.photoMimeType = state.pendingPhoto.mimeType;
  }
  if (state.removePhotoFlag) {
    payload.removePhoto = true;
  }
  if (isEditing) payload.id = state.editingId;

  try {
    const res = await callApi(isEditing ? "update" : "create", payload);
    if (!res.ok) throw new Error(res.error || "保存に失敗しました");

    await refreshItems();
    closePostModal();
    resetForm();
    showToast(isEditing ? "✏️ 修正しました！" : "📌 図鑑に登録しました！");
  } catch (err) {
    console.error("保存エラー:", err);
    showToast("❌ " + (err.message || "保存に失敗しました。もう一度お試しください"));
  } finally {
    submitBtn.disabled    = false;
    submitBtn.textContent = isEditing ? "✏️ 修正を保存する" : "📌 図鑑に登録する";
  }
}

async function refreshItems() {
  try {
    const res = await callApi("list");
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
  document.getElementById("postForm").reset();
  document.getElementById("charCount").textContent = "0 / 200";
  document.getElementById("ratingValue").value     = 3;
  setStars(document.querySelectorAll(".star"), 3);
  ["itemName","storeName","regionTag"].forEach(id =>
    document.getElementById(id).classList.remove("is-error")
  );
  ["itemNameError","storeNameError","regionTagError"].forEach(id =>
    document.getElementById(id).textContent = ""
  );
  hidePhotoPreview();
  state.pendingPhoto     = null;
  state.removePhotoFlag  = false;
  state.editingPhotoUrl  = "";
  // フォームを新規モードに戻す
  state.editingId = null;
  document.getElementById("postModalTitle").textContent = "新しく記録する";
  document.getElementById("btnSubmit").textContent      = "📌 図鑑に登録する";
}

/* ============================================================
   モーダル開閉
   ============================================================ */
function openModal(id, focusId) {
  const modal = document.getElementById(id);
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add("is-open"));
  document.body.style.overflow = "hidden";
  if (focusId) setTimeout(() => document.getElementById(focusId)?.focus(), 300);
}
function closeModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove("is-open");
  modal.addEventListener("transitionend", () => {
    modal.hidden = true;
    document.body.style.overflow = "";
  }, { once: true });
}

function openPostModal(item = null) {
  if (item) {
    // 編集モード: フォームに既存値をセット
    state.editingId        = item.id;
    state.editingPhotoUrl  = item.photoUrl || "";
    state.pendingPhoto     = null;
    state.removePhotoFlag  = false;
    document.getElementById("postModalTitle").textContent = "記録を修正する";
    document.getElementById("btnSubmit").textContent      = "✏️ 修正を保存する";
    document.getElementById("itemName").value    = item.itemName;
    document.getElementById("storeName").value   = item.storeName;
    document.getElementById("storeUrl").value    = item.storeUrl ?? "";
    document.getElementById("regionTag").value   = item.region;
    document.getElementById("itemComment").value = item.comment ?? "";
    document.getElementById("charCount").textContent = `${(item.comment ?? "").length} / 200`;
    // カテゴリ
    const catRadio = document.querySelector(`input[name="category"][value="${item.category}"]`);
    if (catRadio) catRadio.checked = true;
    // 星評価
    const rating = item.rating ?? 3;
    document.getElementById("ratingValue").value = rating;
    setStars(document.querySelectorAll(".star"), rating);
    // 写真
    if (item.photoUrl) showPhotoPreview(item.photoUrl); else hidePhotoPreview();
  } else {
    // 新規モード
    resetForm();
  }
  openModal("postModal", "itemName");
}

const closePostModal   = () => { resetForm(); closeModal("postModal"); };
const closeDetailModal = () => closeModal("detailModal");

function openDetailModal(item) {
  renderDetailBody(item);
  openModal("detailModal");
}

/* ============================================================
   カードレンダリング
   ============================================================ */
function getFilteredItems() {
  let items = [...state.items];
  if (state.filterTag !== "all") {
    items = items.filter(it => it.region === state.filterTag);
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
  if (items.length === 0) {
    empty.hidden = false; countEl.textContent = ""; return;
  }
  empty.hidden = true;
  countEl.textContent = `${items.length} 件`;
  items.forEach(item => grid.appendChild(buildCard(item)));
}

function buildCard(item) {
  const card = document.createElement("li");
  card.className = "item-card";
  card.setAttribute("role", "listitem");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-label", `${item.itemName}（${item.storeName}）`);

  const thumb = document.createElement("div");
  thumb.className = "card-thumb";
  if (item.photoUrl) {
    const img = document.createElement("img");
    img.src = item.photoUrl;
    img.alt = item.itemName;
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.remove();
      const ph = document.createElement("div");
      ph.className   = "card-thumb-placeholder";
      ph.textContent = CATEGORY_EMOJI[item.category] ?? "📦";
      thumb.prepend(ph);
    });
    thumb.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className   = "card-thumb-placeholder";
    ph.textContent = CATEGORY_EMOJI[item.category] ?? "📦";
    thumb.appendChild(ph);
  }
  const stamp = document.createElement("div");
  stamp.className    = "region-stamp"; stamp.dataset.region = item.region;
  stamp.textContent  = item.region.replace("・", "\n");
  stamp.setAttribute("aria-hidden", "true");
  thumb.appendChild(stamp);
  card.appendChild(thumb);

  const body = document.createElement("div");
  body.className = "card-body";
  const cat   = document.createElement("p"); cat.className = "card-category";
  cat.textContent = `${CATEGORY_EMOJI[item.category]??'📦'} ${item.category}`;
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
  for (let i = 1; i <= 5; i++) html += `<span class="${i<=rating?'':'empty'}">★</span>`;
  return html;
}

/* ============================================================
   詳細モーダル
   ============================================================ */
function renderDetailBody(item) {
  const body = document.getElementById("detailBody");
  body.innerHTML = "";

  // ヒーロー
  const hero = document.createElement("div"); hero.className = "detail-hero";
  if (item.photoUrl) {
    const img = document.createElement("img");
    img.src = item.photoUrl; img.alt = item.itemName;
    img.addEventListener("error", () => {
      img.remove();
      const heroPh = document.createElement("div"); heroPh.className = "detail-hero-placeholder";
      heroPh.textContent = CATEGORY_EMOJI[item.category] ?? "📦";
      hero.appendChild(heroPh);
    });
    hero.appendChild(img);
  } else {
    const heroPh = document.createElement("div"); heroPh.className = "detail-hero-placeholder";
    heroPh.textContent = CATEGORY_EMOJI[item.category] ?? "📦";
    hero.appendChild(heroPh);
  }
  body.appendChild(hero);

  // メタ
  const meta    = document.createElement("div"); meta.className = "detail-meta";
  const catEl   = document.createElement("span"); catEl.className = "detail-category";
  catEl.textContent = `${CATEGORY_EMOJI[item.category]??'📦'} ${item.category}`;
  const regionEl = document.createElement("span"); regionEl.className = "detail-region";
  regionEl.textContent = item.region;
  const starsEl = document.createElement("div"); starsEl.className = "detail-stars";
  starsEl.setAttribute("aria-label", `評価 ${item.rating} 点`);
  starsEl.innerHTML = buildStarsHTML(item.rating);
  meta.append(catEl, regionEl, starsEl);
  body.appendChild(meta);

  // 商品名・店舗名
  const nameEl = document.createElement("h3"); nameEl.className = "detail-name";
  nameEl.textContent = item.itemName;
  body.appendChild(nameEl);

  const storeEl = document.createElement("p"); storeEl.className = "detail-store";
  storeEl.textContent = `🏪 ${item.storeName}`;
  body.appendChild(storeEl);

  const posterEl = document.createElement("p"); posterEl.className = "detail-poster";
  posterEl.textContent = `投稿者: ${item.nickname || "不明"}`;
  body.appendChild(posterEl);

  // 店舗リンク
  if (item.storeUrl) {
    const link = document.createElement("a");
    link.className   = "detail-store-link";
    link.href        = item.storeUrl;
    link.target      = "_blank";
    link.rel         = "noopener noreferrer";
    link.textContent = "🔗 お店のページを見る";
    body.appendChild(link);
  }

  // コメント
  if (item.comment) {
    const commentEl = document.createElement("p"); commentEl.className = "detail-comment";
    commentEl.textContent = `"${item.comment}"`;
    body.appendChild(commentEl);
  }

  // 投稿日
  const dateEl = document.createElement("p"); dateEl.className = "detail-date";
  dateEl.textContent = `記録日: ${formatDate(item.createdAt)}`;
  if (state.isOnline) {
    const badge = document.createElement("span"); badge.className = "cloud-badge";
    badge.textContent = "☁️ クラウド同期済み";
    dateEl.appendChild(badge);
  }
  body.appendChild(dateEl);

  // 自分の投稿かどうか（ログイン中のuserIdと一致するかで判定）
  const canEdit = Auth.isLoggedIn() && item.userId === Auth.getUserId();

  if (canEdit) {
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
        console.error("削除エラー:", err);
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

/* ============================================================
   ユーティリティ
   ============================================================ */
function formatDate(isoStr) {
  try {
    return new Date(isoStr).toLocaleDateString("ja-JP", {
      year: "numeric", month: "long", day: "numeric"
    });
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
window.showToast = showToast; // auth.jsからも共通利用

/* ============================================================
   起動
   ============================================================ */
document.addEventListener("DOMContentLoaded", init);
