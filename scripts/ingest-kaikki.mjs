#!/usr/bin/env node
/**
 * Optional offline ingestion helper for Kaikki / Wiktextract dumps.
 *
 * Normal Lexicon Earth use does NOT require this script.
 * Use it only if you want to pre-build a compact JSON subset.
 *
 * Example:
 *   node scripts/ingest-kaikki.mjs path/to/kaikki.org-dictionary-English.jsonl words.txt out.json
 *
 * words.txt = one lemma per line
 * Output = lexicon-earth-cache compatible JSON (forms/edges left for adapter merge)
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";

const [, , dumpPath, wordsPath, outPath] = process.argv;
if (!dumpPath || !wordsPath || !outPath) {
  console.error("Usage: node scripts/ingest-kaikki.mjs <dump.jsonl> <words.txt> <out.json>");
  process.exit(1);
}

const want = new Set(
  (await readFile(wordsPath, "utf8"))
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

const hits = [];
const rl = createInterface({ input: createReadStream(dumpPath), crlfDelay: Infinity });
let lineNo = 0;
for await (const line of rl) {
  lineNo += 1;
  if (!line) continue;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  const w = String(obj.word || "").toLowerCase();
  if (!want.has(w)) continue;
  if (obj.lang_code && obj.lang_code !== "en") continue;
  hits.push({
    word: obj.word,
    pos: obj.pos,
    etymology_text: obj.etymology_text || null,
    etymology_templates: obj.etymology_templates || [],
    senses: (obj.senses || []).slice(0, 3).map((s) => ({ glosses: s.glosses || [] })),
  });
  process.stdout.write(`\rLines ${lineNo} · hits ${hits.length}`);
}

const payload = {
  format: "lexicon-earth-kaikki-subset",
  version: 1,
  createdAt: new Date().toISOString(),
  note: "Compact Kaikki subset. Import via a future loader or convert with the Kaikki adapter fields.",
  entries: hits,
};
await writeFile(outPath, JSON.stringify(payload, null, 2));
console.log(`\nWrote ${hits.length} entries → ${outPath}`);
