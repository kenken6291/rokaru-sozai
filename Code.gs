/**
 * Code.gs — ご当地スーパー・銘菓発掘図鑑 バックエンド
 * ──────────────────────────────────────────────────────────────
 * 構成: GitHub Pages(フロント) + GAS(API) + Googleスプレッドシート(DB)
 *      + Googleドライブ(写真保存) + Gemini API(説明文自動生成)
 * 会員認証: メール登録 → 仮パスワード発行 → 初回ログイン時強制パスワード変更
 *          / パスワード忘れ時の仮パスワード再発行 / ニックネーム変更 / ログアウト
 * Firebaseは不使用。
 *
 * 【事前準備】
 *   1. 新規スプレッドシートを作成し、拡張機能 → Apps Script でこのCode.gsを貼り付け
 *      （items / members シートは初回アクセス時に自動作成されます）
 *   2. Googleドライブに写真保存用フォルダを新規作成し、フォルダIDを控える
 *   3. 「プロジェクトの設定」→「スクリプト プロパティ」に追加:
 *        GEMINI_API_KEY   : Gemini APIキー（https://aistudio.google.com/apikey）
 *        DRIVE_FOLDER_ID  : 手順2で控えたフォルダID
 *        PASSWORD_PEPPER  : 任意の長いランダム文字列（パスワードハッシュ用の秘密のこしょう）
 *   4. 「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *        実行するユーザー: 自分 / アクセスできるユーザー: 全員
 *      発行されたURLを app.js と auth.js の GAS_API_URL に貼り付ける
 *   5. 初回実行時、MailApp（メール送信）の権限承認を求められるので許可する
 *      ※ MailAppは1日100通までの送信上限（Googleアカウントの標準クォータ）
 *   6. コードを変更するたびに「デプロイを管理」→ 新しいバージョンを作成
 *      （URLはそのまま。バージョンを切らないと変更が反映されません）
 * ──────────────────────────────────────────────────────────────
 */

const ITEMS_SHEET_NAME   = "items";
const MEMBERS_SHEET_NAME = "members";

const ITEMS_HEADER = [
  "id","itemName","storeName","region","category","rating","comment",
  "storeUrl","photoUrl","userId","createdAt","updatedAt"
];
const MEMBERS_HEADER = [
  "userId","email","nickname","passwordHash","salt","isTempPassword",
  "failedAttempts","lockUntil","sessionToken","createdAt","updatedAt"
];

const REGIONS    = ["北海道・東北","関東","中部・東海","近畿","中国・四国","九州・沖縄"];
const CATEGORIES = ["惣菜","銘菓","珍味","飲み物","その他"];

const MAX_LOGIN_FAILS = 5;
const LOCK_MINUTES    = 15;
const TEMP_PW_CHARS   = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // 紛らわしい文字(0/O/1/l/I)を除外

/* ============================================================
   エントリーポイント
   ============================================================ */
function doPost(e) {
  const out = (obj) =>
    ContentService.createTextOutput(JSON.stringify(obj))
      .setMimeType(ContentService.MimeType.TEXT); // text/plain応答でCORSプリフライトを回避

  try {
    const req    = JSON.parse(e.postData.contents);
    const action = req.action;
    const p      = req.payload || {};

    switch (action) {
      case "list":                return out(handleList());
      case "create":               return out(handleCreate(p));
      case "update":                return out(handleUpdate(p));
      case "delete":                return out(handleDelete(p));
      case "generateDescription":  return out(handleGenerateDescription(p));

      case "register":             return out(handleRegister(p));
      case "login":                 return out(handleLogin(p));
      case "getSession":            return out(handleGetSession(p));
      case "changePassword":        return out(handleChangePassword(p));
      case "forgotPassword":        return out(handleForgotPassword(p));
      case "changeNickname":        return out(handleChangeNickname(p));
      case "logout":                return out(handleLogout(p));

      default:
        return out({ ok: false, error: "unknown action: " + action });
    }
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function doGet() {
  return ContentService.createTextOutput("ご当地スーパー・銘菓発掘図鑑 API is running.");
}

/* ============================================================
   シート取得
   ============================================================ */
function getItemsSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(ITEMS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(ITEMS_SHEET_NAME);
    sheet.appendRow(ITEMS_HEADER);
  }
  return sheet;
}
function getMembersSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(MEMBERS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(MEMBERS_SHEET_NAME);
    sheet.appendRow(MEMBERS_HEADER);
  }
  return sheet;
}

function rowsToObjects(values) {
  const header = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    header.forEach((key, i) => { obj[key] = row[i]; });
    return obj;
  });
}

/* ============================================================
   会員: パスワードハッシュ / 一時パスワード
   ============================================================ */
