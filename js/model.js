/** Compact normalized model for Lexicon Earth lineages. */

import { regionOf } from "./languages.js";

export const REL_TYPES = Object.freeze({
  inheritance: "inheritance",
  borrowing: "borrowing",
  derivation: "derivation",
  compound: "compound",
  calque: "calque",
  unknown: "unknown",
  alternative: "alternative",
});

export const EPISTEMIC = Object.freeze({
  attested: "attested",
  reconstructed: "reconstructed",
  disputed: "disputed",
  uncertain: "uncertain",
  unknown: "unknown",
  inferred_geo: "inferred_geo",
});

/** Strip Wiktionary anchors, wiki-links, and underscores from forms. */
export function cleanForm(form) {
  return String(form ?? "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/\{\{(?:m|l|mention|link)\|[^|}]*\|([^|}]*)[^}]*\}\}/gi, "$1")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/#[^\s]*/g, "")
    .replace(/_/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isUnrecordedForm(n) {
  const f = cleanForm(n?.form);
  return !f || f === "—" || f === "-" || f === "…" || f === "?";
}

/** True when a form is largely non-Latin script (Devanagari, Thaana, CJK, …). */
export function needsRomanization(form) {
  const t = cleanForm(form).replace(/^\*/, "");
  if (!t || t === "—" || t === "-" || t === "…" || t === "?") return false;
  try {
    const letters = [...t].filter((ch) => /\p{L}/u.test(ch));
    if (!letters.length) return false;
    const nonLatin = letters.filter((ch) => !/\p{Script=Latin}/u.test(ch));
    return nonLatin.length / letters.length >= 0.25;
  } catch {
    return /[^\u0000-\u024F\s*'’.\-]/.test(t);
  }
}

/** Strip refs, comments, and HTML from any user-visible string. */
export function stripDisplayText(s) {
  return String(s ?? "")
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref\b[^>]*\/>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Drop scraped/broken wikitext gap lines left in older caches. */
export function isBadGapText(s) {
  const t = String(s || "").trim();
  if (!t) return true;
  if (/extracted summary|not a quotation/i.test(t)) return true;
  if (/,\s*from\s*,|from\s*,\s*from/i.test(t)) return true;
  if (/from\s+,/.test(t) && (t.match(/from\s*,/g) || []).length >= 2) return true;
  return false;
}

export function sanitizeRecordGaps(record) {
  if (!record || !Array.isArray(record.gaps)) return record;
  return { ...record, gaps: record.gaps.filter((g) => !isBadGapText(g)) };
}

/** Lineage chain summary from parsed nodes (not scraped wikitext). */
export function buildLineageSummary(record) {
  const ordered = topologicalOrder(record.nodes || [], record.edges || []);
  const parts = ordered
    .map((n) => (isUnrecordedForm(n) ? null : cleanForm(n.form)))
    .filter(Boolean);
  if (!parts.length) return "";
  let text = parts.join(" → ");
  const flagged = countUncertainLinks(record);
  if (flagged > 0) {
    text += `. ${flagged} link${flagged === 1 ? "" : "s"} disputed or uncertain`;
  }
  return text;
}

const HEDGE_RE =
  /\b(possibly|perhaps|probably|maybe|uncertain|disputed|unclear|debated|or from)\b/i;

/** Hedged / non-attested edges + unnamed nodes. */
export function countUncertainLinks(record) {
  let n = 0;
  const seen = new Set();
  for (const e of record.edges || []) {
    const hedged =
      (e.epistemic && e.epistemic !== EPISTEMIC.attested) ||
      HEDGE_RE.test(e.note || "") ||
      HEDGE_RE.test(e.label || "");
    if (hedged) {
      const key = `${e.fromId}|${e.toId}`;
      if (!seen.has(key)) {
        seen.add(key);
        n += 1;
      }
    }
  }
  for (const node of record.nodes || []) {
    if (isUnrecordedForm(node)) n += 1;
  }
  return n;
}

/** Span from earliest dated, named node → now (language period, not word date). */
export function approxLanguageSpan(nodes) {
  const dated = (nodes || []).filter((n) => !isUnrecordedForm(n) && n.yearStart != null);
  if (!dated.length) return null;
  const earliest = Math.min(...dated.map((n) => n.yearStart));
  const years = Math.max(0, new Date().getFullYear() - earliest);
  return { years, earliest };
}

export const GEO_BASIS = Object.freeze({
  language_heartland: "language_heartland",
  documented_place: "documented_place",
  inferred: "inferred",
  schematic: "schematic",
  none: "none",
});

let _seq = 0;
export function nid(prefix = "n") {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq}`;
}

export function makeCitation({
  title,
  url,
  dataset,
  entry,
  retrievedAt = new Date().toISOString(),
  license,
  attribution,
  transform = null,
}) {
  return {
    id: nid("src"),
    title: title || "Unknown source",
    url: url || null,
    dataset: dataset || null,
    entry: entry || null,
    retrievedAt,
    license: license || null,
    attribution: attribution || null,
    transform,
  };
}

export function makeNode({
  form,
  language,
  languageCode = null,
  region = "",
  gloss = "",
  transliteration = "",
  yearStart = null,
  yearEnd = null,
  lat = null,
  lon = null,
  geoBasis = GEO_BASIS.none,
  geoConfidence = null,
  epistemic = EPISTEMIC.attested,
  note = "",
  citationIds = [],
}) {
  const conf =
    geoConfidence ||
    (lat == null || lon == null
      ? "unavailable"
      : epistemic === EPISTEMIC.reconstructed
        ? "uncertain"
        : "precise");
  return {
    id: nid("form"),
    form,
    language,
    languageCode,
    region: region || "",
    gloss,
    transliteration,
    yearStart,
    yearEnd,
    lat,
    lon,
    geoBasis,
    geoConfidence: conf,
    epistemic,
    note,
    citationIds: [...citationIds],
  };
}

export function makeEdge({
  fromId,
  toId,
  type = REL_TYPES.unknown,
  epistemic = EPISTEMIC.attested,
  dateApprox = null,
  note = "",
  citationIds = [],
  schematic = true,
  bridged = false,
}) {
  return {
    id: nid("rel"),
    fromId,
    toId,
    type,
    epistemic,
    dateApprox,
    note,
    citationIds: [...citationIds],
    schematic,
    bridged: !!bridged,
  };
}

export function makeRecord({
  query,
  queryOriginal,
  word,
  language = "English",
  languageCode = "en",
  sense = "",
  definition = "",
  nodes = [],
  edges = [],
  citations = [],
  sourcesUsed = [],
  gaps = [],
  alternatives = [],
  primarySource = null,
}) {
  return {
    id: nid("entry"),
    schemaVersion: 2,
    query,
    queryOriginal,
    word,
    language,
    languageCode,
    sense,
    definition,
    nodes,
    edges,
    citations,
    sourcesUsed,
    gaps,
    alternatives,
    primarySource,
    cachedAt: Date.now(),
  };
}

/** Prefer the weaker epistemic status when bridging across hops. */
function weakerEpistemic(a, b) {
  const rank = {
    [EPISTEMIC.attested]: 0,
    [EPISTEMIC.inferred_geo]: 1,
    [EPISTEMIC.uncertain]: 2,
    [EPISTEMIC.reconstructed]: 3,
    [EPISTEMIC.disputed]: 4,
  };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}

/** Build display trajectory: geo-mappable nodes + edge-derived connections. */
export function toGlobePayload(record) {
  const byId = Object.fromEntries(record.nodes.map((n) => [n.id, n]));
  /* Chronological order so colors / bridging follow the lineage, not store order */
  const ordered = topologicalOrder(record.nodes, record.edges);
  const geoNodes = ordered.filter((n) => n.lat != null && n.lon != null);
  const PAL = ["#e04530", "#ef9a2e", "#2fad8a", "#3b8fd9", "#6a52d4"];
  geoNodes.forEach((n, i) => {
    n.idx = i + 1;
    n.color = PAL[geoNodes.length < 2 ? 4 : Math.round((i / (geoNodes.length - 1)) * (PAL.length - 1))];
    n.term = isUnrecordedForm(n) ? "Unrecorded form" : cleanForm(n.form);
    n.lang = n.language;
    n.region = n.region || regionOf(n.languageCode) || "";
    n.place = n.region || n.language;
    n.status = n.epistemic === EPISTEMIC.inferred_geo ? "uncertain" : n.epistemic;
    n.geoConfidence = n.geoConfidence || (n.lat == null ? "unavailable" : "precise");
    n.geo = true;
  });

  /*
   * Bridge unmapped hops: edges often go A(geo)→B(no geo)→C(geo). Direct-edge
   * arcs would skip those links and leave Sanskrit/Arabic/… disconnected.
   * Connect consecutive geo nodes along the ordered lineage instead.
   */
  const edgeByPair = new Map();
  for (const e of record.edges) {
    edgeByPair.set(`${e.fromId}|${e.toId}`, e);
  }

  const arcs = [];
  for (let i = 0; i < geoNodes.length - 1; i++) {
    const a = geoNodes[i];
    const b = geoNodes[i + 1];
    const ai = ordered.indexOf(a);
    const bi = ordered.indexOf(b);
    let epistemic = EPISTEMIC.attested;
    let type = REL_TYPES.unknown;
    let schematic = true;
    let edgeBridged = false;
    for (let j = ai; j < bi; j++) {
      const e = edgeByPair.get(`${ordered[j].id}|${ordered[j + 1].id}`);
      if (!e) continue;
      epistemic = weakerEpistemic(epistemic, e.epistemic || EPISTEMIC.attested);
      if (e.type && e.type !== REL_TYPES.unknown) type = e.type;
      if (e.schematic !== false) schematic = true;
      if (e.bridged) edgeBridged = true;
    }
    const bridged = bi - ai > 1 || edgeBridged;
    arcs.push({
      from: a,
      to: b,
      epistemic,
      type,
      schematic: schematic || a.geoBasis !== GEO_BASIS.documented_place,
      bridged,
      color: b.color || a.color,
    });
  }

  /* Fallback: any remaining direct geo↔geo edges not already covered */
  const covered = new Set(arcs.map((arc) => `${arc.from.id}|${arc.to.id}`));
  for (const e of record.edges) {
    const a = byId[e.fromId];
    const b = byId[e.toId];
    if (!a || !b || a.lat == null || b.lat == null) continue;
    const key = `${a.id}|${b.id}`;
    if (covered.has(key)) continue;
    arcs.push({
      from: a,
      to: b,
      epistemic: e.epistemic,
      type: e.type,
      schematic: e.schematic !== false || a.geoBasis !== GEO_BASIS.documented_place,
      bridged: !!e.bridged,
      color: b.color || a.color,
    });
  }

  return {
    nodes: geoNodes,
    arcs,
    /* At least one pin is enough to rest the camera; paths need 2+ */
    hasGeo: geoNodes.length >= 1,
    hasPath: geoNodes.length >= 2,
  };
}

export function topologicalOrder(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id));
  const indeg = Object.fromEntries([...ids].map((id) => [id, 0]));
  const out = Object.fromEntries([...ids].map((id) => [id, []]));
  for (const e of edges) {
    if (!ids.has(e.fromId) || !ids.has(e.toId)) continue;
    out[e.fromId].push(e.toId);
    indeg[e.toId] += 1;
  }
  const q = [...ids].filter((id) => indeg[id] === 0);
  const order = [];
  while (q.length) {
    const id = q.shift();
    order.push(id);
    for (const t of out[id]) {
      indeg[t] -= 1;
      if (indeg[t] === 0) q.push(t);
    }
  }
  if (order.length < ids.size) {
    /* cycle — append remaining in original order */
    for (const n of nodes) if (!order.includes(n.id)) order.push(n.id);
  }
  return order.map((id) => nodes.find((n) => n.id === id)).filter(Boolean);
}

export const STATUS_LABEL = {
  attested: "Attested",
  reconstructed: "Reconstructed",
  disputed: "Disputed",
  uncertain: "Uncertain",
  unknown: "Unknown",
  inferred_geo: "Inferred geographic association",
};
