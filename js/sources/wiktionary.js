import { SourceAdapter } from "./base.js";
import {
  makeCitation,
  makeNode,
  makeEdge,
  cleanForm,
  needsRomanization,
  REL_TYPES,
  EPISTEMIC,
  GEO_BASIS,
} from "../model.js";
import { lookupLanguage, lookupLanguageByName, period, GEO_CONFIDENCE } from "../languages.js";

/** In-memory Wiktionary {{xlit}} results for this session. */
const xlitCache = new Map();

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
  const L = lookupLanguage(code);
  const mapped = L.lat != null && L.lon != null;
  return {
    language: L.name,
    languageCode: L.code,
    region: L.region || "",
    lat: L.lat,
    lon: L.lon,
    era: period(L.yearStart, L.yearEnd),
    y: L.yearStart,
    yearEnd: L.yearEnd,
    note: L.note || (mapped ? "" : "Language region not mapped."),
    geoBasis: mapped ? GEO_BASIS.language_heartland : GEO_BASIS.none,
    geoConfidence: L.geoConfidence || (mapped ? GEO_CONFIDENCE.precise : GEO_CONFIDENCE.unavailable),
  };
}

function htmlToText(html) {
  return new DOMParser().parseFromString(html || "", "text/html").body.textContent.trim();
}

function restGroupsForLang(data, langCode) {
  if (!data || typeof data !== "object") return [];
  if (langCode && Array.isArray(data[langCode])) return data[langCode];
  /* REST often buckets non-Latin entries under "other" */
  if (langCode && langCode !== "en" && Array.isArray(data.other)) return data.other;
  if (Array.isArray(data.en)) return data.en;
  if (Array.isArray(data.other)) return data.other;
  /* Fall back to first language bucket on the page */
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length) return v;
  }
  return [];
}

/** Guess preferred Wiktionary L2 heading(s) from the query’s script. */
function preferredLanguagesForQuery(q) {
  const s = String(q || "");
  if (/[\u0780-\u07BF]/.test(s)) return ["Dhivehi"]; /* Thaana */
  if (/[\u0600-\u06FF\u0750-\u077F]/.test(s)) return ["Arabic", "Persian", "Urdu", "Ottoman Turkish"];
  if (/[\u0400-\u04FF]/.test(s)) return ["Russian", "Ukrainian", "Bulgarian", "Serbo-Croatian"];
  if (/[\u3040-\u30FF]/.test(s)) return ["Japanese"];
  if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(s)) return ["Chinese", "Japanese", "Korean"];
  if (/[\uAC00-\uD7AF]/.test(s)) return ["Korean"];
  if (/[\u0900-\u097F]/.test(s)) return ["Hindi", "Sanskrit", "Nepali", "Marathi"];
  if (/[\u0D80-\u0DFF]/.test(s)) return ["Sinhalese"];
  if (/[\u0E00-\u0E7F]/.test(s)) return ["Thai"];
  if (/[\u0E80-\u0EFF]/.test(s)) return ["Lao"];
  if (/[\u1000-\u109F]/.test(s)) return ["Burmese"];
  if (/[\u1200-\u137F]/.test(s)) return ["Amharic", "Tigrinya"];
  if (/[\u0530-\u058F]/.test(s)) return ["Armenian"];
  if (/[\u10A0-\u10FF]/.test(s)) return ["Georgian"];
  if (/[\u0370-\u03FF\u1F00-\u1FFF]/.test(s)) return ["Greek", "Ancient Greek"];
  if (/[\u0590-\u05FF]/.test(s)) return ["Hebrew", "Yiddish"];
  if (/[\u0B80-\u0BFF]/.test(s)) return ["Tamil"];
  if (/[\u0C00-\u0C7F]/.test(s)) return ["Telugu"];
  if (/[\u0C80-\u0CFF]/.test(s)) return ["Kannada"];
  if (/[\u0D00-\u0D7F]/.test(s)) return ["Malayalam"];
  if (/[\u0980-\u09FF]/.test(s)) return ["Bengali", "Assamese"];
  if (/[\u0A00-\u0A7F]/.test(s)) return ["Punjabi"];
  if (/[\u0A80-\u0AFF]/.test(s)) return ["Gujarati"];
  if (/[\u0B00-\u0B7F]/.test(s)) return ["Odia"];
  return [];
}

function titleVariants(q) {
  const nfc = String(q || "").normalize("NFC").trim();
  if (!nfc) return [];
  const titled = nfc.charAt(0).toUpperCase() + nfc.slice(1).toLowerCase();
  /* Avoid Latin-only case munging destroying non-cased scripts — Set keeps uniques */
  return [...new Set([nfc, nfc.toLowerCase(), nfc.toUpperCase(), titled].filter(Boolean))];
}

