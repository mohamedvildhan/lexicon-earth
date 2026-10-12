import { SourceAdapter } from "./base.js";
import {
  makeCitation,
  makeNode,
  makeEdge,
  REL_TYPES,
  EPISTEMIC,
  GEO_BASIS,
} from "../model.js";
import { LG, AL, period, regionOf } from "../languages.js";

const API = "https://en.wiktionary.org/w/api.php";
const REST = "https://en.wiktionary.org/api/rest_v1/page/definition/";

const ANC = /^(inh|inherited|bor|borrowed|der|derived|lbor|slbor|obor|ubor|calque|cal|pcal|psm|sl|clq|bor\+|inh\+|der\+)$/;
const AFX = /^(af|affix|suffix|suf|prefix|pre|compound|com|confix|con|blend|bl)$/;
const FLAG = /\b(possibly|perhaps|probably|maybe|uncertain|disputed|unclear|debated|alternatively|conjectur\w*|speculat\w*|or from)\b/i;

const TEMPLATE_TO_REL = {
  inh: REL_TYPES.inheritance,
  inherited: REL_TYPES.inheritance,
  "inh+": REL_TYPES.inheritance,
  bor: REL_TYPES.borrowing,
  borrowed: REL_TYPES.borrowing,
  "bor+": REL_TYPES.borrowing,
  lbor: REL_TYPES.borrowing,
  der: REL_TYPES.derivation,
  derived: REL_TYPES.derivation,
  "der+": REL_TYPES.derivation,
  calque: REL_TYPES.calque,
  cal: REL_TYPES.calque,
  etyl: REL_TYPES.unknown,
};

async function js(url, { signal } = {}) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`Wiktionary HTTP ${r.status}`);
  return r.json();
}

