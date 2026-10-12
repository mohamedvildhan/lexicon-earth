#!/usr/bin/env node
/**
 * Sample coverage report: share of lineage language codes that map in the atlas.
 * Usage: node scripts/coverage-report.mjs [word ...]
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { WiktionaryAdapter } from "../js/sources/wiktionary.js";
import { lookupLanguage, atlasStats } from "../js/languages.js";
import { topologicalOrder } from "../js/model.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const words = process.argv.slice(2);
const samples =
  words.length > 0
    ? words
    : ["orange", "shaman", "sugar", "candy", "yoga", "coffee", "paradise", "algebra"];

const atlas = JSON.parse(readFileSync(join(ROOT, "data/languages-atlas.json"), "utf8"));
console.log("Atlas stats:", atlas.meta?.stats || atlasStats());

const adapter = new WiktionaryAdapter();
let totalCodes = 0;
let mappedCodes = 0;

for (const q of samples) {
  process.stdout.write(`\n${q} … `);
  try {
    const cands = await adapter.searchCandidates(q);
    const real = cands.filter((c) => !c.meta?.suggestion);
    if (!real.length) {
      console.log("no candidates");
      continue;
    }
    const lin = await adapter.fetchLineage(real[0]);
    const ordered = topologicalOrder(lin.nodes || [], lin.edges || []);
    const rows = ordered.map((n) => {
      const L = lookupLanguage(n.languageCode || n.language);
      const mapped = L.lat != null && L.lon != null;
      totalCodes += 1;
      if (mapped) mappedCodes += 1;
      return {
        form: n.form,
        lang: n.language,
        code: L.code,
        conf: L.geoConfidence,
        mapped,
      };
    });
    const m = rows.filter((r) => r.mapped).length;
    console.log(`${m}/${rows.length} mapped`);
    for (const r of rows) {
      console.log(
        `  ${r.mapped ? "●" : "○"} ${r.code || "?"} · ${r.lang} · ${r.conf}${r.mapped ? "" : " (unmapped)"}`
      );
    }
  } catch (e) {
    console.log("error:", e.message || e);
  }
}

console.log(
  `\nOverall sample nodes mapped: ${mappedCodes}/${totalCodes}` +
    (totalCodes ? ` (${((100 * mappedCodes) / totalCodes).toFixed(1)}%)` : "")
);
