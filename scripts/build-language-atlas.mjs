#!/usr/bin/env node
/**
 * Build data/languages-atlas.json from:
 *  - English Wiktionary Module:JSON data (CC BY-SA 4.0)
 *  - Glottolog CLDF languages.csv (CC BY 4.0)
 *  - data/language-overrides.json (curated periods / proto pins)
 *
 * Usage: node scripts/build-language-atlas.mjs
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CACHE = join(ROOT, "scripts", ".cache");
const OUT = join(ROOT, "data", "languages-atlas.json");
const OVERRIDES = join(ROOT, "data", "language-overrides.json");

const GLOTTOLOG_CSV =
  "https://raw.githubusercontent.com/glottolog/glottolog-cldf/v5.2.1/cldf/languages.csv";
const GLOTTOLOG_TAG = "v5.2.1";
const WIKT_API = "https://en.wiktionary.org/w/api.php";

const DISCLAIMER = {
  precise: "",
  approximate: "Position approximate (family/region centroid).",
  uncertain: "Reconstructed homeland — scholarly estimate, debated.",
  period_only: "Shown at the parent language’s region; period, not a distinct place.",
  unavailable: "No mapped location for this stage.",
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, { cacheKey, retries = 4 } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const path = cacheKey ? join(CACHE, cacheKey) : null;
  if (path && existsSync(path)) {
    console.log("  cache hit", cacheKey);
    return readFileSync(path, "utf8");
  }
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "LexiconEarthAtlasBuilder/1.0 (local build; open data)" },
      });
      const text = await r.text();
      if (!r.ok || /^You are making too many requests/i.test(text)) {
        throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`);
      }
      if (path) writeFileSync(path, text);
      return text;
    } catch (e) {
      lastErr = e;
      const wait = 1500 * (i + 1);
      console.warn(`  retry ${i + 1}/${retries} after ${wait}ms — ${e.message}`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function expandWikt(invokeBody, cacheKey) {
  const text = `{{#invoke:JSON data|${invokeBody}}}`;
  const url =
    `${WIKT_API}?action=expandtemplates&format=json&formatversion=2&prop=wikitext&text=` +
    encodeURIComponent(text);
  const raw = await fetchText(url, { cacheKey });
  const j = JSON.parse(raw);
  const wt = j.expandtemplates?.wikitext;
  if (!wt || /scribunto-error|Lua error/i.test(wt)) {
    throw new Error(`Wiktionary expand failed for ${invokeBody}: ${String(wt).slice(0, 200)}`);
  }
  return JSON.parse(wt);
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    return row;
  });
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function tierFromGlottolog(level, isProto) {
  if (isProto) return "uncertain";
  if (level === "language") return "precise";
  if (level === "family" || level === "dialect") return "approximate";
  return "approximate";
}

function applyDisclaimer(entry) {
  const d = DISCLAIMER[entry.geoConfidence] || "";
  if (d && !entry.note) entry.note = d;
  else if (d && entry.note && !entry.note.includes(d.slice(0, 24))) {
    entry.note = `${entry.note} ${d}`.trim();
  }
  return entry;
}

async function main() {
  console.log("Building language atlas…");
  const overrides = JSON.parse(readFileSync(OVERRIDES, "utf8"));

  console.log("Fetching Wiktionary language names…");
  await sleep(800);
  const wiktNames = await expandWikt("export_languages||1", "wikt-languages-names.json");
  console.log("  languages", Object.keys(wiktNames).filter((k) => wiktNames[k]).length);

  console.log("Fetching Wiktionary etymology-language modules…");
  await sleep(1200);
  const wiktEty = await expandWikt("export_etymology_languages", "wikt-etymology-languages.json");
  console.log("  etymology languages", Object.keys(wiktEty).length);

  console.log("Fetching Glottolog CLDF…");
  const csv = await fetchText(GLOTTOLOG_CSV, { cacheKey: `glottolog-${GLOTTOLOG_TAG}-languages.csv` });
  const glRows = parseCsv(csv);
  const byIso = new Map();
  const byGlotto = new Map();
  for (const row of glRows) {
    const lat = num(row.Latitude);
    const lon = num(row.Longitude);
    if (lat == null || lon == null) continue;
    const rec = {
      name: row.Name,
      lat,
      lon,
      level: row.Level || "",
      glottocode: row.Glottocode || row.ID,
      iso: row.ISO639P3code || row.Closest_ISO369P3code || "",
    };
    if (rec.iso && (!byIso.has(rec.iso) || rec.level === "language")) {
      if (!byIso.has(rec.iso) || byIso.get(rec.iso).level !== "language") {
        byIso.set(rec.iso, rec);
      }
    }
    byGlotto.set(rec.glottocode, rec);
  }
  console.log("  glottolog with coords", glRows.filter((r) => r.Latitude && r.Longitude).length);
  console.log("  iso index", byIso.size);

  const languages = {};
  const aliases = { ...(overrides.aliases || {}) };

  /* 1) Wiktionary regular languages */
  for (const [code, name] of Object.entries(wiktNames)) {
    if (!name || typeof name !== "string") continue;
    const isProto = /-pro$/.test(code);
    const g = byIso.get(code) || null;
    let lat = g?.lat ?? null;
    let lon = g?.lon ?? null;
    let geoConfidence = "unavailable";
    let source = "wiktionary";
    if (g) {
      geoConfidence = tierFromGlottolog(g.level, isProto);
      source = "wiktionary+glottolog";
    } else if (isProto) {
      geoConfidence = "uncertain";
    }
    languages[code] = {
      name,
      lat,
      lon,
      yearStart: null,
      yearEnd: null,
      region: "",
      note: "",
      geoConfidence,
      source,
      glottocode: g?.glottocode || null,
    };
  }

  /* 2) Etymology-only languages (period codes, etc.) */
  for (const [code, meta] of Object.entries(wiktEty)) {
    const name = meta?.["1"] || meta?.canonicalName || code;
    const parent = meta?.parent || (Array.isArray(meta?.ancestors) ? meta.ancestors[0] : meta?.ancestors) || null;
    const parentCode = typeof parent === "string" ? parent.split(",")[0].trim() : null;
    const parentEntry = parentCode ? languages[parentCode] : null;
    const isProto = /-pro$/.test(code);
    let lat = null;
    let lon = null;
    let geoConfidence = "unavailable";
    let source = "wiktionary-ety";

    if (parentEntry?.lat != null) {
      lat = parentEntry.lat;
      lon = parentEntry.lon;
      geoConfidence = isProto ? "uncertain" : "period_only";
      source = "wiktionary-ety+parent";
    } else {
      const g = byIso.get(code);
      if (g) {
        lat = g.lat;
        lon = g.lon;
        geoConfidence = tierFromGlottolog(g.level, isProto);
        source = "wiktionary-ety+glottolog";
      } else if (isProto) {
        geoConfidence = "uncertain";
      } else {
        geoConfidence = "period_only";
      }
    }

    const prev = languages[code];
    if (!prev || prev.geoConfidence === "unavailable" || prev.lat == null) {
      languages[code] = {
        name,
        lat,
        lon,
        yearStart: null,
        yearEnd: null,
        region: "",
        note: "",
        geoConfidence,
        source,
        parent: parentCode || null,
        glottocode: byIso.get(code)?.glottocode || parentEntry?.glottocode || null,
      };
    }
  }

  /* 3) Glottolog ISO codes not already present (extra coverage) */
  for (const [iso, g] of byIso) {
    if (languages[iso]) continue;
    if (g.level !== "language") continue;
    languages[iso] = {
      name: g.name,
      lat: g.lat,
      lon: g.lon,
      yearStart: null,
      yearEnd: null,
      region: "",
      note: "",
      geoConfidence: "precise",
      source: "glottolog",
      glottocode: g.glottocode,
    };
  }

  /* 4) Curated overrides win for coords/dates/region/confidence */
  for (const [code, ov] of Object.entries(overrides.languages || {})) {
    const base = languages[code] || {
      name: ov.name,
      lat: null,
      lon: null,
      yearStart: null,
      yearEnd: null,
      region: "",
      note: "",
      geoConfidence: "unavailable",
      source: "override",
    };
    languages[code] = applyDisclaimer({
      name: ov.name || base.name,
      lat: ov.lat ?? base.lat,
      lon: ov.lon ?? base.lon,
      yearStart: ov.yearStart ?? base.yearStart,
      yearEnd: ov.yearEnd ?? base.yearEnd,
      region: ov.region || base.region || "",
      note: ov.note || base.note || "",
      geoConfidence: ov.geoConfidence || base.geoConfidence,
      source: base.source === "override" ? "override" : `override+${base.source}`,
      glottocode: base.glottocode || null,
      parent: base.parent || null,
    });
  }

  for (const code of Object.keys(languages)) {
    applyDisclaimer(languages[code]);
    /* Drop nullish noise */
    if (languages[code].yearStart == null) delete languages[code].yearStart;
    if (languages[code].yearEnd == null) delete languages[code].yearEnd;
    if (!languages[code].region) delete languages[code].region;
    if (!languages[code].note) delete languages[code].note;
    if (!languages[code].glottocode) delete languages[code].glottocode;
    if (!languages[code].parent) delete languages[code].parent;
    if (languages[code].lat == null) {
      languages[code].lat = null;
      languages[code].lon = null;
      if (languages[code].geoConfidence !== "unavailable") {
        /* keep period_only/uncertain even without coords only if override set coords — else unavailable */
        if (languages[code].source !== "override" && !String(languages[code].source).startsWith("override")) {
          languages[code].geoConfidence = "unavailable";
        }
      }
    }
  }

  const stats = {
    total: Object.keys(languages).length,
    withCoords: Object.values(languages).filter((e) => e.lat != null && e.lon != null).length,
    byConfidence: {},
  };
  for (const e of Object.values(languages)) {
    stats.byConfidence[e.geoConfidence] = (stats.byConfidence[e.geoConfidence] || 0) + 1;
  }

  const atlas = {
    meta: {
      builtAt: new Date().toISOString(),
      glottologTag: GLOTTOLOG_TAG,
      glottologUrl: GLOTTOLOG_CSV,
      wiktionary: "Module:JSON data export_languages / export_etymology_languages",
      licenses: {
        wiktionary: "CC-BY-SA-4.0",
        glottolog: "CC-BY-4.0",
        overrides: "CC-BY-SA-4.0",
      },
      attribution: [
        "Wiktionary contributors (CC BY-SA 4.0)",
        "Hammarström, Forkel, Haspelmath & Bank — Glottolog (CC BY 4.0)",
      ],
      disclaimers: DISCLAIMER,
      stats,
    },
    aliases,
    languages,
  };

  writeFileSync(OUT, JSON.stringify(atlas) + "\n");
  console.log("Wrote", OUT);
  console.log("Stats", stats);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