function clean(t) {
  return String(t || "")
    /* Expand term-bearing templates before wiping the rest */
    .replace(/\{\{(?:m|l|mention|link)\|[^|}]*\|([^|}]*)[^}]*\}\}/gi, "$1")
    .replace(/\{\{(?:der|inh|bor|inherited|borrowed|derived|lbor|calque|cal)\|[^|}]*\|[^|}]*\|([^|}]*)[^}]*\}\}/gi, "$1")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "")
    .replace(/<ref\b[^>]*\/>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseEty(wt) {
  const T = [];
  const re = /\{\{([^{}]*)\}\}/g;
  let m;
  while ((m = re.exec(wt))) {
    const p = m[1].split("|").map((x) => x.trim());
    T.push({ nm: p[0].toLowerCase(), p, s: m.index, e: m.index + m[0].length });
  }
  const pos = (p) => p.slice(1).filter((x) => !/^[\w-]{1,12}=/.test(x));
  const nam = (p) => {
    const o = {};
    p.slice(1).forEach((x) => {
      const k = x.match(/^([\w-]{1,12})=(.*)$/);
      if (k) o[k[1]] = k[2];
    });
    return o;
  };
  const anc = [];
  let prev = 0;
  let formed = null;
  T.forEach((t, i) => {
    if (AFX.test(t.nm) && !formed) {
      const P = pos(t.p).slice(1).filter(Boolean);
      if (P.length > 1) formed = P.map((x) => x.replace(/^[\w-]+:/, "")).join(" + ");
    }
    if (!(ANC.test(t.nm) || t.nm === "etyl")) return;
    const P = pos(t.p);
    const N = nam(t.p);
    let code;
    let term;
    let alt;
    if (t.nm === "etyl") {
      code = P[0];
      const nx = T[i + 1];
      if (nx && /^(m|l|mention|link)$/.test(nx.nm) && nx.s - t.e < 40) {
        const Q = pos(nx.p);
        const QN = nam(nx.p);
        term = Q[1];
        alt = Q[2];
        N.t = N.t || QN.t;
        N.tr = N.tr || QN.tr;
      }
    } else {
      code = P[1];
      term = P[2];
      alt = P[3];
    }
    if (!code) return;
    const conn = wt.slice(prev, t.s);
    prev = t.e;
    const last = anc[anc.length - 1];
    if (last && last.code === code && last.term === term) return;
    anc.push({
      code,
      term: term === "-" ? "" : term,
      alt,
      gloss: N.t || N.gloss || P[4] || "",
      tr: N.tr || "",
      dis: FLAG.test(conn),
      conn,
      rel: TEMPLATE_TO_REL[t.nm] || REL_TYPES.unknown,
      template: t.nm,
    });
  });
  const unknown =
    /\{\{\s*(unk|unknown|uncertain|rfe|unknown-etym)\b/i.test(wt) ||
    /(origin|etymology) (is )?(unknown|uncertain|obscure)|(unknown|uncertain|obscure) (origin|etymology)/i.test(
      clean(wt)
    );
  return { anc, formed, unknown, extractedText: "" };
}

function geoFor(code) {
  const c = AL[code] || code;
  const L = LG[c];
  if (!L) {
    return {
      language: c,
      languageCode: c,
      region: "",
      lat: null,
      lon: null,
      era: "",
      y: null,
      note: "Language region not mapped.",
      geoBasis: GEO_BASIS.none,
    };
  }
  return {
    language: L[0],
    languageCode: c,
    region: regionOf(c),
    lat: L[1],
    lon: L[2],
    era: period(L[3], L[4]),
    y: L[3],
    yearEnd: L[4],
    note: L[5] || "",
    geoBasis: GEO_BASIS.language_heartland,
  };
}

function htmlToText(html) {
  return new DOMParser().parseFromString(html || "", "text/html").body.textContent.trim();
}

async function fetchDefinition(title, { signal } = {}) {
  try {
    const d = await js(REST + encodeURIComponent(title), { signal });
    for (const g of d.en || []) {
      for (const item of g.definitions || []) {
        const t = htmlToText(item.definition);
        if (t) return `${(g.partOfSpeech || "").toLowerCase()} — ${t}`;
      }
    }
  } catch (e) {
    if (e?.name === "AbortError") throw e;
  }
  return "";
}

/** All English REST senses (POS + gloss), ordered as Wiktionary returns them. */
async function fetchDefinitionList(title, { signal } = {}) {
  try {
    const d = await js(REST + encodeURIComponent(title), { signal });
    const out = [];
    for (const g of d.en || []) {
      const pos = g.partOfSpeech || "";
      for (const item of g.definitions || []) {
        const t = htmlToText(item.definition);
        if (t) out.push({ pos, gloss: t });
      }
    }
    return out;
  } catch (e) {
    if (e?.name === "AbortError") throw e;
  }
  return [];
}

/** First POS heading + definition line from an etymology block (wikitext). */
function sensePreviewFromSlice(slice) {
  const raw = String(slice || "");
  const posM = raw.match(
    /^(={3,5})\s*(Noun|Verb|Adjective|Adverb|Proper noun|Interjection|Pronoun|Determiner|Numeral|Particle|Preposition|Conjunction|Symbol|Suffix|Prefix)\s*\1\s*$/im
  );
  const pos = posM ? posM[2] : "";
  const defM = raw.match(/^#\s*(?!\*:|:|\*)(.+)$/m);
  let gloss = "";
  if (defM) {
    gloss = clean(defM[1])
      .replace(/\{\{[^}]*\}\}/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (gloss.length > 140) gloss = gloss.slice(0, 137) + "…";
  return { pos, gloss };
}

/**
 * Slice English L2 sections and Etymology subsections from full-page wikitext.
 * @returns {{ title: string, ets: Array<{ line: string, wikitext: string, sectionIndex: number|null }> } | null}
 */
function extractEnglishEtymologies(fullWt, sections) {
  if (!fullWt) return null;
  const enMatch = fullWt.match(/^==\s*English\s*==\s*$/m);
  if (!enMatch) return null;
  const enStart = enMatch.index + enMatch[0].length;
  const nextL2 = fullWt.slice(enStart).search(/^==\s*[^=].*?==\s*$/m);
  const enBody = nextL2 >= 0 ? fullWt.slice(enStart, enStart + nextL2) : fullWt.slice(enStart);

  const etyRe = /^(={3,4})\s*(Etymology(?:\s+\d+)?)\s*\1\s*$/gm;
  const hits = [];
  let m;
  while ((m = etyRe.exec(enBody))) {
    hits.push({ line: m[2], index: m.index, end: m.index + m[0].length });
  }

  const enSec = (sections || []).find((x) => x.line === "English" && x.toclevel === 1);
  const etySecs = enSec
    ? (sections || []).filter((x) => /^Etymology( \d+)?$/.test(x.line) && String(x.number).startsWith(enSec.number + "."))
    : [];

  if (!hits.length) {
    return {
      ets: [
        {
          line: "English entry",
          wikitext: "",
          sectionIndex: null,
        },
      ],
    };
  }

  return {
    ets: hits.map((h, i) => {
      const next = hits[i + 1];
      const sliceEnd = next ? next.index : enBody.length;
      const full = enBody.slice(h.end, sliceEnd).replace(/^\s+/, "");
      /* Etymology templates only — stop before POS / usage headings */
      const body = full.split(/\n={3,5}[^=]/)[0];
      const preview = sensePreviewFromSlice(full);
      const sec = etySecs[i];
      return {
        line: h.line,
        wikitext: body.trim(),
        sectionIndex: sec?.index ?? null,
        pos: preview.pos,
        gloss: preview.gloss,
      };
    }),
  };
}

function buildGraph(title, pe, citation) {
  const nodes = [];
  const edges = [];
  const citationIds = [citation.id];

  const anc = [...pe.anc].reverse();
  let prevId = null;

  for (const a of anc) {
    const g = geoFor(a.code);
    const rawTerm = (a.alt || a.term || "").replace(/#[^\s]*/g, "").replace(/_/g, " ").trim();
    const unrecorded = !rawTerm || rawTerm === "-" || rawTerm === "—";
    const pro = !unrecorded && (/-pro$/.test(g.languageCode) || /^\*/.test(rawTerm));
    let form = unrecorded ? "—" : rawTerm;
    if (pro && form[0] !== "*") form = "*" + form;
    const epistemic = unrecorded
      ? EPISTEMIC.unknown
      : a.dis
        ? EPISTEMIC.disputed
        : pro
          ? EPISTEMIC.reconstructed
          : EPISTEMIC.attested;
    const node = makeNode({
      form,
      language: g.language,
      languageCode: g.languageCode,
      region: g.region || "",
      gloss: (a.gloss || "").replace(/#[^\s]*/g, "").replace(/_/g, " "),
      transliteration: a.tr,
      yearStart: unrecorded ? null : g.y,
      yearEnd: unrecorded ? null : g.yearEnd ?? null,
      lat: g.lat,
      lon: g.lon,
      geoBasis: g.lat != null ? GEO_BASIS.language_heartland : GEO_BASIS.none,
      epistemic,
      note: a.dis ? "Hedged wording in Wiktionary extraction." : "",
      citationIds,
    });
    nodes.push(node);
    if (prevId) {
      edges.push(
        makeEdge({
          fromId: prevId,
          toId: node.id,
          type: a.rel || REL_TYPES.unknown,
          epistemic,
          note: `Parsed from Wiktionary template {{${a.template}}}. Extracted, not a verified structured claim.`,
          citationIds,
          schematic: true,
        })
      );
    }
    prevId = node.id;
  }

  const en = geoFor("en");
  const head = makeNode({
    form: title,
    language: "English",
    languageCode: "en",
    region: en.region || "England",
    yearStart: en.y,
    lat: en.lat,
    lon: en.lon,
    geoBasis: GEO_BASIS.language_heartland,
    epistemic: EPISTEMIC.attested,
    note: "",
    citationIds,
  });
  nodes.push(head);
  if (prevId) {
    const lastAnc = anc[anc.length - 1];
    edges.push(
      makeEdge({
        fromId: prevId,
        toId: head.id,
        type: lastAnc?.rel || REL_TYPES.unknown,
        epistemic: lastAnc?.dis ? EPISTEMIC.disputed : EPISTEMIC.attested,
        note: "Parsed from Wiktionary etymology section.",
        citationIds,
        schematic: true,
      })
    );
  }

  const gaps = [];
  if (pe.formed) gaps.push(`Formed from: ${pe.formed}.`);
  if (!anc.length) gaps.push("No reliable etymology templates found for this entry.");
  else if (pe.unknown) gaps.push("Earlier origins are uncertain or unrecorded on Wiktionary.");

  return { nodes, edges, gaps };
}

export class WiktionaryAdapter extends SourceAdapter {
  constructor() {
    super({
      id: "wiktionary",
      name: "English Wiktionary",
      license: "CC BY-SA 4.0",
      attribution: "Wiktionary contributors",
      homepage: "https://en.wiktionary.org/",
    });
  }

  async searchCandidates(query, opts = {}) {
    const q = String(query || "").trim();
    if (!q) return [];
    const { signal } = opts;
    const out = [];
    let title = null;
    let fullWt = null;
    let secs = null;

    /*
     * Try lowercase, original, then Title Case — Wiktionary lemmas are often
     * capitalized (Gaia, Earth) while users type lowercase.
     */
    const titled = q.charAt(0).toUpperCase() + q.slice(1).toLowerCase();
    const variants = [...new Set([q.toLowerCase(), q, titled].filter(Boolean))];
    for (const t of variants) {
      try {
        const d = await js(
          `${API}?action=parse&page=${encodeURIComponent(t)}&prop=wikitext|sections&format=json&formatversion=2&redirects=1&origin=*`,
          { signal }
        );
        if (d.parse?.sections?.some((x) => x.line === "English" && x.toclevel === 1)) {
          title = d.parse.title;
          fullWt = typeof d.parse.wikitext === "string" ? d.parse.wikitext : d.parse.wikitext?.["*"] || "";
          secs = d.parse.sections;
          break;
        }
      } catch (e) {
        if (e?.name === "AbortError") throw e;
      }
    }

    if (!title) {
      try {
        const sugg =
          (await js(`${API}?action=opensearch&search=${encodeURIComponent(q)}&limit=8&format=json&origin=*`, { signal }))[1] ||
          [];
        const qLower = q.toLowerCase();
        const seen = new Set();
        const useful = [];
        for (const s of sugg) {
          const key = String(s).toLowerCase();
          if (!key || seen.has(key)) continue;
          /* Skip the failed query itself — same spelling won't resolve */
          if (key === qLower) continue;
          seen.add(key);
          useful.push(s);
          if (useful.length >= 5) break;
        }
        return useful.map((s) => ({
          id: `wikt:suggest:${s}`,
          lemma: s,
          language: "English",
          languageCode: "en",
          sense: "suggestion",
          gloss: "Suggested spelling from Wiktionary open search",
          sourceId: this.id,
          meta: { suggestion: true },
        }));
      } catch (e) {
        if (e?.name === "AbortError") throw e;
        return [];
      }
    }

    const extracted = extractEnglishEtymologies(fullWt, secs);
    const ets = extracted?.ets || [];

    if (!ets.length || (ets.length === 1 && !ets[0].wikitext && ets[0].line === "English entry")) {
      const defs = await fetchDefinitionList(title, { signal });
      const top = defs[0];
      out.push({
        id: `wikt:${title}:0`,
        lemma: title,
        language: "English",
        languageCode: "en",
        sense: "English entry",
        pos: top?.pos || "",
        gloss: top ? top.gloss : "No dedicated etymology section",
        sourceId: this.id,
        meta: { title, etyIndex: 0, sectionIndex: null, wikitext: "" },
      });
      return out;
    }

    /* Fill missing previews from REST when wikitext has no POS block yet (common for Ety 1) */
    let restDefs = null;
    const needRest = ets.some((sec) => !sec.gloss);
    if (needRest) restDefs = await fetchDefinitionList(title, { signal });

    ets.forEach((sec, i) => {
      let pos = sec.pos || "";
      let gloss = sec.gloss || "";
      if (!gloss && restDefs?.length) {
        /* Heuristic: map etymology n → nth distinct POS group’s first gloss */
        const byPos = [];
        let lastPos = null;
        for (const d of restDefs) {
          if (d.pos !== lastPos) {
            byPos.push(d);
            lastPos = d.pos;
          }
        }
        const hit = byPos[i] || restDefs[i] || restDefs[0];
        if (hit) {
          pos = pos || hit.pos || "";
          gloss = hit.gloss;
        }
      }
      if (gloss.length > 140) gloss = gloss.slice(0, 137) + "…";
      out.push({
        id: `wikt:${title}:${i}`,
        lemma: title,
        language: "English",
        languageCode: "en",
        sense: sec.line,
        pos,
        gloss: gloss || (ets.length > 1 ? sec.line : "English entry"),
        sourceId: this.id,
        meta: {
          title,
          etyIndex: i,
          sectionIndex: sec.sectionIndex,
          wikitext: sec.wikitext || "",
        },
      });
    });
    return out;
  }

  async fetchLineage(candidate, opts = {}) {
    if (candidate.meta?.suggestion) return null;
    const { signal } = opts;
    const title = candidate.meta?.title || candidate.lemma;
    const sectionIndex = candidate.meta?.sectionIndex;

    const citation = makeCitation({
      title: `Wiktionary: ${title}`,
      url: `https://en.wiktionary.org/wiki/${encodeURIComponent(title)}`,
      dataset: "English Wiktionary (MediaWiki API)",
      entry: title,
      license: "CC BY-SA 4.0",
      attribution: "Wiktionary contributors",
      transform: "Etymology templates parsed from wikitext; geographic associations inferred from language heartlands.",
    });

    const defP = fetchDefinition(title, { signal });
    let pe = { anc: [], formed: null, unknown: true, extractedText: "" };

    let wt = candidate.meta?.wikitext;
    if (wt == null || wt === "") {
      /* Fallback: section fetch when wikitext was not stashed (e.g. older cache path) */
      if (sectionIndex != null) {
        const d = await js(
          `${API}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&section=${sectionIndex}&format=json&formatversion=2&origin=*`,
          { signal }
        );
        const raw = typeof d.parse.wikitext === "string" ? d.parse.wikitext : d.parse.wikitext?.["*"] || "";
        wt = raw.replace(/^=+[^=\n]+=+\s*/, "").split(/\n=+[^=]/)[0];
      }
    }
    if (wt) pe = parseEty(wt);

    const { nodes, edges, gaps } = buildGraph(title, pe, citation);
    const definition = await defP;

    return {
      nodes,
      edges,
      citations: [citation],
      definition,
      gaps,
      alternatives: [],
      word: title,
      language: "English",
      languageCode: "en",
      sense: candidate.sense || "",
    };
  }
}
