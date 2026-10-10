import { SourceAdapter } from "./base.js";
import { makeCitation, makeNode, makeEdge, REL_TYPES, EPISTEMIC, GEO_BASIS } from "../model.js";
import { LG, AL, regionOf } from "../languages.js";

const ANC = /^(inh|inherited|bor|borrowed|der|derived|lbor|bor\+|inh\+|der\+|calque|cal|etyl)$/;

/**
 * Optional Kaikki.org assist. Per-word JSON may be CORS-blocked;
 * failures are silent — never required for app use.
 */
export class KaikkiAdapter extends SourceAdapter {
  constructor() {
    super({
      id: "kaikki",
      name: "Kaikki / Wiktextract",
      license: "CC BY-SA 4.0",
      attribution: "Kaikki.org / Wiktextract (from Wiktionary)",
      homepage: "https://kaikki.org/dictionary/rawdata.html",
    });
  }

  async searchCandidates(query, opts = {}) {
    const w = String(query || "").toLowerCase().trim();
    if (w.length < 2) return [];
    const hit = await this._fetchWord(w, opts.signal);
    if (!hit) return [];
    return [
      {
        id: `kaikki:en:${w}`,
        lemma: hit.word || w,
        language: "English",
        languageCode: "en",
        sense: hit.pos || "entry",
        gloss: "Kaikki structured extract (if reachable)",
        sourceId: this.id,
        meta: { entry: hit },
      },
    ];
  }

  async fetchLineage(candidate, opts = {}) {
    const entry = candidate.meta?.entry || (await this._fetchWord(candidate.lemma, opts.signal));
    if (!entry?.etymology_templates?.length) return null;

    const citation = makeCitation({
      title: `Kaikki: ${entry.word}`,
      url: `https://kaikki.org/dictionary/English/meaning/${encodeURIComponent(entry.word[0])}/${encodeURIComponent(entry.word.slice(0, 2))}/${encodeURIComponent(entry.word)}.html`,
      dataset: "Kaikki.org Wiktextract JSON",
      entry: entry.word,
      license: "CC BY-SA 4.0",
      attribution: "Kaikki.org / Wiktionary contributors via Wiktextract",
      transform: "etymology_templates → lineage graph; geo via language heartlands.",
    });

    const templates = entry.etymology_templates;
    const anc = [];
    for (const t of templates) {
      const nm = String(t.name || "").toLowerCase();
      if (!ANC.test(nm)) continue;
      const args = t.args || {};
      const code = nm === "etyl" ? args["1"] : args["2"] || args["1"];
      const term = nm === "etyl" ? args["2"] : args["3"] || args["2"];
      if (!code || code === "en") continue;
      anc.push({ code, term: term || "", tr: args.tr || "", gloss: args.t || "", nm });
    }
    if (!anc.length) return null;

    const citationIds = [citation.id];
    const nodes = [];
    const edges = [];
    let prev = null;
    for (const a of [...anc].reverse()) {
      const c = AL[a.code] || a.code;
      const L = LG[c];
      const pro = /-pro$/.test(c);
      let form = a.term || "—";
      if (pro && form !== "—" && form[0] !== "*") form = "*" + form;
      const node = makeNode({
        form,
        language: L ? L[0] : c,
        languageCode: c,
        region: regionOf(c),
        gloss: a.gloss,
        transliteration: a.tr,
        yearStart: L ? L[3] : null,
        yearEnd: L ? L[4] : null,
        lat: L ? L[1] : null,
        lon: L ? L[2] : null,
        geoBasis: L ? GEO_BASIS.language_heartland : GEO_BASIS.none,
        epistemic: pro ? EPISTEMIC.reconstructed : EPISTEMIC.attested,
        note: L
          ? (L[5] || "") + " Inferred geographic association from language range."
          : "Language region not mapped.",
        citationIds,
      });
      nodes.push(node);
      if (prev) {
        edges.push(
          makeEdge({
            fromId: prev.id,
            toId: node.id,
            type: /bor/.test(a.nm) ? REL_TYPES.borrowing : /inh/.test(a.nm) ? REL_TYPES.inheritance : REL_TYPES.derivation,
            epistemic: EPISTEMIC.attested,
            note: "From Kaikki etymology_templates (structured extract of Wiktionary).",
            citationIds,
            schematic: true,
          })
        );
      }
      prev = node;
    }

    const E = LG.en;
    const head = makeNode({
      form: entry.word,
      language: "English",
      languageCode: "en",
      region: regionOf("en"),
      yearStart: E[3],
      lat: E[1],
      lon: E[2],
      geoBasis: GEO_BASIS.language_heartland,
      epistemic: EPISTEMIC.attested,
      note: "Inferred geographic association from language range.",
      citationIds,
    });
    nodes.push(head);
    if (prev) {
      edges.push(
        makeEdge({
          fromId: prev.id,
          toId: head.id,
          type: REL_TYPES.borrowing,
          epistemic: EPISTEMIC.attested,
          citationIds,
          schematic: true,
        })
      );
    }

    const gloss = entry.senses?.[0]?.glosses?.[0] || "";
    return {
      nodes,
      edges,
      citations: [citation],
      definition: gloss ? `${entry.pos || "word"} — ${gloss}` : "",
      gaps: ["Kaikki data is a Wiktionary extract; verify against the original entry when precision matters."],
      word: entry.word,
      language: "English",
      languageCode: "en",
      sense: entry.pos || "",
    };
  }

  async _fetchWord(w, outerSignal) {
    const a = encodeURIComponent(w[0]);
    const ab = encodeURIComponent(w.slice(0, 2));
    const urls = [
      `https://kaikki.org/dictionary/English/meaning/${a}/${ab}/${encodeURIComponent(w)}.json`,
    ];
    for (const url of urls) {
      try {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        outerSignal?.addEventListener("abort", onAbort, { once: true });
        if (outerSignal?.aborted) ctrl.abort();
        const t = setTimeout(() => ctrl.abort(), 3500);
        const r = await fetch(url, { signal: ctrl.signal, mode: "cors" });
        clearTimeout(t);
        outerSignal?.removeEventListener("abort", onAbort);
        if (!r.ok) continue;
        const data = await r.json();
        const entries = Array.isArray(data) ? data : [data];
        return entries.find((e) => e.lang_code === "en" || e.lang === "English") || entries[0];
      } catch (e) {
        if (e?.name === "AbortError" && outerSignal?.aborted) throw e;
        /* CORS / network / local timeout */
      }
    }
    return null;
  }
}
