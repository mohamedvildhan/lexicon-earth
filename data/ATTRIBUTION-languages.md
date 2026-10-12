# Language atlas — sources & licenses

Lexicon Earth’s language heartland atlas (`languages-atlas.json`) is built at
compile time from open datasets that permit commercial reuse. Pins are
**language heartlands / centroids**, not attested word-travel routes.

## Approved sources

| Source | Role | License | Attribution |
| --- | --- | --- | --- |
| [English Wiktionary](https://en.wiktionary.org/) `Module:JSON data` | Language & etymology-language codes, canonical names, aliases | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) (+ GFDL) | Wiktionary contributors |
| [Glottolog CLDF](https://glottolog.org/) | Lat/lon for language-level languoids; ISO/glottocode join | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Hammarström, Forkel, Haspelmath & Bank |
| Curated overrides (`data/language-overrides.json`) | Historical period codes, proto dates, region labels | CC BY-SA 4.0 (project) | Lexicon Earth maintainers |
| [Natural Earth](https://www.naturalearthdata.com/) | Globe land/coastline | Public domain | Natural Earth |
| [Wikidata Lexemes](https://www.wikidata.org/) | Optional structured etymology edges (runtime) | [CC0](https://creativecommons.org/publicdomain/zero/1.0/) | Wikidata contributors |
| [Kaikki / Wiktextract](https://kaikki.org/) | Optional structured templates (runtime) | CC BY-SA 4.0 (from Wiktionary) | Kaikki.org / Wiktionary contributors |

## Exclusions (do not use)

- **Ethnologue World Language Mapping System** — proprietary polygons
- **SIL ISO 639-3 code tables as a redistributable dump** — may be incorporated into software under SIL terms, but must not be redistributed as a downloadable code set; join ISO via Glottolog fields instead
- **OpenGloss** — CC BY 4.0, but LLM-synthesized etymology conflicts with Lexicon’s honesty rules

## ShareAlike note

Any bundled atlas JSON that includes Wiktionary-derived names/codes is a
derivative under **CC BY-SA 4.0**. Redistribution must attribute Wiktionary and
share adaptations under the same license. Glottolog coordinates require **CC BY 4.0**
attribution (Hammarström et al.).

## Confidence tiers

Each atlas entry carries `geoConfidence`:

| Tier | Meaning |
| --- | --- |
| `precise` | Glottolog language-level point |
| `approximate` | Family centroid or curated regional pin |
| `uncertain` | Reconstructed / debated proto homeland |
| `period_only` | Etymology-period code shown at a parent heartland |
| `unavailable` | Name known; no map pin (bridged hop) |

## Rebuild

```bash
node scripts/build-language-atlas.mjs
```

Regenerate after Glottolog or Wiktionary language-module updates. Record the
Glottolog tag and build date in the atlas `meta` block.
