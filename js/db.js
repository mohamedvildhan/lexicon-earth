const DB_NAME = "lexicon-earth";
const DB_VERSION = 3;
const STORE = "entries";
const META = "meta";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      let store;
      if (!db.objectStoreNames.contains(STORE)) {
        store = db.createObjectStore(STORE, { keyPath: "cacheKey" });
        store.createIndex("word", "word", { unique: false });
        store.createIndex("cachedAt", "cachedAt", { unique: false });
      } else {
        store = req.transaction.objectStore(STORE);
      }
      if (store && !store.indexNames.contains("query")) {
        store.createIndex("query", "query", { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function cacheKey(query, languageCode = "en", senseId = "0") {
  return `${String(query).toLowerCase()}|${languageCode}|${senseId}`;
}

function queryForm(record) {
  return String(record?.query || record?.word || "")
    .toLowerCase()
    .trim();
}

export async function getEntry(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result?.record || null);
    req.onerror = () => reject(req.error);
  });
}

/** Find any cached record whose query/word matches (starter keys included). */
export async function findCachedByQuery(query) {
  const q = String(query || "").toLowerCase();
  if (!q) return null;
  const db = await openDb();

  const byQuery = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).index("query").getAll(q);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  const hitQ = byQuery.find((r) => r.record && !r.record.miss);
  if (hitQ?.record) return hitQ.record;

  /* Fallback: word index (older rows / starter without query field) */
  const byWord = await new Promise((resolve, reject) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).index("word").getAll(IDBKeyRange.only(q));
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    } catch {
      resolve([]);
    }
  });
  const hitW = byWord.find((r) => r.record && !r.record.miss);
  if (hitW?.record) return hitW.record;

  /* Soft fallback for rows missing query index (pre-v3) */
  const all = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  const hit = all.find(
    (r) =>
      r.record &&
      !r.record.miss &&
      ((r.query || r.record.query || "").toLowerCase() === q || (r.word || "").toLowerCase() === q)
  );
  return hit?.record || null;
}

export async function putEntry(key, record) {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const q = queryForm(record);
  tx.objectStore(STORE).put({
    cacheKey: key,
    word: record.word,
    query: q,
    cachedAt: record.cachedAt || Date.now(),
    record,
  });
  await txDone(tx);
}

export async function listEntries() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => {
      const rows = (req.result || []).map((r) => ({
        cacheKey: r.cacheKey,
        word: r.word,
        cachedAt: r.cachedAt,
        language: r.record?.language,
        sourcesUsed: r.record?.sourcesUsed,
      }));
      rows.sort((a, b) => (b.cachedAt || 0) - (a.cachedAt || 0));
      resolve(rows);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearEntries() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  await txDone(tx);
}

export async function exportJson() {
  const db = await openDb();
  const rows = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return {
    format: "lexicon-earth-cache",
    version: 2,
    exportedAt: new Date().toISOString(),
    entries: rows.map((r) => r.record),
  };
}

export async function importJson(payload) {
  if (!payload || payload.format !== "lexicon-earth-cache" || !Array.isArray(payload.entries)) {
    throw new Error("Invalid Lexicon Earth cache file.");
  }
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  for (const record of payload.entries) {
    if (!record?.word || !record?.nodes) continue;
    const key =
      record.cacheKey ||
      cacheKey(record.query || record.word, record.languageCode || "en", record.sense || "0");
    const cachedAt = record.cachedAt || Date.now();
    store.put({
      cacheKey: key,
      word: record.word,
      query: queryForm(record),
      cachedAt,
      record: { ...record, cachedAt },
    });
  }
  await txDone(tx);
  return payload.entries.length;
}

/** Migrate legacy localStorage cache once. */
export async function migrateLegacyLocalStorage() {
  try {
    const raw = localStorage.getItem("lx_cache_v2") || localStorage.getItem("lx_cache_v1");
    if (!raw) return 0;
    const o = JSON.parse(raw);
    let n = 0;
    for (const [k, v] of Object.entries(o)) {
      if (!v || v.miss || !v.word) continue;
      if (!v.nodes || !v.edges) continue;
      await putEntry(k.includes("|") ? k : cacheKey(v.q || v.word, "en", String(v.ety || 0)), v);
      n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}
