/**
 * Code.gs — ご当地スーパー・銘菓発掘図鑑 バックエンド
 * ──────────────────────────────────────────────────────────────
 * バージョン: API_VERSION（下の定数）
 * 構成: GitHub Pages(フロント) + GAS(API) + Googleスプレッドシート(DB)
 *      + Googleドライブ(写真保存) + Gemini API(説明文自動生成・読み上げ音声)
 *
 * v2.0.0 の追加点
 *   - 利用規約（注意書き・免責事項・自己責任・当事者間解決）への同意を会員登録の条件に
 *     既存会員は次回ログイン時に同意を求める（termsVersion で管理）
 *   - 公開範囲を3段階に: private(非公開・既定) / members(指定した会員だけ) / public(全体公開)
 *   - 共有相手（家族・友人）を「共有コード」で登録・削除・一覧管理（contacts シート）
 *   - 投稿ごとに共有相手をオン/オフ（setSharing）、相手単位で一括停止（stopSharingWith）
 *   - 読み上げ（Gemini TTS）: 本文だけを音声化し、「〜で読み上げてください」等の指示文は送らない
 *
 * 【事前準備（初回のみ）】
 *   1. スプレッドシートの「拡張機能 → Apps Script」にこの Code.gs を貼り付け
 *      items / members / contacts シートと不足列は初回アクセス時に自動追加されます（既存データはそのまま）
 *   2. 「プロジェクトの設定」→「スクリプト プロパティ」:
 *        GEMINI_API_KEY    : Gemini APIキー
 *        DRIVE_FOLDER_ID   : 写真保存フォルダID
 *        PASSWORD_PEPPER   : 任意の長いランダム文字列
 *        GEMINI_TTS_MODEL  : （任意）読み上げ用モデル名。未設定時は既定値を使用
 *        GEMINI_TTS_VOICE  : （任意）声の名前。未設定時は "Kore"
 *   3. コードを変更したら「デプロイを管理」→ 編集（鉛筆）→ バージョン「新バージョン」→ デプロイ
 *      ※ 新しいバージョンを作らないと変更は反映されません（URLは変わりません）
 * ──────────────────────────────────────────────────────────────
 */

const API_VERSION    = "2.0.0";
const TERMS_VERSION  = "2026-11-04";

const ITEMS_SHEET_NAME    = "items";
const MEMBERS_SHEET_NAME  = "members";
const CONTACTS_SHEET_NAME = "contacts";

const ITEMS_HEADER = [
  "id","itemName","storeName","region","category","rating","comment",
  "storeUrl","photoUrl","userId","createdAt","updatedAt","visibility","sharedWith"
];
const MEMBERS_HEADER = [
  "userId","email","nickname","passwordHash","salt","isTempPassword",
  "failedAttempts","lockUntil","sessionToken","createdAt","updatedAt",
  "shareCode","agreedAt","termsVersion"
];
const CONTACTS_HEADER = ["ownerId","contactUserId","createdAt"];

const REGIONS     = ["北海道・東北","関東","中部・東海","近畿","中国・四国","九州・沖縄"];
const CATEGORIES  = ["惣菜","銘菓","珍味","飲み物","その他","レストラン","居酒屋","バー"];
const VISIBILITIES = ["private","members","public"];

const MAX_LOGIN_FAILS = 5;
const LOCK_MINUTES    = 15;
const MAX_CONTACTS    = 50;
const TEMP_PW_CHARS   = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // 紛らわしい文字を除外
const SHARE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";

/* ============================================================
   エントリーポイント
   ============================================================ */
