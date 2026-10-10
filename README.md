# Lexicon Earth

Local-first etymological globe: search a word, build a lineage graph from free structured sources, and view schematic geographic associations on a 3D Earth.

## Run

```bash
cd "Lexicon Earth"
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080).

ES modules and textures require a static server (`file://` is not supported).

## Architecture

| Layer | Role |
|--------|------|
| `js/sources/*` | Pluggable adapters (Wiktionary, Wikidata Lexemes, Kaikki) |
| `js/pipeline.js` | Normalize → candidates → fetch → cache |
| `js/model.js` | Forms, relationships, citations, epistemic labels |
| `js/db.js` | IndexedDB cache, import/export |
| `js/globe.js` | Three.js Earth + branching great-circle arcs |
| `data/starter.json` | Bundled offline example lineages |

Add a new source by implementing `SourceAdapter` (`searchCandidates`, `fetchLineage`) and registering it in `js/sources/index.js`.

## Sources & licenses

| Source | Use | License |
|--------|-----|---------|
| English Wiktionary (MediaWiki + REST) | Etymology templates, definitions | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |
| Wikidata Lexemes (SPARQL P5191/P5238) | Structured derivation links | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| Kaikki / Wiktextract | Optional structured assist (often CORS-blocked in browsers) | CC BY-SA 4.0 (from Wiktionary) |
| Natural Earth land & coastline 1:50m | B&W topographic wireframe outlines | Public domain |
| Texture renderer (`js/sketch-earth.js`) | Wireframe equirectangular map | App-generated from Natural Earth |
| three.js (CDN) | Rendering | MIT |

No API keys. No paid services.

## What works offline

- App shell, CSS, Natural Earth GeoJSON (via Service Worker after first visit)
- three.js / fonts (cached by Service Worker after first visit)
- IndexedDB-cached lineages (including starter set after first load)
- Globe interaction, lineage panel, citations already stored

## Needs internet

- First visit (to populate the Service Worker cache)
- New word lookups from Wiktionary / Wikidata / Kaikki

## Local cache

Open **About** (ℹ):

- Export / import JSON (`lexicon-earth-cache` format)
- Reload starter set
- Clear cache

Optional bulk helper (not required for normal use):

```bash
node scripts/ingest-kaikki.mjs dump.jsonl words.txt out.json
```

## Epistemic labels

Applied per form/relationship where possible:

- Attested
- Reconstructed
- Disputed
- Uncertain
- Inferred geographic association (language heartland ≠ documented travel route)

Routes on the globe are **schematic**.
