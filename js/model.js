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
  inferred_geo: "inferred_geo",
});

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
  epistemic = EPISTEMIC.attested,
  note = "",
  citationIds = [],
}) {
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
    n.term = n.form;
    n.lang = n.language;
    n.region = n.region || regionOf(n.languageCode) || "";
    n.place = n.region || n.language;
    n.status = n.epistemic === EPISTEMIC.inferred_geo ? "uncertain" : n.epistemic;
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
    for (let j = ai; j < bi; j++) {
      const e = edgeByPair.get(`${ordered[j].id}|${ordered[j + 1].id}`);
      if (!e) continue;
      epistemic = weakerEpistemic(epistemic, e.epistemic || EPISTEMIC.attested);
      if (e.type && e.type !== REL_TYPES.unknown) type = e.type;
      if (e.schematic !== false) schematic = true;
    }
    arcs.push({
      from: a,
      to: b,
      epistemic,
      type,
      schematic: schematic || a.geoBasis !== GEO_BASIS.documented_place,
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
      color: b.color || a.color,
    });
  }

  return { nodes: geoNodes, arcs, hasGeo: geoNodes.length >= 2 };
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
  inferred_geo: "Inferred geographic association",
};
