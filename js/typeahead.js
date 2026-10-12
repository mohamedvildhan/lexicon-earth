const API = "https://en.wiktionary.org/w/api.php";
const CACHE_TTL = 2 * 60 * 1000;
const cache = new Map();

let abortCtrl = null;

/**
 * Fast Wiktionary open-search suggestions (typeahead).
 * @returns {Promise<string[]>}
 */
export async function fetchOpenSearch(query, { limit = 6, signal } = {}) {
  const q = String(query || "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
    .normalize("NFC")
    .trim();
  /* Allow 1 char for non-Latin scripts (Thaana, CJK, Arabic, …) */
  const nonLatin = /[^\u0000-\u00ff]/.test(q);
  if (q.length < (nonLatin ? 1 : 2)) return [];

  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.list;

  const url =
    `${API}?action=opensearch&search=${encodeURIComponent(q)}` +
    `&limit=${limit}&namespace=0&format=json&origin=*`;

  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`opensearch ${r.status}`);
  const data = await r.json();
  const list = Array.isArray(data?.[1]) ? data[1] : [];
  if (!signal?.aborted) cache.set(key, { at: Date.now(), list });
  return list;
}

/**
 * Debounced typeahead controller.
 * @param {(q: string) => void} onIdle optional
 */
function minCharsFor(q) {
  return /[^\u0000-\u00ff]/.test(q) ? 1 : 2;
}

export function createTypeahead({
  input,
  onSuggestions,
  onClear,
  delayMs = 180,
  minChars = 2,
} = {}) {
  let timer = null;
  let lastIssued = "";

  const run = async (q) => {
    lastIssued = q;
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();
    const { signal } = abortCtrl;
    try {
      const list = await fetchOpenSearch(q, { signal });
      if (lastIssued !== q) return;
      onSuggestions?.(list, q);
    } catch (e) {
      if (e?.name === "AbortError") return;
      if (lastIssued === q) onSuggestions?.([], q);
    }
  };

  const onInput = () => {
    const q = input.value
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
      .normalize("NFC")
      .trim();
    clearTimeout(timer);
    const need = Math.min(minChars, minCharsFor(q));
    if (q.length < need) {
      if (abortCtrl) abortCtrl.abort();
      onClear?.();
      return;
    }
    timer = setTimeout(() => run(q), delayMs);
  };

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      clearTimeout(timer);
      if (abortCtrl) abortCtrl.abort();
      onClear?.();
    }
  });

  return {
    cancel() {
      clearTimeout(timer);
      if (abortCtrl) abortCtrl.abort();
    },
    flush(q = input.value.trim()) {
      clearTimeout(timer);
      const cleaned = String(q || "")
        .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
        .normalize("NFC")
        .trim();
      if (cleaned.length >= minCharsFor(cleaned)) return run(cleaned);
      onClear?.();
    },
  };
}
