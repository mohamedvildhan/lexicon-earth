import { SourceAdapter } from "./base.js";
import {
  makeCitation,
  makeNode,
  makeEdge,
  REL_TYPES,
  EPISTEMIC,
  GEO_BASIS,
} from "../model.js";
import { LG, regionOf } from "../languages.js";

const SPARQL = "https://query.wikidata.org/sparql";

/** Map common language labels → ISO-ish codes in LG */
const LANG_ALIAS = {
  english: "en",
  dutch: "nl",
  french: "fr",
  german: "de",
  spanish: "es",
  italian: "it",
  portuguese: "pt",
  latin: "la",
  arabic: "ar",
  persian: "fa",
  "middle persian": "pal",
  "old persian": "peo",
  greek: "el",
  "ancient greek": "grc",
  russian: "ru",
  turkish: "tr",
  "ottoman turkish": "ota",
  chinese: "zh",
  japanese: "ja",
  sanskrit: "sa",
  hebrew: "he",
  "old norse": "non",
  "middle english": "enm",
  "old english": "ang",
  "old french": "fro",
  "middle french": "frm",
  "proto-germanic": "gem-pro",
  "proto-indo-european": "ine-pro",
};

function langGeo(label) {
  const key = String(label || "").toLowerCase();
  const code = LANG_ALIAS[key];
  const L = code && LG[code];
  if (!L) {
    return {
      language: label || "Unknown",
      languageCode: code || null,
      region: "",
      lat: null,
      lon: null,
      geoBasis: GEO_BASIS.none,
      note: "No mapped language heartland for this Wikidata language label.",
    };
  }
  return {
    language: L[0],
    languageCode: code,
    region: regionOf(code),
    lat: L[1],
    lon: L[2],
    yearStart: L[3],
    yearEnd: L[4],
    geoBasis: GEO_BASIS.language_heartland,
    note: (L[5] ? L[5] + " " : "") + "Inferred geographic association from language range.",
  };
}

async function sparql(query, { signal } = {}) {
  const url = SPARQL + "?query=" + encodeURIComponent(query) + "&format=json";
  const r = await fetch(url, {
    headers: { Accept: "application/sparql-results+json" },
    signal,
  });
  if (!r.ok) throw new Error(`Wikidata SPARQL HTTP ${r.status}`);
  return r.json();
}

function lit(b, key) {
  return b[key]?.value || null;
}

export class WikidataAdapter extends SourceAdapter {
  constructor() {
    super({
      id: "wikidata",
      name: "Wikidata Lexemes",
      license: "CC0 1.0",
      attribution: "Wikidata contributors",
      homepage: "https://www.wikidata.org/wiki/Wikidata:Lexicographical_data",
    });
  }