function doPost(e) {
  const out = (obj) =>
    ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.TEXT); // text/plain応答でCORSプリフライト回避

  try {
    const req    = JSON.parse(e.postData.contents);
    const action = req.action;
    const p      = req.payload || {};

    switch (action) {
      case "version":             return out({ ok: true, version: API_VERSION, termsVersion: TERMS_VERSION });

      case "list":                return out(handleList(p));
      case "create":              return out(withLock(() => handleCreate(p)));
      case "update":              return out(withLock(() => handleUpdate(p)));
      case "delete":              return out(withLock(() => handleDelete(p)));
      case "setSharing":          return out(withLock(() => handleSetSharing(p)));
      case "setVisibility":       return out(withLock(() => handleSetSharing(p))); // 旧フロント互換
      case "generateDescription": return out(handleGenerateDescription(p));
      case "tts":                 return out(handleTts(p));

      case "register":            return out(withLock(() => handleRegister(p)));
      case "agreeTerms":          return out(handleAgreeTerms(p));
      case "login":               return out(handleLogin(p));
      case "getSession":          return out(handleGetSession(p));
      case "changePassword":      return out(handleChangePassword(p));
      case "forgotPassword":      return out(handleForgotPassword(p));
      case "changeNickname":      return out(handleChangeNickname(p));
      case "logout":              return out(handleLogout(p));

      case "listContacts":        return out(handleListContacts(p));
      case "addContact":          return out(withLock(() => handleAddContact(p)));
      case "removeContact":       return out(withLock(() => handleRemoveContact(p)));
      case "stopSharingWith":     return out(withLock(() => handleStopSharingWith(p)));

      default:
        return out({ ok: false, error: "unknown action: " + action });
    }
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function doGet() {
  return ContentService.createTextOutput("ご当地スーパー・銘菓発掘図鑑 API v" + API_VERSION + " is running.");
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ============================================================
   シート取得（不足列は末尾に自動追加。既存データは壊さない）
   ============================================================ */
function getSheetWithHeader(name, required) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, required.length).setValues([required]);
    return sheet;
  }
  const lastCol = sheet.getLastColumn();
  const header = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const missing = required.filter(h => header.indexOf(h) === -1);
  if (missing.length) {
    sheet.getRange(1, header.length + 1, 1, missing.length).setValues([missing]);
  }
  return sheet;
}
function getItemsSheet()    { return getSheetWithHeader(ITEMS_SHEET_NAME, ITEMS_HEADER); }
function getMembersSheet()  { return getSheetWithHeader(MEMBERS_SHEET_NAME, MEMBERS_HEADER); }
function getContactsSheet() { return getSheetWithHeader(CONTACTS_SHEET_NAME, CONTACTS_HEADER); }

function rowsToObjects(values) {
  const header = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    header.forEach((key, i) => { obj[key] = row[i]; });
    return obj;
  });
}

/** ヘッダー順に並べた1行を作成して追加 */
function appendObject(sheet, obj) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  sheet.appendRow(header.map(h => (obj[h] === undefined || obj[h] === null) ? "" : obj[h]));
}

/* ============================================================
   会員: ハッシュ / 一時パスワード / 共有コード
   ============================================================ */
function hashPassword(password, salt) {
  const pepper = PropertiesService.getScriptProperties().getProperty("PASSWORD_PEPPER") || "";
  const raw    = String(password) + String(salt) + pepper;
  const bytes  = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return bytes.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0")).join("");
}

