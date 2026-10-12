import { adapters, getAdapter } from "./sources/index.js";
import { makeRecord } from "./model.js";
import { cacheKey, getEntry, putEntry, findCachedByQuery } from "./db.js";
import { sanitizeRecordGaps } from "./model.js";

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const discoveryCache = new Map();

/* Wiktionary: ~12s with one retry (real abort). Others stay short. */
const ADAPTER_TIMEOUTS = {
  wiktionary: 12000,
  wikidata: 6000,
  kaikki: 2000,
};
const FETCH_TIMEOUTS = {
  wiktionary: 12000,
  wikidata: 12000,
  kaikki: 4000,
};

let searchSeq = 0;
let activeAbort = null;

/** Default: Multi-source on. Toggle via setMultiSource(false) for Wiktionary-only. */
let multiSource = true;

export function setMultiSource(on) {
  multiSource = !!on;
}

export function getMultiSource() {
  return multiSource;
}

export function normalizeQuery(raw) {
  const original = String(raw ?? "");
  /* Strip bidi/zero-width marks that break exact Wiktionary title matches */
  const trimmed = original
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .trim();
  const normalized = trimmed.normalize("NFC");
  return {
    original,
    query: normalized,
    keyForm: normalized.toLowerCase(),
  };
}

function discoveryKey(keyForm) {
  return `${keyForm}|${multiSource ? "multi" : "wikt"}`;
}

function beginSearchAbort() {
  if (activeAbort) activeAbort.abort();
  activeAbort = new AbortController();
  return activeAbort;
}

/**
 * Race a promise against a timeout; aborts `controller` on timeout so the
 * underlying fetch is cancelled (not just ignored).
 */
