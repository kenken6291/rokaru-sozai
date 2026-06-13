/**
 * firebase-service.js — 写真なし版（Firestore + Auth のみ）
 * ──────────────────────────────────────────────────────────────
 * Storage を使わないため、無料プラン（Spark）のまま動作します。
 * ──────────────────────────────────────────────────────────────
 */

"use strict";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  deleteDoc,
  query,
  orderBy,
  onSnapshot,
  serverTimestamp,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let _app        = null;
let _auth       = null;
let _db         = null;
let _currentUid = null;
let _unsubscribe = null;

const COLLECTION = "items";

/** Firebase を初期化し、匿名ログインまで完了させる */
export async function initFirebase() {
  if (!FIREBASE_ENABLED) return null;

  _app  = initializeApp(FIREBASE_CONFIG);
  _auth = getAuth(_app);
  _db   = getFirestore(_app);

  _currentUid = await _signInAnonymously();
  return _currentUid;
}

export function getCurrentUid() { return _currentUid; }

/** Firestoreのアイテム一覧をリアルタイム購読する */
export function subscribeItems(onUpdate) {
  if (!_db) return;
  if (_unsubscribe) _unsubscribe();

  const q = query(collection(_db, COLLECTION), orderBy("createdAt", "desc"));
  _unsubscribe = onSnapshot(q, (snapshot) => {
    const items = snapshot.docs.map(docSnap => ({
      id: docSnap.id,
      ...docSnap.data(),
      createdAt: docSnap.data().createdAt?.toDate?.()?.toISOString()
                 ?? new Date().toISOString()
    }));
    onUpdate(items);
  }, (err) => {
    console.error("Firestore listen error:", err);
  });
}

export function unsubscribeItems() {
  if (_unsubscribe) { _unsubscribe(); _unsubscribe = null; }
}

/** 新規アイテムを Firestore に追加する（写真なし） */
export async function addItem(itemData) {
  if (!_db) throw new Error("Firebase not initialized");

  const docRef = await addDoc(collection(_db, COLLECTION), {
    ...itemData,
    uid:       _currentUid,
    createdAt: serverTimestamp()
  });
  return docRef.id;
}

/** アイテムを削除する */
export async function deleteItem(docId) {
  if (!_db) throw new Error("Firebase not initialized");
  await deleteDoc(doc(_db, COLLECTION, docId));
}

/** 自分の投稿か確認する */
export async function canDeleteItem(docId) {
  if (!_db || !_currentUid) return false;
  try {
    const snap = await getDoc(doc(_db, COLLECTION, docId));
    return snap.exists() && snap.data().uid === _currentUid;
  } catch { return false; }
}

async function _signInAnonymously() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(_auth, async (user) => {
      if (user) {
        resolve(user.uid);
      } else {
        try {
          const credential = await signInAnonymously(_auth);
          resolve(credential.user.uid);
        } catch (err) {
          console.error("Anonymous auth failed:", err);
          reject(err);
        }
      }
    });
  });
}
