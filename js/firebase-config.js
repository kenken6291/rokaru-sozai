/**
 * firebase-config.js
 * ──────────────────────────────────────────────────────────────
 * 【セキュリティ解説】
 *
 * Firebase の "Web API キー" は、Googleが公開リポジトリへの
 * ハードコードを前提に設計した「公開識別子」です。
 * これはバックエンドの秘密鍵（Secret Key）とは異なります。
 *
 * ただし、以下の理由でこのファイルを分離・明示しています：
 *   1. Firestore Security Rules / Storage Rules で
 *      「誰が何をできるか」を厳密に制御することが真のセキュリティ
 *   2. 将来 GitHub Actions で環境変数注入に切り替えやすくするため
 *   3. 本番・開発環境を切り替えるための構造を用意するため
 *
 * 参考: https://firebase.google.com/docs/projects/api-keys
 * ──────────────────────────────────────────────────────────────
 *
 * 【設定手順】
 *   1. https://console.firebase.google.com/ でプロジェクトを作成
 *   2. 「プロジェクトの設定」→「マイアプリ」→「ウェブ」でアプリ登録
 *   3. 表示された firebaseConfig の値を下記にコピーする
 *   4. Firestore Database を「本番モード」で有効化
 *   5. Storage を有効化
 *   6. Authentication → ログイン方法 → 匿名認証を有効化
 *   7. 下記の FIREBASE_ENABLED を true に変更する
 */

// ▼▼▼ ここに Firebase コンソールの値を貼り付ける ▼▼▼
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyCDka9P3GAy5k-T3WkZVCtSpuhB_NpEtV4",
  authDomain:        "rokaru-sozai.firebaseapp.com",
  projectId:         "rokaru-sozai",
  storageBucket:     "rokaru-sozai.firebasestorage.app",
  messagingSenderId: "318231973586",
  appId:             "1:318231973586:web:d397c52b699f5ea813670b"
};
// ▲▲▲ ここまで ▲▲▲

/**
 * Firebase を使用するかどうかのフラグ
 * - false (デフォルト): LocalStorage モードで動作（設定不要）
 * - true              : Firebase モードで動作（上記の設定が必要）
 */
const FIREBASE_ENABLED = true;