function hashPassword(password, salt) {
  const pepper = PropertiesService.getScriptProperties().getProperty("PASSWORD_PEPPER") || "";
  const raw    = String(password) + String(salt) + pepper;
  const bytes  = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return bytes.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, "0")).join("");
}

function generateTempPassword() {
  let pw = "";
  for (let i = 0; i < 8; i++) {
    pw += TEMP_PW_CHARS.charAt(Math.floor(Math.random() * TEMP_PW_CHARS.length));
  }
  return pw;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

/* ============================================================
   会員: メンバー検索
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

/* ============================================================
   会員登録
   ============================================================ */
function handleRegister(payload) {
  const email    = String(payload.email || "").trim();
  const nickname = String(payload.nickname || "").trim();

  if (!isValidEmail(email)) return { ok: false, error: "メールアドレスの形式が正しくありません" };
  if (nickname.length < 1 || nickname.length > 20) return { ok: false, error: "ニックネームは1〜20文字で入力してください" };

  const sheet = getMembersSheet();
  if (findMemberByEmail(sheet, email)) {
    return { ok: false, error: "このメールアドレスは既に登録されています" };
  }

  const tempPassword = generateTempPassword();
  const salt = Utilities.getUuid();
  const hash = hashPassword(tempPassword, salt);
  const now  = new Date().toISOString();
  const userId = Utilities.getUuid();

  sheet.appendRow([
    userId, email, nickname, hash, salt, true,
    0, "", "", now, now
  ]);

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
    return { ok: false, error: "登録は完了しましたが、メール送信に失敗しました。時間を置いて再度お試しください" };
  }

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

  const hash = hashPassword(password, data.salt);
  if (hash !== data.passwordHash) {
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
  const now = new Date().toISOString();
  setMemberCell(sheet, header, rowNum, "failedAttempts", 0);
  setMemberCell(sheet, header, rowNum, "lockUntil", "");
  setMemberCell(sheet, header, rowNum, "sessionToken", sessionToken);
  setMemberCell(sheet, header, rowNum, "updatedAt", now);

  return {
    ok: true,
    sessionToken,
    userId: data.userId,
    nickname: data.nickname,
    isTempPassword: !!data.isTempPassword
  };
}

/* ============================================================
   セッション確認（再訪問時の自動ログイン維持）
   ============================================================ */
function handleGetSession(payload) {
  const sheet = getMembersSheet();
  const found = findMemberBySession(sheet, payload.sessionToken);
  if (!found) return { ok: false };
  return {
    ok: true,
    userId: found.data.userId,
    nickname: found.data.nickname,
    isTempPassword: !!found.data.isTempPassword
  };
}

/* ============================================================
   パスワード変更（初回強制変更 / 任意変更 共通）
   ============================================================ */
function handleChangePassword(payload) {
  const sheet = getMembersSheet();
  const found = findMemberBySession(sheet, payload.sessionToken);
  if (!found) return { ok: false, error: "ログインし直してください" };

  const { rowNum, header, data } = found;
  const currentPassword = String(payload.currentPassword || "");
  const newPassword     = String(payload.newPassword || "");

  const currentHash = hashPassword(currentPassword, data.salt);
  if (currentHash !== data.passwordHash) {
    return { ok: false, error: "現在のパスワードが正しくありません" };
  }
  if (newPassword.length < 8) {
    return { ok: false, error: "新しいパスワードは8文字以上で設定してください" };
  }

  const newSalt = Utilities.getUuid();
  const newHash = hashPassword(newPassword, newSalt);
  const now = new Date().toISOString();

  setMemberCell(sheet, header, rowNum, "passwordHash", newHash);
  setMemberCell(sheet, header, rowNum, "salt", newSalt);
  setMemberCell(sheet, header, rowNum, "isTempPassword", false);
  setMemberCell(sheet, header, rowNum, "updatedAt", now);

  return { ok: true };
}

/* ============================================================
   パスワードを忘れた場合 → 仮パスワード再発行
   ============================================================ */
function handleForgotPassword(payload) {
  const email = String(payload.email || "").trim();
  if (!isValidEmail(email)) return { ok: false, error: "メールアドレスの形式が正しくありません" };

  const sheet = getMembersSheet();
  const found = findMemberByEmail(sheet, email);

  // メールアドレスの存在有無を外部に漏らさないよう、常に同じ成功メッセージを返す
  const genericResult = { ok: true, message: "このメールアドレスが登録されていれば、仮パスワードを送信しました" };
  if (!found) return genericResult;

  const { rowNum, header, data } = found;
  const tempPassword = generateTempPassword();
  const newSalt = Utilities.getUuid();
  const newHash = hashPassword(tempPassword, newSalt);
  const now = new Date().toISOString();

  setMemberCell(sheet, header, rowNum, "passwordHash", newHash);
  setMemberCell(sheet, header, rowNum, "salt", newSalt);
  setMemberCell(sheet, header, rowNum, "isTempPassword", true);
  setMemberCell(sheet, header, rowNum, "sessionToken", ""); // 既存セッションは無効化
  setMemberCell(sheet, header, rowNum, "failedAttempts", 0);
  setMemberCell(sheet, header, rowNum, "lockUntil", "");
  setMemberCell(sheet, header, rowNum, "updatedAt", now);

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
  } catch (e) {
    // メール送信失敗時もパスワードは既に更新済みのため、成功として扱う（次回問い合わせで案内）
  }

  return genericResult;
}