function randomString(chars, len) {
  let s = "";
  for (let i = 0; i < len; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
function generateTempPassword() { return randomString(TEMP_PW_CHARS, 8); }

function normalizeShareCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function generateUniqueShareCode(sheet) {
  const values = sheet.getDataRange().getValues();
  const col = values[0].indexOf("shareCode");
  const used = {};
  for (let r = 1; r < values.length; r++) used[String(values[r][col])] = true;
  let code;
  do { code = randomString(SHARE_CODE_CHARS, 8); } while (used[code]);
  return code;
}

/** 共有コード未発行の会員（旧会員）には発行して返す */
function ensureShareCode(sheet, found) {
  if (found.data.shareCode) return String(found.data.shareCode);
  const code = generateUniqueShareCode(sheet);
  setMemberCell(sheet, found.header, found.rowNum, "shareCode", code);
  return code;
}

function needsTerms(member) {
  return String(member.termsVersion || "") !== TERMS_VERSION;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

/* ============================================================
   会員: 検索
   ============================================================ */
function findMemberRow(sheet, predicate) {
  const values = sheet.getDataRange().getValues();
  const header = values[0];
  for (let r = 1; r < values.length; r++) {
    const obj = {};
    header.forEach((key, i) => { obj[key] = values[r][i]; });
    if (predicate(obj)) return { rowNum: r + 1, header, data: obj };
  }
  return null;
}
function findMemberByEmail(sheet, email) {
  const target = String(email).trim().toLowerCase();
  return findMemberRow(sheet, m => String(m.email).trim().toLowerCase() === target);
}
function findMemberBySession(sheet, sessionToken) {
  if (!sessionToken) return null;
  return findMemberRow(sheet, m => m.sessionToken && m.sessionToken === sessionToken);
}
function setMemberCell(sheet, header, rowNum, colName, value) {
  sheet.getRange(rowNum, header.indexOf(colName) + 1).setValue(value);
}
function nicknameMap() {
  const values = getMembersSheet().getDataRange().getValues();
  const map = {};
  if (values.length > 1) {
    const h = values[0];
    const u = h.indexOf("userId"), n = h.indexOf("nickname");
    values.slice(1).forEach(row => { map[row[u]] = row[n]; });
  }
  return map;
}

/** 本人確認（セッション必須の処理で共通利用） */
function requireMember(payload) {
  const sheet = getMembersSheet();
  const found = findMemberBySession(sheet, payload.sessionToken);
  return found ? { sheet, found } : null;
}

/* ============================================================
   会員登録（規約同意必須）
   ============================================================ */
function handleRegister(payload) {
  const email    = String(payload.email || "").trim();
  const nickname = String(payload.nickname || "").trim();

  if (payload.agreeTerms !== true) {
    return { ok: false, error: "注意書き・免責事項などすべての項目への同意が必要です" };
  }
  if (!isValidEmail(email)) return { ok: false, error: "メールアドレスの形式が正しくありません" };
  if (nickname.length < 1 || nickname.length > 20) return { ok: false, error: "ニックネームは1〜20文字で入力してください" };

  const sheet = getMembersSheet();
  if (findMemberByEmail(sheet, email)) {
    return { ok: false, error: "このメールアドレスは既に登録されています" };
  }

  const tempPassword = generateTempPassword();
  const salt = Utilities.getUuid();
  const now  = new Date().toISOString();

  appendObject(sheet, {
    userId: Utilities.getUuid(), email, nickname,
    passwordHash: hashPassword(tempPassword, salt), salt,
    isTempPassword: true, failedAttempts: 0, lockUntil: "", sessionToken: "",
    createdAt: now, updatedAt: now,
    shareCode: generateUniqueShareCode(sheet),
    agreedAt: now, termsVersion: TERMS_VERSION
  });

  try {
    MailApp.sendEmail({
      to: email,
      subject: "【ご当地スーパー・銘菓発掘図鑑】仮パスワードのお知らせ",
      body:
        `${nickname} 様\n\n` +
        `ご登録ありがとうございます。以下の仮パスワードでログインし、\n` +
        `初回ログイン時に新しいパスワードへの変更をお願いします。\n\n` +
        `仮パスワード: ${tempPassword}\n\n` +
        `※このメールに心当たりがない場合は破棄してください。`
    });
  } catch (e) {
    return { ok: false, error: "登録は完了しましたが、メール送信に失敗しました。時間を置いて「パスワードをお忘れの場合」から再発行してください" };
  }
  return { ok: true };
}

/* ============================================================
   既存会員の規約同意
   ============================================================ */
function handleAgreeTerms(payload) {
  if (payload.agreeTerms !== true) return { ok: false, error: "すべての項目への同意が必要です" };
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインし直してください" };
  const now = new Date().toISOString();
  setMemberCell(m.sheet, m.found.header, m.found.rowNum, "agreedAt", now);
  setMemberCell(m.sheet, m.found.header, m.found.rowNum, "termsVersion", TERMS_VERSION);
  return { ok: true };
}

/* ============================================================
   ログイン
   ============================================================ */
function handleLogin(payload) {
  const email    = String(payload.email || "").trim();
  const password = String(payload.password || "");

  const sheet = getMembersSheet();
  const found = findMemberByEmail(sheet, email);
  if (!found) return { ok: false, error: "メールアドレスまたはパスワードが正しくありません" };

  const { rowNum, header, data } = found;

  if (data.lockUntil && new Date(data.lockUntil) > new Date()) {
    const minutes = Math.ceil((new Date(data.lockUntil) - new Date()) / 60000);
    return { ok: false, error: `ログイン試行回数が上限に達しました。${minutes}分後に再度お試しください` };
  }

  if (hashPassword(password, data.salt) !== data.passwordHash) {
    const fails = Number(data.failedAttempts || 0) + 1;
    if (fails >= MAX_LOGIN_FAILS) {
      setMemberCell(sheet, header, rowNum, "failedAttempts", 0);
      setMemberCell(sheet, header, rowNum, "lockUntil", new Date(Date.now() + LOCK_MINUTES * 60000).toISOString());
      return { ok: false, error: `ログインに${MAX_LOGIN_FAILS}回失敗したため、${LOCK_MINUTES}分間ロックされました` };
    }
    setMemberCell(sheet, header, rowNum, "failedAttempts", fails);
    return { ok: false, error: "メールアドレスまたはパスワードが正しくありません" };
  }

  const sessionToken = Utilities.getUuid();
  setMemberCell(sheet, header, rowNum, "failedAttempts", 0);
  setMemberCell(sheet, header, rowNum, "lockUntil", "");
  setMemberCell(sheet, header, rowNum, "sessionToken", sessionToken);
  setMemberCell(sheet, header, rowNum, "updatedAt", new Date().toISOString());

  return {
    ok: true,
    sessionToken,
    userId: data.userId,
    nickname: data.nickname,
    isTempPassword: !!data.isTempPassword,
    shareCode: ensureShareCode(sheet, found),
    needsTerms: needsTerms(data)
  };
}

/* ============================================================
   セッション確認
   ============================================================ */
function handleGetSession(payload) {
  const sheet = getMembersSheet();
  const found = findMemberBySession(sheet, payload.sessionToken);
  if (!found) return { ok: false };
  return {
    ok: true,
    userId: found.data.userId,
    nickname: found.data.nickname,
    isTempPassword: !!found.data.isTempPassword,
    shareCode: ensureShareCode(sheet, found),
    needsTerms: needsTerms(found.data)
  };
}

/* ============================================================
   パスワード変更
   ============================================================ */
function handleChangePassword(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインし直してください" };
  const { sheet } = m;
  const { rowNum, header, data } = m.found;

  if (hashPassword(String(payload.currentPassword || ""), data.salt) !== data.passwordHash) {
    return { ok: false, error: "現在のパスワードが正しくありません" };
  }
  const newPassword = String(payload.newPassword || "");
  if (newPassword.length < 8) return { ok: false, error: "新しいパスワードは8文字以上で設定してください" };

  const newSalt = Utilities.getUuid();
  setMemberCell(sheet, header, rowNum, "passwordHash", hashPassword(newPassword, newSalt));
  setMemberCell(sheet, header, rowNum, "salt", newSalt);
  setMemberCell(sheet, header, rowNum, "isTempPassword", false);
  setMemberCell(sheet, header, rowNum, "updatedAt", new Date().toISOString());
  return { ok: true };
}

/* ============================================================
   パスワード再発行
   ============================================================ */
function handleForgotPassword(payload) {
  const email = String(payload.email || "").trim();
  if (!isValidEmail(email)) return { ok: false, error: "メールアドレスの形式が正しくありません" };

  const sheet = getMembersSheet();
  const found = findMemberByEmail(sheet, email);
  const genericResult = { ok: true, message: "このメールアドレスが登録されていれば、仮パスワードを送信しました" };
  if (!found) return genericResult;

  const { rowNum, header, data } = found;
  const tempPassword = generateTempPassword();
  const newSalt = Utilities.getUuid();

  setMemberCell(sheet, header, rowNum, "passwordHash", hashPassword(tempPassword, newSalt));
  setMemberCell(sheet, header, rowNum, "salt", newSalt);
  setMemberCell(sheet, header, rowNum, "isTempPassword", true);
  setMemberCell(sheet, header, rowNum, "sessionToken", "");
  setMemberCell(sheet, header, rowNum, "failedAttempts", 0);
  setMemberCell(sheet, header, rowNum, "lockUntil", "");
  setMemberCell(sheet, header, rowNum, "updatedAt", new Date().toISOString());

  try {
    MailApp.sendEmail({
      to: email,
      subject: "【ご当地スーパー・銘菓発掘図鑑】仮パスワードの再発行",
      body:
        `${data.nickname} 様\n\n` +
        `パスワード再発行のリクエストを受け付けました。\n` +
        `以下の仮パスワードでログインし、新しいパスワードに変更してください。\n\n` +
        `仮パスワード: ${tempPassword}\n\n` +
        `※心当たりがない場合はこのメールを破棄してください。`
    });
  } catch (e) { /* 送信失敗時も同じ応答 */ }

  return genericResult;
}

/* ============================================================
   ニックネーム変更 / ログアウト
   ============================================================ */
function handleChangeNickname(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインし直してください" };
  const nickname = String(payload.nickname || "").trim();
  if (nickname.length < 1 || nickname.length > 20) return { ok: false, error: "ニックネームは1〜20文字で入力してください" };
  setMemberCell(m.sheet, m.found.header, m.found.rowNum, "nickname", nickname);
  setMemberCell(m.sheet, m.found.header, m.found.rowNum, "updatedAt", new Date().toISOString());
  return { ok: true, nickname };
}

function handleLogout(payload) {
  const sheet = getMembersSheet();
  const found = findMemberBySession(sheet, payload.sessionToken);
  if (found) setMemberCell(sheet, found.header, found.rowNum, "sessionToken", "");
  return { ok: true };
}

/* ============================================================
   公開範囲ユーティリティ
   ============================================================ */
/** 列追加前の旧データ（空欄）は従来どおり「公開」扱い */
function normVisibility(v) {
  const s = String(v || "").trim();
  if (s === "") return "public";
  return VISIBILITIES.indexOf(s) === -1 ? "private" : s;
}
function parseShared(v) {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a.map(String) : []; } catch (e) { return []; }
}
function getMyContactIds(ownerId) {
  const values = getContactsSheet().getDataRange().getValues();
  const h = values[0];
  const o = h.indexOf("ownerId"), c = h.indexOf("contactUserId");
  const ids = [];
  for (let r = 1; r < values.length; r++) {
    if (values[r][o] === ownerId) ids.push(String(values[r][c]));
  }
  return ids;
}
/** 自分の共有相手に含まれるIDだけに絞る（他人を勝手に指定させない） */
function sanitizeSharedWith(list, ownerId) {
  if (!Array.isArray(list)) return [];
  const allowed = getMyContactIds(ownerId);
  const seen = {};
  return list.map(String).filter(id => {
    if (allowed.indexOf(id) === -1 || seen[id]) return false;
    seen[id] = true; return true;
  });
}

/* ============================================================
   投稿一覧（閲覧権限でフィルター）
   ============================================================ */
function handleList(payload) {
  const itemsValues = getItemsSheet().getDataRange().getValues();
  if (itemsValues.length < 2) return { ok: true, items: [] };

  const viewer = payload && payload.sessionToken
    ? findMemberBySession(getMembersSheet(), payload.sessionToken) : null;
  const viewerId = viewer ? viewer.data.userId : null;
  const nick = nicknameMap();

  const items = [];
  rowsToObjects(itemsValues).forEach(it => {
    if (!it.id) return;
    const vis    = normVisibility(it.visibility);
    const shared = parseShared(it.sharedWith);
    const isOwner = viewerId && it.userId === viewerId;
    const sharedToMe = !!viewerId && !isOwner && vis === "members" && shared.indexOf(viewerId) !== -1;

    if (!(vis === "public" || isOwner || sharedToMe)) return;

    const out = {
      id: it.id, itemName: it.itemName, storeName: it.storeName, region: it.region,
      category: it.category, rating: it.rating, comment: it.comment, storeUrl: it.storeUrl,
      photoUrl: it.photoUrl, userId: it.userId, createdAt: it.createdAt, updatedAt: it.updatedAt,
      visibility: vis, nickname: nick[it.userId] || "退会したユーザー",
      sharedToMe
    };
    if (isOwner) out.sharedWith = shared; // 共有先の一覧は本人にだけ返す
    items.push(out);
  });
  return { ok: true, items };
}

/* ============================================================
   投稿の検証
   ============================================================ */
function validateItem(payload) {
  if (!payload.itemName || String(payload.itemName).trim().length < 1 || String(payload.itemName).length > 60)
    return "商品名は1〜60文字で入力してください";
  if (!payload.storeName || String(payload.storeName).trim().length < 1 || String(payload.storeName).length > 60)
    return "店舗名は1〜60文字で入力してください";
  if (REGIONS.indexOf(payload.region) === -1) return "地域を正しく選択してください";
  if (CATEGORIES.indexOf(payload.category) === -1) return "カテゴリを正しく選択してください";
  const rating = Number(payload.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return "評価は1〜5で指定してください";
  if (payload.comment && String(payload.comment).length > 210) return "レビューは210文字以内で入力してください";
  if (payload.storeUrl && String(payload.storeUrl).length > 510) return "URLが長すぎます";
  if (payload.visibility && VISIBILITIES.indexOf(payload.visibility) === -1) return "公開設定が正しくありません";
  return null;
}

/* ============================================================
   作成・更新・削除
   ============================================================ */
function handleCreate(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインが必要です" };
  const err = validateItem(payload);
  if (err) return { ok: false, error: err };

  let photoUrl = "";
  if (payload.photoBase64) {
    try { photoUrl = savePhotoToDrive(payload.photoBase64, payload.photoMimeType); }
    catch (e) { return { ok: false, error: "写真の保存に失敗しました: " + e }; }
  }

  const userId = m.found.data.userId;
  const visibility = payload.visibility || "private"; // 既定は非公開
  const sharedWith = visibility === "members" ? sanitizeSharedWith(payload.sharedWith, userId) : [];
  const id  = Utilities.getUuid();
  const now = new Date().toISOString();

  appendObject(getItemsSheet(), {
    id, itemName: payload.itemName, storeName: payload.storeName, region: payload.region,
    category: payload.category, rating: Number(payload.rating), comment: payload.comment || "",
    storeUrl: payload.storeUrl || "", photoUrl, userId, createdAt: now, updatedAt: now,
    visibility, sharedWith: JSON.stringify(sharedWith)
  });
  return { ok: true, id, photoUrl, createdAt: now };
}

/** 自分の投稿の行を探す */
function findOwnItem(id, userId) {
  const sheet  = getItemsSheet();
  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idCol = header.indexOf("id"), uidCol = header.indexOf("userId");
  for (let r = 1; r < values.length; r++) {
    if (values[r][idCol] !== id) continue;
    if (values[r][uidCol] !== userId) return { error: "この記録を変更する権限がありません" };
    const obj = {}; header.forEach((k, i) => { obj[k] = values[r][i]; });
    return {
      sheet, header, rowNum: r + 1, data: obj,
      set: (col, val) => sheet.getRange(r + 1, header.indexOf(col) + 1).setValue(val)
    };
  }
  return { error: "対象の記録が見つかりません" };
}

function handleUpdate(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインが必要です" };
  if (!payload.id) return { ok: false, error: "idが必要です" };
  const err = validateItem(payload);
  if (err) return { ok: false, error: err };

  const userId = m.found.data.userId;
  const row = findOwnItem(payload.id, userId);
  if (row.error) return { ok: false, error: row.error };

  let photoUrl = row.data.photoUrl;
  if (payload.photoBase64) {
    try {
      if (photoUrl) deletePhotoFromDrive(photoUrl);
      photoUrl = savePhotoToDrive(payload.photoBase64, payload.photoMimeType);
    } catch (e) { return { ok: false, error: "写真の保存に失敗しました: " + e }; }
  } else if (payload.removePhoto) {
    if (photoUrl) { try { deletePhotoFromDrive(photoUrl); } catch (e) {} }
    photoUrl = "";
  }

  const visibility = payload.visibility || normVisibility(row.data.visibility);
  const sharedWith = visibility === "members"
    ? sanitizeSharedWith(payload.sharedWith !== undefined ? payload.sharedWith : parseShared(row.data.sharedWith), userId)
    : parseShared(row.data.sharedWith); // 非公開/全体公開に変えても選択は記憶しておく

  const now = new Date().toISOString();
  row.set("itemName",  payload.itemName);
  row.set("storeName", payload.storeName);
  row.set("region",    payload.region);
  row.set("category",  payload.category);
  row.set("rating",    Number(payload.rating));
  row.set("comment",   payload.comment || "");
  row.set("storeUrl",  payload.storeUrl || "");
  row.set("photoUrl",  photoUrl);
  row.set("visibility", visibility);
  row.set("sharedWith", JSON.stringify(sharedWith));
  row.set("updatedAt", now);
  return { ok: true, photoUrl, updatedAt: now };
}

function handleDelete(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインが必要です" };
  if (!payload.id) return { ok: false, error: "idが必要です" };
  const row = findOwnItem(payload.id, m.found.data.userId);
  if (row.error) return { ok: false, error: row.error };
  const photoUrl = row.data.photoUrl;
  row.sheet.deleteRow(row.rowNum);
  if (photoUrl) { try { deletePhotoFromDrive(photoUrl); } catch (e) {} }
  return { ok: true };
}

/* ============================================================
   公開範囲の変更（一覧からのワンタップ操作用）
   payload: { id, visibility?, sharedWith? }
   ============================================================ */
function handleSetSharing(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインが必要です" };
  if (!payload.id) return { ok: false, error: "idが必要です" };
  const userId = m.found.data.userId;
  const row = findOwnItem(payload.id, userId);
  if (row.error) return { ok: false, error: row.error };

  const visibility = payload.visibility || normVisibility(row.data.visibility);
  if (VISIBILITIES.indexOf(visibility) === -1) return { ok: false, error: "公開設定が正しくありません" };
  const sharedWith = payload.sharedWith !== undefined
    ? sanitizeSharedWith(payload.sharedWith, userId)
    : parseShared(row.data.sharedWith);

  row.set("visibility", visibility);
  row.set("sharedWith", JSON.stringify(sharedWith));
  row.set("updatedAt", new Date().toISOString());
  return { ok: true, visibility, sharedWith };
}

/* ============================================================
   共有相手（家族・友人）
   ============================================================ */
function handleListContacts(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインが必要です" };
  const me = m.found.data.userId;
  const nick = nicknameMap();

  const values = getContactsSheet().getDataRange().getValues();
  const h = values[0];
  const o = h.indexOf("ownerId"), c = h.indexOf("contactUserId"), t = h.indexOf("createdAt");
  const contacts = [];
  const addedMe = [];
  for (let r = 1; r < values.length; r++) {
    if (values[r][o] === me && nick[values[r][c]] !== undefined) {
      contacts.push({ userId: values[r][c], nickname: nick[values[r][c]], createdAt: values[r][t] });
    }
    if (values[r][c] === me && nick[values[r][o]] !== undefined) {
      addedMe.push({ userId: values[r][o], nickname: nick[values[r][o]] });
    }
  }
  return { ok: true, contacts, addedMe };
}

function handleAddContact(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインが必要です" };
  const me = m.found.data.userId;
  const code = normalizeShareCode(payload.shareCode);
  if (code.length !== 8) return { ok: false, error: "共有コードは8文字です" };

  const target = findMemberRow(m.sheet, x => normalizeShareCode(x.shareCode) === code);
  if (!target) return { ok: false, error: "この共有コードの会員は見つかりませんでした" };
  if (target.data.userId === me) return { ok: false, error: "自分自身は追加できません" };

  const current = getMyContactIds(me);
  if (current.indexOf(String(target.data.userId)) !== -1) {
    return { ok: false, error: `${target.data.nickname}さんは登録済みです` };
  }
  if (current.length >= MAX_CONTACTS) return { ok: false, error: `共有相手は${MAX_CONTACTS}人までです` };

  appendObject(getContactsSheet(), { ownerId: me, contactUserId: target.data.userId, createdAt: new Date().toISOString() });
  return { ok: true, contact: { userId: target.data.userId, nickname: target.data.nickname } };
}

/** 自分の全投稿の共有先から特定の相手を外す */
function removeFromMyShares(ownerId, contactUserId) {
  const sheet  = getItemsSheet();
  const values = sheet.getDataRange().getValues();
  const h = values[0];
  const uid = h.indexOf("userId"), sw = h.indexOf("sharedWith");
  let count = 0;
  for (let r = 1; r < values.length; r++) {
    if (values[r][uid] !== ownerId) continue;
    const list = parseShared(values[r][sw]);
    const idx = list.indexOf(String(contactUserId));
    if (idx === -1) continue;
    list.splice(idx, 1);
    sheet.getRange(r + 1, sw + 1).setValue(JSON.stringify(list));
    count++;
  }
  return count;
}

function handleStopSharingWith(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインが必要です" };
  const count = removeFromMyShares(m.found.data.userId, payload.contactUserId);
  return { ok: true, count };
}

function handleRemoveContact(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインが必要です" };
  const me = m.found.data.userId;
  const sheet  = getContactsSheet();
  const values = sheet.getDataRange().getValues();
  const h = values[0];
  const o = h.indexOf("ownerId"), c = h.indexOf("contactUserId");
  for (let r = values.length - 1; r >= 1; r--) {
    if (values[r][o] === me && String(values[r][c]) === String(payload.contactUserId)) {
      sheet.deleteRow(r + 1);
    }
  }
  removeFromMyShares(me, payload.contactUserId);
  return { ok: true };
}

/* ============================================================
   Googleドライブ: 写真
   ============================================================ */
function savePhotoToDrive(base64Data, mimeType) {
  const folderId = PropertiesService.getScriptProperties().getProperty("DRIVE_FOLDER_ID");
  if (!folderId) throw new Error("DRIVE_FOLDER_IDが未設定です");
  const folder    = DriveApp.getFolderById(folderId);
  const rawBase64 = base64Data.indexOf(",") !== -1 ? base64Data.split(",").pop() : base64Data;
  const blob      = Utilities.newBlob(Utilities.base64Decode(rawBase64), mimeType || "image/jpeg", Utilities.getUuid() + ".jpg");
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w1000";
}
function deletePhotoFromDrive(photoUrl) {
  const match = String(photoUrl).match(/[?&]id=([^&]+)/);
  if (match) DriveApp.getFileById(match[1]).setTrashed(true);
}

/* ============================================================
   読み上げ用テキストの整形
   「〜で読み上げてください」「以下を〜」などの指示・前置きを取り除く
   ============================================================ */
function cleanNarrationText(text) {
  let s = String(text || "").replace(/\r/g, "").trim();
  const patterns = [
    // 「明るい声で読み上げてください。」「ナレーション風に朗読します：」など
    /^[^\n。]{0,40}?(で|を|に|風に|ように|調で)\s*(読み上げ|朗読|ナレーション|音読)[^\n。]{0,10}?(てください|て下さい|ください|下さい|します|してね|て)[。．!！:：、\s]*/,
    // 「以下の紹介文です：」「次の文章を〜：」
    /^(以下|次)(は|の|を)[^\n。]{0,30}(文章|テキスト|内容|紹介文|コメント|原稿)[^\n。]{0,20}?(です[:：。]|[:：]|です)\s*/,
    // 「承知しました。」等の応答
    /^(承知(いた)?しました|かしこまりました|了解(いた)?しました)[。!！、\s]*/,
    // 「（落ち着いた声で）」「【ナレーション】」
    /^[（(【\[][^）)】\]]{0,30}(声|トーン|口調|スタイル|読み|ナレーション)[^）)】\]]{0,30}[）)】\]]\s*/
  ];  for (let i = 0; i < 3; i++) {
    const before = s;
    patterns.forEach(p => { s = s.replace(p, "").trim(); });
    if (s === before) break;
  }
  s = s.replace(/^["“「『]+|["”」』]+$/g, "").trim();
  return s;
}