function withTimeout(promise, ms, label = "lookup", controller = null) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        controller?.abort();
      } catch {
        /* ignore */
      }
      reject(new Error(`${label} timed out`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function withRetry(fn, { retries = 1, label = "lookup" } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e?.name === "AbortError") throw e;
      if (i < retries) await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastErr || new Error(`${label} failed`);
}

function mergeCandidates(into, found, seen) {
  for (const c of found || []) {
    const sig = `${c.sourceId}|${c.lemma}|${c.sense}|${c.languageCode}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    into.push(c);
  }
}

/** Wiktionary-only discovery (fast path). */
export async function discoverWiktionary(rawQuery, { onProgress, signal } = {}) {
  const { original, query, keyForm } = normalizeQuery(rawQuery);
  if (!query) return { original, query, keyForm, candidates: [], errors: [] };

  const dk = discoveryKey(keyForm);
  const mem = discoveryCache.get(dk);
  if (mem && Date.now() - mem.at < DISCOVERY_TTL_MS) {
    return { ...mem.payload, fromDiscoveryCache: true };
  }

  const wikt = getAdapter("wiktionary");
  onProgress?.("Searching Wiktionary…");
  const errors = [];
  const candidates = [];
  const seen = new Set();
  try {
    const found = await withRetry(
      () => {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) ctrl.abort();
        return withTimeout(
          wikt.searchCandidates(query, { languageTag: "en", signal: ctrl.signal }),
          ADAPTER_TIMEOUTS.wiktionary,
          "wiktionary",
          ctrl
        ).finally(() => signal?.removeEventListener("abort", onAbort));
      },
      { retries: 1, label: "wiktionary" }
    );
    mergeCandidates(candidates, found, seen);
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    errors.push({ sourceId: "wiktionary", message: e.message || String(e) });
  }

  const payload = { original, query, keyForm, candidates: [...candidates], errors };
  if (payload.candidates.length) discoveryCache.set(dk, { at: Date.now(), payload });
  return payload;
}

/** Multi-source discovery (slower; optional). */
export async function discoverMulti(rawQuery, { onProgress, signal } = {}) {
  const { original, query, keyForm } = normalizeQuery(rawQuery);
  if (!query) return { original, query, keyForm, candidates: [], errors: [] };

  const dk = discoveryKey(keyForm);
  const mem = discoveryCache.get(dk);
  if (mem && Date.now() - mem.at < DISCOVERY_TTL_MS) {
    return { ...mem.payload, fromDiscoveryCache: true };
  }

  onProgress?.("Searching all sources…");
  const errors = [];
  const candidates = [];
  const seen = new Set();

  const settled = await Promise.all(
    adapters.map((adapter) => {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) ctrl.abort();
      return withTimeout(
        adapter.searchCandidates(query, { languageTag: "en", signal: ctrl.signal }),
        ADAPTER_TIMEOUTS[adapter.id] ?? 4000,
        adapter.id,
        ctrl
      )
        .then((found) => ({ adapter, found, ok: true }))
        .catch((e) => ({ adapter, found: [], ok: false, error: e }))
        .finally(() => signal?.removeEventListener("abort", onAbort));
    })
  );

  for (const r of settled) {
    if (!r.ok) {
      if (r.error?.name !== "AbortError") {
        errors.push({ sourceId: r.adapter.id, message: r.error?.message || String(r.error) });
      }
    } else mergeCandidates(candidates, r.found, seen);
  }

  if (signal?.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }

  const payload = { original, query, keyForm, candidates: [...candidates], errors };
  if (payload.candidates.length) discoveryCache.set(dk, { at: Date.now(), payload });
  return payload;
}

export async function loadCached(rawQuery, languageCode = "en", senseId = "0") {
  const { keyForm } = normalizeQuery(rawQuery);
  const key = cacheKey(keyForm, languageCode, senseId);
  const hit = await getEntry(key);
  if (!hit) return null;
  return { ...sanitizeRecordGaps(hit), fromCache: true, cacheKey: key };
}

export async function fetchAndCache(candidate, { original, query, onProgress, seq, signal } = {}) {
  const adapter = getAdapter(candidate.sourceId);
  if (!adapter) throw new Error("Unknown source adapter.");

  onProgress?.(`Loading ${adapter.name}…`);
  let lineage;
  try {
    const limit = FETCH_TIMEOUTS[adapter.id] ?? 8000;
    const run = () => {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) ctrl.abort();
      return withTimeout(
        adapter.fetchLineage(candidate, { signal: ctrl.signal }),
        limit,
        adapter.id,
        ctrl
      ).finally(() => signal?.removeEventListener("abort", onAbort));
    };
    lineage =
      adapter.id === "wiktionary" ? await withRetry(run, { retries: 1, label: "wiktionary" }) : await run();
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error(`${adapter.name} unavailable: ${e.message || e}`);
  }
  if (seq != null && seq !== searchSeq) return { cancelled: true };

  if (!lineage || !lineage.nodes?.length) {
    throw new Error(`${adapter.name} returned no etymology record for “${candidate.lemma}”.`);
  }

  const senseGloss = String(candidate.gloss || "")
    .replace(/\s+/g, " ")
    .trim();
  const sensePos = String(candidate.pos || lineage.pos || "")
    .toLowerCase()
    .trim();
  const fromSense =
    senseGloss &&
    !/^wikidata\b/i.test(senseGloss) &&
    !/^(no dedicated etymology)/i.test(senseGloss)
      ? sensePos
        ? `${sensePos} — ${senseGloss.length > 320 ? senseGloss.slice(0, 317) + "…" : senseGloss}`
        : senseGloss
      : "";

  const record = makeRecord({
    query: (query || candidate.lemma).toLowerCase(),
    queryOriginal: original || candidate.lemma,
    word: lineage.word || candidate.lemma,
    language: lineage.language || candidate.language,
    languageCode: lineage.languageCode || candidate.languageCode || "en",
    sense: lineage.sense || candidate.sense || "",
    /* Sense gloss wins so switching etymologies updates the panel header */
    definition: fromSense || lineage.definition || "",
    nodes: lineage.nodes,
    edges: lineage.edges || [],
    citations: lineage.citations || [],
    sourcesUsed: [adapter.id],
    gaps: lineage.gaps || [],
    alternatives: lineage.alternatives || [],
    primarySource: adapter.id,
  });
  record.pos = sensePos || "";

  const key = cacheKey(record.query, record.languageCode, candidate.id || record.sense || "0");
  record.cacheKey = key;
  record.candidateId = candidate.id || key;
  await putEntry(key, record);
  discoveryCache.delete(discoveryKey(record.query));
  discoveryCache.delete(`${record.query}|wikt`);
  discoveryCache.delete(`${record.query}|multi`);
  return { ...record, fromCache: false, cacheKey: key };
}

export async function searchWord(rawQuery, { onProgress, force = false } = {}) {
  const seq = ++searchSeq;
  const abort = beginSearchAbort();
  const { signal } = abort;
  const { original, query, keyForm } = normalizeQuery(rawQuery);
  if (!query) return { status: "empty" };

  /* Offline: serve cache only. Online: always rediscover so multi-etymology
   * pickers reappear every search (cache must not swallow Etymology 2…). */
  if (!navigator.onLine) {
    onProgress?.("Checking cache…");
    const cached = (await loadCached(keyForm)) || (await findCachedByQuery(keyForm));
    if (seq !== searchSeq) return { status: "cancelled" };
    if (cached) {
      return {
        status: "ready",
        record: { ...sanitizeRecordGaps(cached), fromCache: true },
      };
    }
    return {
      status: "error",
      message: "You’re offline and this word is not in the local cache.",
      retryable: false,
    };
  }

  let discovery;
  try {
    discovery = multiSource
      ? await discoverMulti(query, { onProgress, signal })
      : await discoverWiktionary(query, { onProgress, signal });
  } catch (e) {
    if (e?.name === "AbortError" || seq !== searchSeq) return { status: "cancelled" };
    const cached = (await loadCached(keyForm)) || (await findCachedByQuery(keyForm));
    if (cached) {
      return {
        status: "ready",
        record: { ...sanitizeRecordGaps(cached), fromCache: true },
        warning: e.message,
      };
    }
    return { status: "error", message: e.message || "Lookup failed.", retryable: true };
  }
  if (seq !== searchSeq || signal.aborted) return { status: "cancelled" };

  const real = discovery.candidates.filter((c) => !c.meta?.suggestion);
  const suggestions = discovery.candidates.filter((c) => c.meta?.suggestion);

  if (!real.length) {
    if (suggestions.length) {
      return {
        status: "suggestions",
        original,
        query,
        suggestions,
        errors: discovery.errors,
      };
    }
    const cached = (await loadCached(keyForm)) || (await findCachedByQuery(keyForm));
    if (cached) {
      return {
        status: "ready",
        record: { ...sanitizeRecordGaps(cached), fromCache: true },
        warning: "Live sources returned no entry; showing cache.",
      };
    }
    return {
      status: "miss",
      original,
      query,
      message: `No lexical entry found for “${query}”.`,
      errors: discovery.errors,
    };
  }

  if (real.length > 1) {
    const ordered = [
      ...real.filter((c) => c.sourceId === "wiktionary"),
      ...real.filter((c) => c.sourceId !== "wiktionary"),
    ];
    return {
      status: "candidates",
      original,
      query,
      candidates: ordered,
      errors: discovery.errors,
    };
  }

  const only = real[0];
  if (!force) {
    const senseKey = cacheKey(keyForm, only.languageCode || "en", only.id || only.sense || "0");
    const cachedSense = await getEntry(senseKey);
    if (cachedSense) {
      return {
        status: "ready",
        record: { ...sanitizeRecordGaps(cachedSense), fromCache: true },
        errors: discovery.errors,
      };
    }
  }

  try {
    let record = await fetchAndCache(only, { original, query, onProgress, seq, signal });
    if (record?.cancelled || seq !== searchSeq) return { status: "cancelled" };
    record = await supplementWithWikidata(record, { original, query, signal, onProgress });
    return { status: "ready", record, errors: discovery.errors };
  } catch (e) {
    if (e?.name === "AbortError" || seq !== searchSeq) return { status: "cancelled" };
    const cached = (await loadCached(keyForm)) || (await findCachedByQuery(keyForm));
    if (cached) {
      return {
        status: "ready",
        record: { ...sanitizeRecordGaps(cached), fromCache: true },
        warning: e.message,
      };
    }
    return { status: "error", message: e.message, retryable: true, errors: discovery.errors };
  }
}

/**
 * When Multi-source is on and Wiktionary is primary, quietly attach Wikidata
 * as a supplemental citation / alternative — never replace a richer Wiktionary chain.
 */
async function supplementWithWikidata(record, { original, query, signal, onProgress } = {}) {
  if (!multiSource || record.primarySource !== "wiktionary") return record;
  const wd = getAdapter("wikidata");
  if (!wd) return record;
  try {
    onProgress?.("Checking Wikidata lexemes…");
    const cands = await withTimeout(
      wd.searchCandidates(query || record.query, { languageTag: "en", signal }),
      ADAPTER_TIMEOUTS.wikidata,
      "wikidata"
    );
    const hit = (cands || []).find((c) => !c.meta?.suggestion);
    if (!hit) return record;
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let lineage;
    try {
      lineage = await withTimeout(
        wd.fetchLineage(hit, { signal: ctrl.signal }),
        FETCH_TIMEOUTS.wikidata,
        "wikidata",
        ctrl
      );
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
    if (!lineage?.nodes?.length) return record;
    const wiktNodes = record.nodes?.length || 0;
    const wdNodes = lineage.nodes.length;
    /* Only attach as alternative / citation — never swap a thinner graph in */
    const cit = lineage.citations?.[0];
    if (cit && !(record.citations || []).some((c) => c.url === cit.url)) {
      record.citations = [...(record.citations || []), cit];
    }
    if (!record.sourcesUsed.includes("wikidata")) {
      record.sourcesUsed = [...record.sourcesUsed, "wikidata"];
    }
    record.alternatives = [
      ...(record.alternatives || []),
      {
        sourceId: "wikidata",
        lemma: lineage.word || hit.lemma,
        nodeCount: wdNodes,
        note:
          wdNodes < wiktNodes
            ? "Wikidata lexeme graph is thinner than Wiktionary; kept as a supplemental citation only."
            : "Wikidata lexeme graph attached as a supplemental source (Wiktionary remains primary).",
      },
    ];
    if (wdNodes < wiktNodes) {
      record.gaps = [
        ...(record.gaps || []),
        "Wikidata offered a shorter structured chain — Wiktionary lineage kept as primary.",
      ];
    }
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    /* silent — Wikidata is optional */
  }
  return record;
}

export async function selectCandidate(candidate, ctx = {}) {
  const seq = ++searchSeq;
  const abort = beginSearchAbort();
  const record = await fetchAndCache(candidate, { ...ctx, seq, signal: abort.signal });
  if (record?.cancelled) return record;
  return supplementWithWikidata(record, {
    original: ctx.original,
    query: ctx.query || candidate.lemma,
    signal: abort.signal,
    onProgress: ctx.onProgress,
  });
}