async function fetchDefinition(title, { signal, langCode = "en" } = {}) {
  try {
    const d = await js(REST + encodeURIComponent(title), { signal });
    for (const g of restGroupsForLang(d, langCode)) {
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

/** Prefer the chosen sense’s POS + gloss over the page’s first definition. */
function definitionFromCandidate(candidate) {
  const pos = String(candidate?.pos || "")
    .toLowerCase()
    .trim();
  let gloss = String(candidate?.gloss || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!gloss) return "";
  if (/^wikidata\b/i.test(gloss)) return pos ? `${pos} — lexical entry (Wikidata)` : "";
  if (/^(no dedicated etymology|english\b)/i.test(gloss) && gloss.length < 48) return "";
  if (gloss.length > 320) gloss = gloss.slice(0, 317) + "…";
  return pos ? `${pos} — ${gloss}` : gloss;
}

/** Match REST definition list to a candidate POS / etymology index when possible. */
async function fetchDefinitionForCandidate(title, candidate, { signal, langCode = "en" } = {}) {
  const fromCand = definitionFromCandidate(candidate);
  if (fromCand) return fromCand;
  try {
    const list = await fetchDefinitionList(title, { signal, langCode });
    if (!list.length) return fetchDefinition(title, { signal, langCode });
    const wantPos = String(candidate?.pos || "").toLowerCase();
    const ety = candidate?.meta?.etyIndex;
    const pool = wantPos
      ? list.filter((d) => String(d.pos || "").toLowerCase() === wantPos)
      : list;
    const hit =
      (typeof ety === "number" && (pool[ety] || list[ety])) || pool[0] || list[0];
    if (!hit?.gloss) return "";
    const pos = String(hit.pos || wantPos || "").toLowerCase();
    return pos ? `${pos} — ${hit.gloss}` : hit.gloss;
  } catch (e) {
    if (e?.name === "AbortError") throw e;
  }
  return fetchDefinition(title, { signal, langCode });
}

/** REST senses for a language (falls back to any available language on the page). */
async function fetchDefinitionList(title, { signal, langCode = "en" } = {}) {
  try {
    const d = await js(REST + encodeURIComponent(title), { signal });
    const out = [];
    for (const g of restGroupsForLang(d, langCode)) {
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
 * L2 language headings on a Wiktionary page.
 * Prefers script-matched languages, then English, then A–Z.
 */
function listL2Languages(sections, preferred = []) {
  const names = (sections || [])
    .filter((x) => x.toclevel === 1 && x.line && !/^(Translingual|References|Further reading)$/i.test(x.line))
    .map((x) => x.line);
  const uniq = [...new Set(names)];
  const pref = new Map((preferred || []).map((n, i) => [String(n).toLowerCase(), i]));
  uniq.sort((a, b) => {
    const ap = pref.has(a.toLowerCase()) ? pref.get(a.toLowerCase()) : 1000;
    const bp = pref.has(b.toLowerCase()) ? pref.get(b.toLowerCase()) : 1000;
    if (ap !== bp) return ap - bp;
    if (a === "English") return -1;
    if (b === "English") return 1;
    return a.localeCompare(b);
  });
  return uniq;
}

/**
 * Slice L2 language section + Etymology subsections from full-page wikitext.
 * @returns {{ language: string, ets: Array<{ line, wikitext, sectionIndex, pos?, gloss? }> } | null}
 */
function extractLanguageEtymologies(fullWt, sections, languageName) {
  if (!fullWt || !languageName) return null;
  const esc = languageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const langRe = new RegExp(`^==\\s*${esc}\\s*==\\s*$`, "m");
  const langMatch = fullWt.match(langRe);
  if (!langMatch) return null;
  const langStart = langMatch.index + langMatch[0].length;
  const nextL2 = fullWt.slice(langStart).search(/^==\s*[^=].*?==\s*$/m);
  const langBody = nextL2 >= 0 ? fullWt.slice(langStart, langStart + nextL2) : fullWt.slice(langStart);

  const etyRe = /^(={3,4})\s*(Etymology(?:\s+\d+)?)\s*\1\s*$/gm;
  const hits = [];
  let m;
  while ((m = etyRe.exec(langBody))) {
    hits.push({ line: m[2], index: m.index, end: m.index + m[0].length });
  }

  const langSec = (sections || []).find((x) => x.line === languageName && x.toclevel === 1);
  const etySecs = langSec
    ? (sections || []).filter(
        (x) => /^Etymology( \d+)?$/.test(x.line) && String(x.number).startsWith(langSec.number + ".")
      )
    : [];

  if (!hits.length) {
    return {
      language: languageName,
      ets: [
        {
          line: `${languageName} entry`,
          wikitext: "",
          sectionIndex: null,
        },
      ],
    };
  }

  return {
    language: languageName,
    ets: hits.map((h, i) => {
      const next = hits[i + 1];
      const sliceEnd = next ? next.index : langBody.length;
      const full = langBody.slice(h.end, sliceEnd).replace(/^\s+/, "");
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

/** @deprecated Use extractLanguageEtymologies(…, "English") */
function extractEnglishEtymologies(fullWt, sections) {
  return extractLanguageEtymologies(fullWt, sections, "English");
}

/** First IPA transcription in wikitext, if any (e.g. huː.n̪u). */
function extractIpa(wt) {
  const m = String(wt || "").match(/\{\{IPA\|[^|}]*\|\/([^/|}]+)\//i);
  return m ? m[1].trim() : "";
}

/**
 * Fill missing transliterations for non-Latin forms via Wiktionary {{xlit}}.
 * One batched expandtemplates call per lineage to stay under rate limits.
 * Exported so cached panel records can be backfilled after load.
 */
export async function enrichNodeRomanizations(nodes, { signal, pageWt = "" } = {}) {
  return enrichTransliterations(nodes, { signal, pageWt });
}

async function enrichTransliterations(nodes, { signal, pageWt = "" } = {}) {
  if (!nodes?.length) return;

  const jobs = nodes.filter(
    (n) => !stripXlit(n.transliteration) && needsRomanization(n.form) && !isDashForm(n.form)
  );

  for (const n of jobs) {
    const term = cleanForm(n.form).replace(/^\*/, "");
    const code = String(n.languageCode || "")
      .split(/[-_/]/)[0]
      .toLowerCase();
    const hit = xlitCache.get(`${code}|${term}`);
    if (hit) n.transliteration = hit;
  }

  const still = jobs.filter((n) => !stripXlit(n.transliteration));
  if (still.length) {
    const sep = "@@";
    try {
      const text = still
        .map((n) => {
          const term = cleanForm(n.form).replace(/^\*/, "");
          const code = String(n.languageCode || "")
            .split(/[-_/]/)[0]
            .toLowerCase();
          return `{{xlit|${code}|${term}}}`;
        })
        .join(sep);
      /* Prefer expandtemplates; fall back to parse if the API shape differs */
      let raw = "";
      try {
        const d = await js(
          `${API}?action=expandtemplates&text=${encodeURIComponent(text)}&prop=wikitext&format=json&formatversion=2&origin=*`,
          { signal }
        );
        raw = String(d.expandtemplates?.wikitext || "");
      } catch (e) {
        if (e?.name === "AbortError") throw e;
      }
      if (!raw) {
        const d = await js(
          `${API}?action=parse&text=${encodeURIComponent(text)}&contentmodel=wikitext&prop=text&format=json&formatversion=2&origin=*`,
          { signal }
        );
        const html = typeof d.parse?.text === "string" ? d.parse.text : d.parse?.text?.["*"] || "";
        raw = htmlToText(html);
        /* parse joins without our sep — request one term at a time below if needed */
        if (!raw.includes(sep) && still.length > 1) {
          for (const n of still) {
            const term = cleanForm(n.form).replace(/^\*/, "");
            const code = String(n.languageCode || "")
              .split(/[-_/]/)[0]
              .toLowerCase();
            try {
              const one = await js(
                `${API}?action=expandtemplates&text=${encodeURIComponent(`{{xlit|${code}|${term}}}`)}&prop=wikitext&format=json&formatversion=2&origin=*`,
                { signal }
              );
              const tr = stripXlit(one.expandtemplates?.wikitext || "");
              if (tr && tr !== term && !/\{\{|Module:|script error/i.test(tr)) {
                n.transliteration = tr;
                xlitCache.set(`${code}|${term}`, tr);
              }
            } catch (e) {
              if (e?.name === "AbortError") throw e;
            }
          }
          raw = "";
        }
      }
      if (raw) {
        const parts = raw.split(sep);
        still.forEach((n, i) => {
          const term = cleanForm(n.form).replace(/^\*/, "");
          const code = String(n.languageCode || "")
            .split(/[-_/]/)[0]
            .toLowerCase();
          const tr = stripXlit(parts[i] || "");
          if (!tr || tr === term || /\{\{|Module:|script error/i.test(tr)) return;
          n.transliteration = tr;
          xlitCache.set(`${code}|${term}`, tr);
        });
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
    }
  }

  const ipa = extractIpa(pageWt);
  if (ipa) {
    const head = nodes[nodes.length - 1];
    if (head && !stripXlit(head.transliteration) && needsRomanization(head.form)) {
      head.transliteration = ipa;
    }
  }
}

function stripXlit(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isDashForm(form) {
  const f = cleanForm(form);
  return !f || f === "—" || f === "-" || f === "…" || f === "?";
}

function buildGraph(title, pe, citation, headLanguage = "English", headLanguageCode = "en") {
  const nodes = [];
  const edges = [];
  const citationIds = [citation.id];

  const anc = [...pe.anc].reverse();
  let prevId = null;

  for (const a of anc) {
    const g = geoFor(a.code);
    const rawTerm = cleanForm(a.alt || a.term || "");
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
    const geoNote = g.note && g.geoConfidence && g.geoConfidence !== "precise" ? g.note : "";
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
      geoConfidence: g.geoConfidence || GEO_CONFIDENCE.unavailable,
      epistemic,
      note: [a.dis ? "Hedged wording in Wiktionary extraction." : "", geoNote].filter(Boolean).join(" "),
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

  const headGeo = geoFor(headLanguageCode);
  const head = makeNode({
    form: title,
    language: headLanguage || headGeo.language || "English",
    languageCode: headLanguageCode || headGeo.languageCode || "en",
    region: headGeo.region || "",
    yearStart: headGeo.y,
    lat: headGeo.lat,
    lon: headGeo.lon,
    geoBasis: headGeo.lat != null ? GEO_BASIS.language_heartland : GEO_BASIS.none,
    geoConfidence: headGeo.geoConfidence || GEO_CONFIDENCE.precise,
    epistemic: EPISTEMIC.attested,
    note: headGeo.geoConfidence && headGeo.geoConfidence !== "precise" ? headGeo.note || "" : "",
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
    const q = String(query || "")
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "")
      .normalize("NFC")
      .trim();
    if (!q) return [];
    const { signal } = opts;
    const preferred = preferredLanguagesForQuery(q);

    const parseTitle = async (t) => {
      const d = await js(
        `${API}?action=parse&page=${encodeURIComponent(t)}&prop=wikitext|sections&format=json&formatversion=2&redirects=1&origin=*`,
        { signal }
      );
      if (!d.parse?.title) return null;
      const l2 = listL2Languages(d.parse.sections || [], preferred);
      if (!l2.length) return null;
      const fullWt =
        typeof d.parse.wikitext === "string" ? d.parse.wikitext : d.parse.wikitext?.["*"] || "";
      return { title: d.parse.title, fullWt, secs: d.parse.sections, l2 };
    };

    let page = null;
    const tried = new Set();
    for (const t of titleVariants(q)) {
      if (tried.has(t)) continue;
      tried.add(t);
      try {
        page = await parseTitle(t);
        if (page) break;
      } catch (e) {
        if (e?.name === "AbortError") throw e;
      }
    }

    /* OpenSearch / fulltext: resolve real pages (incl. exact non-Latin titles) */
    let openTitles = [];
    if (!page) {
      try {
        openTitles =
          (await js(
            `${API}?action=opensearch&search=${encodeURIComponent(q)}&limit=8&format=json&origin=*`,
            { signal }
          ))[1] || [];
      } catch (e) {
        if (e?.name === "AbortError") throw e;
      }
      if (!openTitles.length) {
        try {
          const sr = await js(
            `${API}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srnamespace=0&srlimit=8&format=json&formatversion=2&origin=*`,
            { signal }
          );
          openTitles = (sr.query?.search || []).map((row) => row.title).filter(Boolean);
        } catch (e) {
          if (e?.name === "AbortError") throw e;
        }
      }
      for (const t of openTitles) {
        if (!t || tried.has(t)) continue;
        tried.add(t);
        try {
          page = await parseTitle(t);
          if (page) break;
        } catch (e) {
          if (e?.name === "AbortError") throw e;
        }
      }
    }

    if (!page) {
      const qLower = q.toLowerCase();
      const seen = new Set();
      const useful = [];
      for (const s of openTitles) {
        const key = String(s).toLowerCase();
        if (!key || seen.has(key) || key === qLower) continue;
        seen.add(key);
        useful.push(s);
        if (useful.length >= 5) break;
      }
      return useful.map((s) => ({
        id: `wikt:suggest:${s}`,
        lemma: s,
        language: "any",
        languageCode: "",
        sense: "suggestion",
        gloss: "Suggested spelling from Wiktionary open search",
        sourceId: this.id,
        meta: { suggestion: true },
      }));
    }

    const { title, fullWt, secs } = page;
    const languages = listL2Languages(secs, preferred);
    const out = [];

    for (const langName of languages) {
      const extracted = extractLanguageEtymologies(fullWt, secs, langName);
      if (!extracted) continue;
      const langInfo = lookupLanguageByName(langName);
      const langCode =
        langInfo.code && langInfo.name !== langInfo.code
          ? langInfo.code
          : langName.slice(0, 3).toLowerCase();
      const ets = extracted.ets || [];
      let restDefs = null;

      const pushCand = (sec, i, pos, gloss) => {
        out.push({
          id: `wikt:${title}:${langCode}:${i}`,
          lemma: title,
          language: langName,
          languageCode: langCode,
          sense: sec.line,
          pos: pos || "",
          gloss: gloss || (ets.length > 1 ? `${langName} · ${sec.line}` : `${langName} entry`),
          sourceId: this.id,
          meta: {
            title,
            language: langName,
            languageCode: langCode,
            etyIndex: i,
            sectionIndex: sec.sectionIndex,
            wikitext: sec.wikitext || "",
          },
        });
      };

      if (!ets.length || (ets.length === 1 && !ets[0].wikitext && /entry$/i.test(ets[0].line))) {
        restDefs = await fetchDefinitionList(title, { signal, langCode });
        const top = restDefs[0];
        pushCand(
          ets[0] || { line: `${langName} entry`, wikitext: "", sectionIndex: null },
          0,
          top?.pos || "",
          top ? top.gloss : "No dedicated etymology section"
        );
        continue;
      }

      if (ets.some((sec) => !sec.gloss)) {
        restDefs = await fetchDefinitionList(title, { signal, langCode });
      }

      ets.forEach((sec, i) => {
        let pos = sec.pos || "";
        let gloss = sec.gloss || "";
        if (!gloss && restDefs?.length) {
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
        pushCand(sec, i, pos, gloss);
      });
    }

    return out;
  }

  async fetchLineage(candidate, opts = {}) {
    if (candidate.meta?.suggestion) return null;
    const { signal } = opts;
    const title = candidate.meta?.title || candidate.lemma;
    const sectionIndex = candidate.meta?.sectionIndex;
    const headLanguage = candidate.meta?.language || candidate.language || "English";
    const headLanguageCode = candidate.meta?.languageCode || candidate.languageCode || "en";

    const citation = makeCitation({
      title: `Wiktionary: ${title} (${headLanguage})`,
      url: `https://en.wiktionary.org/wiki/${encodeURIComponent(title)}#${encodeURIComponent(headLanguage)}`,
      dataset: "English Wiktionary (MediaWiki API)",
      entry: title,
      license: "CC BY-SA 4.0",
      attribution: "Wiktionary contributors",
      transform: "Etymology templates parsed from wikitext; geographic associations inferred from language heartlands.",
    });

    const defP = fetchDefinitionForCandidate(title, candidate, {
      signal,
      langCode: headLanguageCode,
    });
    let pe = { anc: [], formed: null, unknown: true, extractedText: "" };

    let wt = candidate.meta?.wikitext;
    if (wt == null || wt === "") {
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

    const { nodes, edges, gaps } = buildGraph(title, pe, citation, headLanguage, headLanguageCode);
    const definition = await defP;

    /* Prefer full-page wikitext for IPA when the head still needs a romanization */
    let pageWt = wt || "";
    const headNeeds =
      nodes.some((n) => needsRomanization(n.form) && !stripXlit(n.transliteration));
    if (headNeeds) {
      try {
        const d = await js(
          `${API}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&formatversion=2&redirects=1&origin=*`,
          { signal }
        );
        pageWt =
          typeof d.parse?.wikitext === "string"
            ? d.parse.wikitext
            : d.parse?.wikitext?.["*"] || pageWt;
      } catch (e) {
        if (e?.name === "AbortError") throw e;
      }
    }
    await enrichTransliterations(nodes, { signal, pageWt });

    return {
      nodes,
      edges,
      citations: [citation],
      definition,
      gaps,
      alternatives: [],
      word: title,
      language: headLanguage,
      languageCode: headLanguageCode,
      sense: candidate.sense || "",
      pos: candidate.pos || "",
    };
  }
}
