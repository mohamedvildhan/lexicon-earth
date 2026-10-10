const API = "https://en.wiktionary.org/w/api.php";
const CACHE_TTL = 2 * 60 * 1000;
const cache = new Map();

let abortCtrl = null;

/**
 * Fast Wiktionary open-search suggestions (typeahead).
 * @returns {Promise<string[]>}
 */
export async function fetchOpenSearch(query, { limit = 6, signal } = {}) {
  const q = String(query || "").trim();
  if (q.length < 2) return [];

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
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < minChars) {
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
      if (q.length >= minChars) return run(q);
      onClear?.();
    },
  };
}
