/**
 * app.js — ご当地スーパー・銘菓発掘図鑑
 * ──────────────────────────────────────────────────────────────
 * セキュリティ方針:
 *   - FIREBASE_ENABLED=true  → Firestore + 匿名認証（写真なし版）
 *   - FIREBASE_ENABLED=false → LocalStorage フォールバック（設定不要）
 *   - XSS対策: createElement + textContent ベースのDOM構築
 *   - 投稿者UID照合により自分の投稿のみ削除可能
 * ──────────────────────────────────────────────────────────────
 */

"use strict";

/* ============================================================
   定数
   ============================================================ */
const STORAGE_KEY = "gotouchi_items_v1";

const CATEGORY_EMOJI = {
  "惣菜": "🍱", "銘菓": "🍡", "珍味": "🐟", "飲み物": "🧃", "その他": "📦"
};

/* ============================================================
   アプリ状態
   ============================================================ */
let state = {
  items:       [],
  filterTag:   "all",
  searchQuery: "",
  sortOrder:   "newest",
  currentUid:  null,
  useFirebase: false,
  isLoading:   true,
};

/* ============================================================
   Firebase サービス（動的インポート）
   ============================================================ */
let fbService = null;

async function loadFirebaseService() {
  if (!FIREBASE_ENABLED) return false;
  try {
    fbService = await import("./firebase-service.js");
    state.currentUid = await fbService.initFirebase();
    state.useFirebase = true;
    return true;
  } catch (err) {
    console.warn("Firebase初期化失敗 → LocalStorageにフォールバック:", err);
    showToast("⚠️ Firebase接続失敗。ローカル保存モードで動作します");
    return false;
  }
}

/* ============================================================
   LocalStorage ヘルパー（フォールバック用）
   ============================================================ */
function lsLoad() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function lsSave(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch (e) {
    console.warn("LocalStorage 保存失敗:", e);
    showToast("⚠️ 保存領域が不足しています");
  }
}

/* ============================================================
   初期化
   ============================================================ */
async function init() {
  setLoadingUI(true);
  bindEvents();

  const firebaseOk = await loadFirebaseService();

  if (firebaseOk) {
    // Firestoreをリアルタイム購読（初回コールバックでローディングを解除）
    let firstLoad = true;
    fbService.subscribeItems((items) => {
      state.items     = items;
      state.isLoading = false;
      if (firstLoad) {
        firstLoad = false;
        setLoadingUI(false);
      }
      renderCards();
    });
    updateAuthBadge();
  } else {
    // LocalStorageから読み込み
    const stored = lsLoad();
    state.items    = stored ?? [...SAMPLE_ITEMS];
    state.isLoading = false;
    setLoadingUI(false);
    renderCards();
  }
}

/* ============================================================
   ローディングUI
   ============================================================ */
function setLoadingUI(loading) {
  const grid  = document.getElementById("cardGrid");
  const indicator = document.getElementById("loadingIndicator");
  if (loading) {
    indicator.hidden = false;
    grid.hidden      = true;
  } else {
    indicator.hidden = true;
    grid.hidden      = false;
  }
}

function updateAuthBadge() {
  const badge = document.getElementById("authBadge");
  if (!badge) return;
  if (state.useFirebase && state.currentUid) {
    badge.hidden = false;
    badge.title  = `UID: ${state.currentUid}`;
  }
}

/* ============================================================
   イベントバインド
   ============================================================ */
function bindEvents() {
  document.getElementById("btnOpenPost").addEventListener("click", openPostModal);
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
    state.searchQuery = e.target.value.trim();
    renderCards();
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
    state.sortOrder = e.target.value;
    renderCards();
  });


  initStarRating();

  document.getElementById("itemComment").addEventListener("input", (e) => {
    document.getElementById("charCount").textContent = `${e.target.value.length} / 200`;
  });

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
   フォーム送信
   ============================================================ */