/* ============================================================
   Gemini: 説明文自動生成
   ============================================================ */
function handleGenerateDescription(payload) {
  if (!payload.itemName || !payload.region) return { ok: false, error: "商品名と地域を入力してから生成してください" };
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEYが未設定です" };

  const prompt =
    "あなたはご当地グルメ紹介ライターです。以下の商品について、" +
    "40〜80文字程度で親しみやすい紹介コメントを1つ、日本語で作成してください。" +
    "誇張しすぎず、実際に食べた人の感想のようなトーンにしてください。" +
    "絵文字や記号は使わず、紹介文の本文だけを出力してください。" +
    "前置き・見出し・かぎかっこ・「以下は」「〜で読み上げてください」などの説明や指示の文は一切書かないでください。\n\n" +
    "商品名: " + payload.itemName + "\n" +
    "地域: " + payload.region + "\n" +
    "カテゴリ: " + (payload.category || "不明") + "\n" +
    "店舗名: " + (payload.storeName || "不明");

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" + apiKey;
  const res = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 200, thinkingConfig: { thinkingLevel: "low" } }
    })
  });
  if (res.getResponseCode() !== 200) return { ok: false, error: "Gemini APIエラー: " + res.getContentText() };

  const json = JSON.parse(res.getContentText());
  const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
  const text = parts ? parts.map(p => p.text || "").join("") : "";
  const cleaned = cleanNarrationText(text);
  if (!cleaned) return { ok: false, error: "説明文の生成に失敗しました" };
  return { ok: true, text: cleaned };
}