/* ============================================================
   ニックネーム変更
   ============================================================ */
function handleChangeNickname(payload) {
  const sheet = getMembersSheet();
  const found = findMemberBySession(sheet, payload.sessionToken);
  if (!found) return { ok: false, error: "ログインし直してください" };

  const nickname = String(payload.nickname || "").trim();
  if (nickname.length < 1 || nickname.length > 20) {
    return { ok: false, error: "ニックネームは1〜20文字で入力してください" };
  }

  const { rowNum, header } = found;
  setMemberCell(sheet, header, rowNum, "nickname", nickname);
  setMemberCell(sheet, header, rowNum, "updatedAt", new Date().toISOString());

  return { ok: true, nickname };
}

/* ============================================================
   ログアウト
   ============================================================ */
function handleLogout(payload) {
  const sheet = getMembersSheet();
  const found = findMemberBySession(sheet, payload.sessionToken);
  if (found) {
    setMemberCell(sheet, found.header, found.rowNum, "sessionToken", "");
  }
  return { ok: true };
}

/* ============================================================
   投稿一覧（会員のニックネームを都度突き合わせて返す）
   ============================================================ */
function handleList() {
  const itemsSheet   = getItemsSheet();
  const membersSheet = getMembersSheet();

  const itemsValues = itemsSheet.getDataRange().getValues();
  if (itemsValues.length < 2) return { ok: true, items: [] };

  const memberValues = membersSheet.getDataRange().getValues();
  const nicknameByUserId = {};
  if (memberValues.length > 1) {
    const mHeader = memberValues[0];
    const uidCol  = mHeader.indexOf("userId");
    const nickCol = mHeader.indexOf("nickname");
    memberValues.slice(1).forEach(row => { nicknameByUserId[row[uidCol]] = row[nickCol]; });
  }

  const items = rowsToObjects(itemsValues)
    .filter(it => it.id)
    .map(it => ({ ...it, nickname: nicknameByUserId[it.userId] || "退会したユーザー" }));

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
  if (REGIONS.indexOf(payload.region) === -1)
    return "地域を正しく選択してください";
  if (CATEGORIES.indexOf(payload.category) === -1)
    return "カテゴリを正しく選択してください";
  const rating = Number(payload.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5)
    return "評価は1〜5で指定してください";
  if (payload.comment && String(payload.comment).length > 210)
    return "レビューは210文字以内で入力してください";
  if (payload.storeUrl && String(payload.storeUrl).length > 510)
    return "URLが長すぎます";
  return null;
}

/* ============================================================
   投稿の作成・更新・削除（会員セッション必須）
   ============================================================ */
function handleCreate(payload) {
  const membersSheet = getMembersSheet();
  const member = findMemberBySession(membersSheet, payload.sessionToken);
  if (!member) return { ok: false, error: "ログインが必要です" };

  const err = validateItem(payload);
  if (err) return { ok: false, error: err };

  let photoUrl = "";
  if (payload.photoBase64) {
    try {
      photoUrl = savePhotoToDrive(payload.photoBase64, payload.photoMimeType);
    } catch (e) {
      return { ok: false, error: "写真の保存に失敗しました: " + e };
    }
  }

  const id  = Utilities.getUuid();
  const now = new Date().toISOString();
  getItemsSheet().appendRow([
    id, payload.itemName, payload.storeName, payload.region, payload.category,
    Number(payload.rating), payload.comment || "", payload.storeUrl || "",
    photoUrl, member.data.userId, now, now
  ]);
  return { ok: true, id, photoUrl, createdAt: now };
}