async function handleFormSubmit(e) {
  e.preventDefault();
  if (!validateForm()) return;

  const submitBtn = document.getElementById("btnSubmit");
  submitBtn.disabled   = true;
  submitBtn.textContent = "⏳ 保存中...";

  const itemData = {
    itemName:  sanitize(document.getElementById("itemName").value.trim()),
    storeName: sanitize(document.getElementById("storeName").value.trim()),
    region:    sanitize(document.getElementById("regionTag").value),
    category:  sanitize(document.querySelector('input[name="category"]:checked')?.value ?? "その他"),
    rating:    parseInt(document.getElementById("ratingValue").value, 10) || 3,
    comment:   sanitize(document.getElementById("itemComment").value.trim()),
  };

  try {
    if (state.useFirebase) {
      // ── Firebaseモード ──────────────────────────────
      await fbService.addItem(itemData);
      // subscribeItemsのコールバックで自動的にrenderCardsが呼ばれる
    } else {
      // ── LocalStorageモード ──────────────────────────
      const newItem = {
        id:           crypto.randomUUID(),
        ...itemData,
        createdAt:    new Date().toISOString()
      };
      state.items.unshift(newItem);
      lsSave(state.items);
      renderCards();
    }

    closePostModal();
    resetForm();
    showToast("📌 図鑑に登録しました！");
  } catch (err) {
    console.error("保存エラー:", err);
    showToast("❌ 保存に失敗しました。もう一度お試しください");
  } finally {
    submitBtn.disabled    = false;
    submitBtn.textContent = "📌 図鑑に登録する";
  }
}

/* ============================================================
   XSSサニタイズ / デサニタイズ
   ============================================================ */
function sanitize(str) {
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#x27;");
}
function desanitize(str) {
  return String(str)
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#x27;/g,"'");
}

