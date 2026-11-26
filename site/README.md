# Autonomous Safety: site (preview)

Vite + React + TypeScript. ECharts for the 2D charts, deck.gl (WebGL) for the crash explorer.
This first preview shows crash **counts and structure only**; normalized rates need sourced
mileage and fleet data, which is still being researched. Every tab says so.

## Data

The site currently reads four static JSON files from `public/data/` (the pipeline writes thirteen; see the root README), produced by the Python pipeline
(standard library only) from the raw NHTSA CSVs in `../data/raw/`:

```bash
npm run data        # same as: cd .. && python3 -m pipeline.run --offline
```

| File | Contents |
|---|---|
| `records.json` | One row per unique crash (columnar `{fields, rows}`), no narratives, with tags and speed band |
| `counts.json` | program x month x severity counts of unique crashes |
| `transparency.json` | program x field shares of provided / unknown / redacted |
| `meta.json` | NHTSA last-modified, fetch log (URL, SHA-256, rows), totals, tag rules |

A unique crash is a distinct `incident_key`. Its severity is the highest among its reports, and its
other fields come from that report. The generated JSON is committed so the site builds without Python.

## Develop and build

```bash
npm install
npm run dev         # http://localhost:5173/autonomous-safety/
npm run build       # type-check + production build into dist/
npm run preview     # serve dist/ at http://localhost:4173/autonomous-safety/
```

The base path is `/autonomous-safety/` (`vite.config.ts`) and data is fetched relative to
`import.meta.env.BASE_URL`. To deploy, publish the contents of `dist/` to the `gh-pages` branch.

## Notes

- Strings from the CSVs are only rendered as React text, never as HTML.
- Light and dark follow the OS setting (or `data-theme` on `<html>`).
- Source: `src/Overview.tsx`, `Explorer.tsx`, `Patterns.tsx`, `TransparencyTab.tsx`, `Sources.tsx`.
