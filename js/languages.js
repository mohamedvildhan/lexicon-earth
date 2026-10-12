/**
 * Language heartlands for Lexicon Earth.
 * Atlas built by scripts/build-language-atlas.mjs (Wiktionary + Glottolog + overrides).
 * Positions are language heartlands / centroids — not literal travel routes.
 */

const atlasUrl = new URL("../data/languages-atlas.json", import.meta.url);

async function loadAtlas() {
  try {
    const r = await fetch(atlasUrl);
    if (r.ok) return r.json();
  } catch {
    /* Node may reject file: fetch — fall through */
  }
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  return JSON.parse(readFileSync(fileURLToPath(atlasUrl), "utf8"));
}

const atlas = await loadAtlas();

export const ATLAS_META = atlas.meta || {};
export const AL = Object.freeze({ ...(atlas.aliases || {}) });

/** @deprecated Prefer lookupLanguage — kept as a compact array view for legacy callers */
export const LG = (() => {
  const out = {};
  for (const [code, e] of Object.entries(atlas.languages || {})) {
    if (e.lat == null || e.lon == null) continue;
    out[code] = [e.name, e.lat, e.lon, e.yearStart ?? null, e.yearEnd ?? null, e.note || ""];
  }
  return out;
})();

export const REGION = (() => {
  const out = {};
  for (const [code, e] of Object.entries(atlas.languages || {})) {
    if (e.region) out[code] = e.region;
  }
  return out;
})();

export const GEO_CONFIDENCE = Object.freeze({
  precise: "precise",
  approximate: "approximate",
  uncertain: "uncertain",
  period_only: "period_only",
  unavailable: "unavailable",
});

export const GEO_DISCLAIMER = Object.freeze({
  precise: "",
  approximate: "Position approximate (family/region centroid).",
  uncertain: "Reconstructed homeland — scholarly estimate, debated.",
  period_only: "Shown at the parent language’s region; period, not a distinct place.",
  unavailable: "No mapped location for this stage.",
  ...(atlas.meta?.disclaimers || {}),
});

export const PAL = ["#b54b3d", "#c98548", "#6d8d79", "#678ba0", "#354e69"];

/** Resolve code through aliases. */
export function resolveCode(code) {
  if (!code) return "";
  return AL[code] || code;
}

const NAME_TO_CODE = (() => {
  const m = new Map();
  for (const [code, e] of Object.entries(atlas.languages || {})) {
    if (e?.name) m.set(String(e.name).toLowerCase(), code);
  }
  /* Common Wiktionary L2 labels that may differ slightly */
  const extra = {
    english: "en",
    italian: "it",
    french: "fr",
    german: "de",
    spanish: "es",
    portuguese: "pt",
    latin: "la",
    dutch: "nl",
    russian: "ru",
    arabic: "ar",
    persian: "fa",
    greek: "el",
    "ancient greek": "grc",
    chinese: "zh",
    japanese: "ja",
    sanskrit: "sa",
    "middle english": "enm",
    "old english": "ang",
    "old french": "fro",
    "middle french": "frm",
    "old italian": "roa-oit",
  };
  for (const [k, v] of Object.entries(extra)) {
    if (!m.has(k)) m.set(k, v);
  }
  return m;
})();

/** Resolve a Wiktionary L2 language heading (e.g. "Italian") to an atlas entry. */
export function lookupLanguageByName(name) {
  const key = String(name || "")
    .toLowerCase()
    .trim();
  if (!key) return lookupLanguage("");
  const code = NAME_TO_CODE.get(key);
  if (code) return lookupLanguage(code);
  return lookupLanguage(key);
}

/** Full atlas entry for a language / etymology-language code. */
export function lookupLanguage(code) {
  const c = resolveCode(code);
  const e = atlas.languages?.[c];
  if (!e) {
    return {
      code: c,
      name: c,
      lat: null,
      lon: null,
      yearStart: null,
      yearEnd: null,
      region: "",
      note: GEO_DISCLAIMER.unavailable,
      geoConfidence: GEO_CONFIDENCE.unavailable,
      source: "unknown",
    };
  }
  const conf = e.geoConfidence || (e.lat != null ? GEO_CONFIDENCE.precise : GEO_CONFIDENCE.unavailable);
  return {
    code: c,
    name: e.name || c,
    lat: e.lat ?? null,
    lon: e.lon ?? null,
    yearStart: e.yearStart ?? null,
    yearEnd: e.yearEnd ?? null,
    region: e.region || "",
    note: e.note || GEO_DISCLAIMER[conf] || "",
    geoConfidence: conf,
    source: e.source || "",
    parent: e.parent || null,
    glottocode: e.glottocode || null,
  };
}

export function yearLabel(y) {
  return y < 0 ? `${-y} BCE` : `${y} CE`;
}

export function period(a, b) {
  if (a == null) return "";
  if (b == null) return `from c. ${yearLabel(a)}`;
  return `c. ${yearLabel(a)} – ${yearLabel(b)}`;
}

/** Resolve origin nation / civilization for a language code. */
export function regionOf(code) {
  return lookupLanguage(code).region || "";
}

export function atlasStats() {
  return ATLAS_META.stats || { total: 0, withCoords: 0, byConfidence: {} };
}