/* ============================================================
   Gemini TTS: 読み上げ音声（会員のみ）
   本文だけを contents に入れ、声の指定は speechConfig で行う。
   → 指示文が音声に混ざらない
   ============================================================ */
function handleTts(payload) {
  const m = requireMember(payload);
  if (!m) return { ok: false, error: "ログインが必要です" };

  const text = cleanNarrationText(payload.text).slice(0, 600);
  if (!text) return { ok: false, error: "読み上げる文章がありません" };

  const props  = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty("GEMINI_API_KEY");
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEYが未設定です" };
  const model = props.getProperty("GEMINI_TTS_MODEL") || DEFAULT_TTS_MODEL;
  const voice = props.getProperty("GEMINI_TTS_VOICE") || "Kore";

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + apiKey;
  const res = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    })
  });
  if (res.getResponseCode() !== 200) return { ok: false, error: "TTSエラー: " + res.getResponseCode() };

  const json = JSON.parse(res.getContentText());
  const parts = json && json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts;
  const audio = parts && parts.filter(p => p.inlineData && p.inlineData.data)[0];
  if (!audio) return { ok: false, error: "音声を生成できませんでした" };
  return { ok: true, audioBase64: audio.inlineData.data, mimeType: audio.inlineData.mimeType || "audio/L16;rate=24000" };
}