function handleUpdate(payload) {
  const membersSheet = getMembersSheet();
  const member = findMemberBySession(membersSheet, payload.sessionToken);
  if (!member) return { ok: false, error: "ログインが必要です" };
  if (!payload.id) return { ok: false, error: "idが必要です" };

  const err = validateItem(payload);
  if (err) return { ok: false, error: err };

  const sheet  = getItemsSheet();
  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idCol     = header.indexOf("id");
  const userIdCol = header.indexOf("userId");
  const photoCol  = header.indexOf("photoUrl");

  for (let r = 1; r < values.length; r++) {
    if (values[r][idCol] !== payload.id) continue;

    if (values[r][userIdCol] !== member.data.userId) {
      return { ok: false, error: "この記録を編集する権限がありません" };
    }

    let photoUrl = values[r][photoCol];
    if (payload.photoBase64) {
      try {
        if (photoUrl) deletePhotoFromDrive(photoUrl);
        photoUrl = savePhotoToDrive(payload.photoBase64, payload.photoMimeType);
      } catch (e) {
        return { ok: false, error: "写真の保存に失敗しました: " + e };
      }
    } else if (payload.removePhoto) {
      if (photoUrl) deletePhotoFromDrive(photoUrl);
      photoUrl = "";
    }

    const now    = new Date().toISOString();
    const rowNum = r + 1;
    const setCell = (colName, value) => sheet.getRange(rowNum, header.indexOf(colName) + 1).setValue(value);

    setCell("itemName",  payload.itemName);
    setCell("storeName", payload.storeName);
    setCell("region",    payload.region);
    setCell("category",  payload.category);
    setCell("rating",    Number(payload.rating));
    setCell("comment",   payload.comment || "");
    setCell("storeUrl",  payload.storeUrl || "");
    setCell("photoUrl",  photoUrl);
    setCell("updatedAt", now);

    return { ok: true, photoUrl, updatedAt: now };
  }
  return { ok: false, error: "対象の記録が見つかりません" };
}

function handleDelete(payload) {
  const membersSheet = getMembersSheet();
  const member = findMemberBySession(membersSheet, payload.sessionToken);
  if (!member) return { ok: false, error: "ログインが必要です" };
  if (!payload.id) return { ok: false, error: "idが必要です" };

  const sheet  = getItemsSheet();
  const values = sheet.getDataRange().getValues();
  const header = values[0];
  const idCol     = header.indexOf("id");
  const userIdCol = header.indexOf("userId");
  const photoCol  = header.indexOf("photoUrl");

  for (let r = 1; r < values.length; r++) {
    if (values[r][idCol] !== payload.id) continue;

    if (values[r][userIdCol] !== member.data.userId) {
      return { ok: false, error: "この記録を削除する権限がありません" };
    }

    const photoUrl = values[r][photoCol];
    sheet.deleteRow(r + 1);
    if (photoUrl) {
      try { deletePhotoFromDrive(photoUrl); } catch (e) { /* 削除失敗は無視 */ }
    }
    return { ok: true };
  }
  return { ok: false, error: "対象の記録が見つかりません" };
}

/* ============================================================
   Googleドライブ: 写真保存
   ============================================================ */
function savePhotoToDrive(base64Data, mimeType) {
  const folderId = PropertiesService.getScriptProperties().getProperty("DRIVE_FOLDER_ID");
  if (!folderId) throw new Error("DRIVE_FOLDER_IDが未設定です");

  const folder      = DriveApp.getFolderById(folderId);
  const contentType = mimeType || "image/jpeg";
  const rawBase64    = base64Data.indexOf(",") !== -1 ? base64Data.split(",").pop() : base64Data;
  const bytes        = Utilities.base64Decode(rawBase64);
  const blob         = Utilities.newBlob(bytes, contentType, Utilities.getUuid() + ".jpg");

  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return "https://drive.google.com/uc?export=view&id=" + file.getId();
}

function deletePhotoFromDrive(photoUrl) {
  const match = String(photoUrl).match(/id=([^&]+)/);
  if (match) DriveApp.getFileById(match[1]).setTrashed(true);
}

/* ============================================================
   Gemini: 商品名・地域からの説明文自動生成
   ============================================================ */
function handleGenerateDescription(payload) {
  if (!payload.itemName || !payload.region) {
    return { ok: false, error: "商品名と地域を入力してから生成してください" };
  }

  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEYが未設定です" };

  const prompt =
    "あなたはご当地グルメ紹介ライターです。以下の商品について、" +
    "40〜80文字程度で親しみやすい紹介コメントを1つ、日本語で作成してください。" +
    "誇張しすぎず、実際に食べた人の感想のようなトーンにしてください。" +
    "絵文字や記号は使わず、文章のみを出力してください。\n\n" +
    "商品名: " + payload.itemName + "\n" +
    "地域: " + payload.region + "\n" +
    "カテゴリ: " + (payload.category || "不明") + "\n" +
    "店舗名: " + (payload.storeName || "不明");

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey;
  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.9, maxOutputTokens: 200 }
    })
  });

  if (res.getResponseCode() !== 200) {
    return { ok: false, error: "Gemini APIエラー: " + res.getContentText() };
  }

  const json = JSON.parse(res.getContentText());
  const text = json && json.candidates && json.candidates[0] &&
               json.candidates[0].content && json.candidates[0].content.parts &&
               json.candidates[0].content.parts[0] && json.candidates[0].content.parts[0].text;

  if (!text) return { ok: false, error: "説明文の生成に失敗しました" };
  return { ok: true, text: text.trim() };
}