  async searchCandidates(query, opts = {}) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    const lang = opts.languageTag || "en";
    const { signal } = opts;
    const querySparql = `
SELECT DISTINCT ?lexeme ?lemma ?langLabel ?posLabel WHERE {
  VALUES ?lemma { "${q.replace(/"/g, '\\"')}"@${lang} }
  ?lexeme a ontolex:LexicalEntry ;
          dct:language ?lang ;
          wikibase:lemma ?lemma .
  OPTIONAL { ?lexeme wikibase:lexicalCategory ?pos . }
  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
    ?lang rdfs:label ?langLabel .
    ?pos rdfs:label ?posLabel .
  }
}
LIMIT 12`;
    try {
      const data = await sparql(querySparql, { signal });
      return (data.results?.bindings || []).map((b) => {
        const lexeme = lit(b, "lexeme");
        const lid = lexeme?.split("/").pop();
        const pos = lit(b, "posLabel");
        const langLabel = lit(b, "langLabel") || "English";
        return {
          id: `wd:${lid}`,
          lemma: lit(b, "lemma") || q,
          language: langLabel,
          languageCode: LANG_ALIAS[langLabel.toLowerCase()] || lang,
          sense: pos || "lexeme",
          gloss: `Wikidata ${lid}${pos ? " · " + pos : ""}`,
          sourceId: this.id,
          meta: { lexemeId: lid, lexemeUri: lexeme },
        };
      });
    } catch {
      return [];
    }
  }

  async fetchLineage(candidate, opts = {}) {
    const lid = candidate.meta?.lexemeId;
    if (!lid) return null;
    const { signal } = opts;

    const citation = makeCitation({
      title: `Wikidata Lexeme ${lid}`,
      url: `https://www.wikidata.org/entity/${lid}`,
      dataset: "Wikidata Lexicographical Data (SPARQL)",
      entry: lid,
      license: "CC0 1.0",
      attribution: "Wikidata contributors",
      transform: "Structured P5191 (derived from lexeme) / P5238 (combines lexemes) walk; geo via language heartlands.",
    });

    /* recursive derivation walk (bounded) */
    const querySparql = `
SELECT ?lexeme ?lemma ?langLabel ?parent ?parentLemma ?parentLangLabel ?prop WHERE {
  BIND(wd:${lid} AS ?seed)
  ?seed (wdt:P5191|wdt:P5238)* ?lexeme .
  ?lexeme wikibase:lemma ?lemma ;
          dct:language ?lang .
  OPTIONAL {
    ?lexeme ?p ?parent .
    FILTER(?p IN (wdt:P5191, wdt:P5238))
    ?parent wikibase:lemma ?parentLemma ;
            dct:language ?parentLang .
    BIND(IF(?p = wdt:P5191, "derived", "combines") AS ?prop)
  }
  SERVICE wikibase:label {
    bd:serviceParam wikibase:language "en".
    ?lang rdfs:label ?langLabel .
    ?parentLang rdfs:label ?parentLangLabel .
  }
}
LIMIT 80`;

    const data = await sparql(querySparql, { signal });
    const bindings = data.results?.bindings || [];
    if (!bindings.length) return null;

    const nodeByLex = new Map();
    const edges = [];
    const citations = [citation];
    const citationIds = [citation.id];

    const ensureNode = (lexemeUri, lemma, langLabel) => {
      const idKey = lexemeUri.split("/").pop();
      if (nodeByLex.has(idKey)) return nodeByLex.get(idKey);
      const g = langGeo(langLabel);
      const reconstructed = /^\*/.test(lemma || "");
      const node = makeNode({
        form: lemma || idKey,
        language: g.language,
        languageCode: g.languageCode,
        region: g.region || "",
        yearStart: g.yearStart ?? null,
        yearEnd: g.yearEnd ?? null,
        lat: g.lat,
        lon: g.lon,
        geoBasis: g.lat != null ? GEO_BASIS.language_heartland : GEO_BASIS.none,
        epistemic: reconstructed ? EPISTEMIC.reconstructed : EPISTEMIC.attested,
        note: g.note,
        citationIds,
      });
      node._lex = idKey;
      nodeByLex.set(idKey, node);
      return node;
    };

    for (const b of bindings) {
      const lexUri = lit(b, "lexeme");
      if (!lexUri) continue;
      const node = ensureNode(lexUri, lit(b, "lemma"), lit(b, "langLabel"));
      const parentUri = lit(b, "parent");
      if (parentUri) {
        const parent = ensureNode(parentUri, lit(b, "parentLemma"), lit(b, "parentLangLabel"));
        const prop = lit(b, "prop");
        edges.push(
          makeEdge({
            fromId: parent.id,
            toId: node.id,
            type: prop === "combines" ? REL_TYPES.compound : REL_TYPES.derivation,
            epistemic: EPISTEMIC.attested,
            note: `Wikidata structured statement (${prop === "combines" ? "P5238" : "P5191"}).`,
            citationIds,
            schematic: true,
          })
        );
      }
      void node;
    }

    const nodes = [...nodeByLex.values()];
    if (!nodes.length) return null;

    /* Prefer seed lexeme as head sense label */
    const seed = nodeByLex.get(lid);

    return {
      nodes,
      edges,
      citations,
      definition: "",
      gaps: nodes.length < 2
        ? ["Wikidata lexeme found, but no P5191/P5238 etymology links are recorded."]
        : ["Geographic positions are language-heartland inferences, not attested travel routes."],
      alternatives: [],
      word: candidate.lemma,
      language: candidate.language,
      languageCode: candidate.languageCode || "en",
      sense: candidate.sense || seed?._lex || lid,
    };
  }
}