function resetForm() {
  document.getElementById("postForm").reset();
  document.getElementById("charCount").textContent = "0 / 200";
  document.getElementById("ratingValue").value     = 3;
  setStars(document.querySelectorAll(".star"), 3);
  ["itemName","storeName","regionTag"].forEach(id => document.getElementById(id).classList.remove("is-error"));
  ["itemNameError","storeNameError","regionTagError"].forEach(id => document.getElementById(id).textContent = "");
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
const openPostModal   = () => openModal("postModal", "itemName");
const closePostModal  = () => closeModal("postModal");
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
      desanitize(it.itemName).toLowerCase().includes(q) ||
      desanitize(it.storeName).toLowerCase().includes(q) ||
      it.region.toLowerCase().includes(q)
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
  card.setAttribute("aria-label", `${desanitize(item.itemName)}（${desanitize(item.storeName)}）`);

  const thumb = document.createElement("div");
  thumb.className = "card-thumb";
  const ph = document.createElement("div");
  ph.className = "card-thumb-placeholder";
  ph.textContent = CATEGORY_EMOJI[item.category] ?? "📦";
  thumb.appendChild(ph);
  const stamp = document.createElement("div");
  stamp.className = "region-stamp"; stamp.dataset.region = item.region;
  stamp.textContent = item.region.replace("・", "\n");
  stamp.setAttribute("aria-hidden", "true");
  thumb.appendChild(stamp);
  card.appendChild(thumb);

  const body = document.createElement("div");
  body.className = "card-body";
  const cat  = document.createElement("p");
  cat.className = "card-category";
  cat.textContent = `${CATEGORY_EMOJI[item.category]??'📦'} ${item.category}`;
  const name = document.createElement("h3");
  name.className = "card-name"; name.textContent = desanitize(item.itemName);
  const store = document.createElement("p");
  store.className = "card-store"; store.textContent = `🏪 ${desanitize(item.storeName)}`;
  const stars = document.createElement("div");
  stars.className = "card-stars";
  stars.setAttribute("aria-label", `評価 ${item.rating} 点`);
  stars.innerHTML = buildStarsHTML(item.rating);
  body.append(cat, name, store, stars);
  card.appendChild(body);

  // Firebaseモードでは同期アイコンを表示
  if (state.useFirebase) {
    const syncDot = document.createElement("div");
    syncDot.className = "sync-dot";
    syncDot.title     = "クラウド同期済み";
    syncDot.setAttribute("aria-hidden", "true");
    card.appendChild(syncDot);
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
async function renderDetailBody(item) {
  const body     = document.getElementById("detailBody");
  body.innerHTML = "";

  // ヒーロー
  const hero = document.createElement("div");
  hero.className = "detail-hero";
  const heroPh = document.createElement("div");
  heroPh.className = "detail-hero-placeholder"; heroPh.textContent = CATEGORY_EMOJI[item.category] ?? "📦";
  hero.appendChild(heroPh);
  body.appendChild(hero);

  // メタ
  const meta = document.createElement("div"); meta.className = "detail-meta";
  const catEl = document.createElement("span"); catEl.className = "detail-category";
  catEl.textContent = `${CATEGORY_EMOJI[item.category]??'📦'} ${item.category}`;
  const regionEl = document.createElement("span"); regionEl.className = "detail-region";
  regionEl.textContent = item.region;
  const starsEl = document.createElement("div"); starsEl.className = "detail-stars";
  starsEl.setAttribute("aria-label", `評価 ${item.rating} 点`);
  starsEl.innerHTML = buildStarsHTML(item.rating);
  meta.append(catEl, regionEl, starsEl);
  body.appendChild(meta);

  const nameEl = document.createElement("h3"); nameEl.className = "detail-name";
  nameEl.textContent = desanitize(item.itemName);
  body.appendChild(nameEl);

  const storeEl = document.createElement("p"); storeEl.className = "detail-store";
  storeEl.textContent = `🏪 ${desanitize(item.storeName)}`;
  body.appendChild(storeEl);

  if (item.comment) {
    const commentEl = document.createElement("p"); commentEl.className = "detail-comment";
    commentEl.textContent = `"${desanitize(item.comment)}"`;
    body.appendChild(commentEl);
  }

  const dateEl = document.createElement("p"); dateEl.className = "detail-date";
  dateEl.textContent = `記録日: ${formatDate(item.createdAt)}`;

  // Firebase同期情報バッジ
  if (state.useFirebase) {
    const badge = document.createElement("span"); badge.className = "cloud-badge";
    badge.textContent = "☁️ クラウド同期済み";
    dateEl.appendChild(badge);
  }
  body.appendChild(dateEl);

  // 削除ボタン（自分の投稿か、LocalStorageモードのみ表示）
  const canDelete = state.useFirebase
    ? (item.uid === state.currentUid)
    : true;

  if (canDelete) {
    const delBtn = document.createElement("button"); delBtn.className = "btn-delete";
    delBtn.textContent = "🗑 この記録を削除";
    delBtn.addEventListener("click", async () => {
      if (!confirm(`「${desanitize(item.itemName)}」を削除しますか？`)) return;
      delBtn.disabled = true; delBtn.textContent = "⏳ 削除中...";
      try {
        if (state.useFirebase) {
          await fbService.deleteItem(item.id);
          // subscribeItemsのコールバックで自動的に反映される
        } else {
          state.items = state.items.filter(it => it.id !== item.id);
          lsSave(state.items);
          renderCards();
        }
        closeDetailModal();
        showToast("🗑 削除しました");
      } catch (err) {
        console.error("削除エラー:", err);
        showToast("❌ 削除に失敗しました");
        delBtn.disabled = false; delBtn.textContent = "🗑 この記録を削除";
      }
    });
    body.appendChild(delBtn);
  } else {
    const noteEl = document.createElement("p"); noteEl.className = "detail-date";
    noteEl.style.marginTop = "16px";
    noteEl.textContent = "※ 他のユーザーの投稿は削除できません";
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

/* ============================================================
   起動
   ============================================================ */
document.addEventListener("DOMContentLoaded", init);