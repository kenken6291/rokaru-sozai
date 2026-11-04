/**
 * config.js — ご当地スーパー・銘菓発掘図鑑 設定ファイル
 * ──────────────────────────────────────────────────────────────
 * GASを「ウェブアプリ」としてデプロイした際に発行されたURLを設定する。
 * ※ GASのコードを更新しても「新バージョン」でデプロイすればURLは変わらないため、
 *   通常は書き換え不要。新しいデプロイを作った場合のみここを変更する。
 * 読み込み順: config.js → auth.js → app.js
 * ──────────────────────────────────────────────────────────────
 */
window.APP_CONFIG = {
  GAS_API_URL: "https://script.google.com/macros/s/AKfycbzzfcuSts3MG5UmPCRUuzbyRiUj54sM-MQZ2dMNIddfQuSwOFycU1TJNObMDfuu6A7zoA/exec"
};
