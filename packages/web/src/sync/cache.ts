import type { SyncState, TranscriptItem } from "@switchyard/protocol";

/**
 * Offline cache of the last synced state and its cursor, so the UI shows
 * last-known data while reconnecting and the WS resumes with `hello {cursor}`.
 * IndexedDB when available, localStorage otherwise.
 */

export interface CachedSync {
  seq: number;
  state: SyncState;
  savedAt: string;
}

const DB_NAME = "switchyard";
const STORE = "kv";
const KEY = "sync";
const TRANSCRIPTS = "transcripts";
const MAX_CACHED_TRANSCRIPTS = 50;
const LS_KEY = "sy:sync-cache";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        if (!db.objectStoreNames.contains(TRANSCRIPTS)) db.createObjectStore(TRANSCRIPTS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        if (!db) return reject(new Error("no indexeddb"));
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function loadCache(): Promise<CachedSync | null> {
  try {
    const v = await idb<CachedSync | undefined>("readonly", (s) => s.get(KEY));
    if (v) return v;
  } catch {
    // fall through to localStorage
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as CachedSync) : null;
  } catch {
    return null;
  }
}

export async function saveCache(value: CachedSync): Promise<void> {
  try {
    await idb("readwrite", (s) => s.put(value, KEY));
    return;
  } catch {
    // fall through
  }
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(value));
  } catch {
    // quota exceeded: the cache is best effort
  }
}

export interface CachedTranscript {
  sessionId: string;
  epoch: number;
  rev: number;
  items: TranscriptItem[];
  hasMore: boolean;
  savedAt: string;
}

function tidb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        if (!db) return reject(new Error("no indexeddb"));
        const tx = db.transaction(TRANSCRIPTS, mode);
        const req = fn(tx.objectStore(TRANSCRIPTS));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function loadTranscriptCache(sessionId: string): Promise<CachedTranscript | null> {
  try {
    return (await tidb<CachedTranscript | undefined>("readonly", (s) => s.get(sessionId))) ?? null;
  } catch {
    return null;
  }
}

export async function saveTranscriptCache(rec: CachedTranscript): Promise<void> {
  try {
    await tidb("readwrite", (s) => s.put(rec, rec.sessionId));
    const count = await tidb<number>("readonly", (s) => s.count());
    if (count <= MAX_CACHED_TRANSCRIPTS) return;
    const all = await tidb<CachedTranscript[]>("readonly", (s) => s.getAll());
    all.sort((a, b) => a.savedAt.localeCompare(b.savedAt));
    for (const old of all.slice(0, count - MAX_CACHED_TRANSCRIPTS)) {
      await tidb("readwrite", (s) => s.delete(old.sessionId));
    }
  } catch {
    // best effort
  }
}

export async function clearCache(): Promise<void> {
  try {
    await idb("readwrite", (s) => s.delete(KEY));
  } catch {
    // ignore
  }
  try {
    await tidb("readwrite", (s) => s.clear());
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    // ignore
  }
}
