import { WiktionaryAdapter } from "./wiktionary.js";
import { WikidataAdapter } from "./wikidata.js";
import { KaikkiAdapter } from "./kaikki.js";

/** Ordered adapters — first successful rich lineage preferred; all contribute candidates. */
export const adapters = [new WiktionaryAdapter(), new WikidataAdapter(), new KaikkiAdapter()];

export function getAdapter(id) {
  return adapters.find((a) => a.id === id) || null;
}

export function listSourceCredits() {
  return adapters.map((a) => ({
    id: a.id,
    name: a.name,
    license: a.license,
    attribution: a.attribution,
    homepage: a.homepage,
  }));
}
