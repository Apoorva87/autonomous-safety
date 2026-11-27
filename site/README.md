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

## Rates tab

`src/Rates.tsx` with `src/lib/metrics.ts` (scope-matched rates, exact Poisson CI in `lib/poisson.ts`), `src/state/scenario.ts`
(assumptions kept in the URL query string) and `src/components/` (dual-axis chart, funnel plot, source badge, scenario panel,
coverage matrix, Tesla report panel). It reads `exposure.json`, `counts.json`, `lag.json`, `events.json`, `sources.json`,
`company_reported.json` and `records.json`, never `narratives.json`. Tests: `npm test`.

## Compound views

Loaded on demand (`React.lazy`), all reading the same JSON as the Rates tab (never `narratives.json`, except the Responsibility drawer); view state lives in the URL.

| Tab | Source | Notes |
|---|---|---|
| Impact map | `Impact.tsx`, `lib/impact.ts`, `components/CarOutline.tsx` | Reads `sv_contact_areas` / `cp_contact_areas` from `records.json` (lists of zone names; exported now). If they are ever missing the tab says so and shows crash-with counts. "Shade zones by" can colour each zone by the share of its crashes with one inferred label (`responsibility.json`, loaded only then). |
| Cities | `Cities.tsx`, `lib/cities.ts` | Explicit SGO city to Waymo exposure-region mapping (tested against `exposure.json`); counts-only ranking for cities without miles. |
| Timeline | `Timeline.tsx`, `lib/timeline.ts` | Brush to zoom (`tz0`, `tz1`); events and investigations; jumps to the explorer with `xf`, `xt`, `xp`. |
| Learning | `Learning.tsx`, `lib/learning.ts` | Quarterly rate against cumulative miles since the first disclosed month (log-log). |
| Claims | `Claims.tsx`, `lib/claims.ts` | Company-reported panels and NHTSA-derived panels are never merged. |
| Responsibility | `Responsibility.tsx`, `ResponsibilityList.tsx`, `ResponsibilityRules.tsx`, `lib/responsibility.ts`, `state/responsibilityData.ts` | Inferred labels (`responsibility.json`, `_rules.json`, `_audit.json`) with the "not a finding of fault" banner: label bars (share or count, confidence by stripes), an ECharts sankey (engagement to label), over-time panels, a paginated list with CSV export and a drawer that lazy-loads `narratives.json` (only the tab's drawer reads it), the rules, retired rules and narrative audit. View state: `rp`, `rsv`, `rm0`, `rm1`, `rv`, `rt`, `rf`, `rl`, `rr`, `rpg`, `rd`. |
| Explorer lenses | `Explorer.tsx`, `lib/lens.ts` | EA26002 and PE25012 presets (`xl`); an approximation of each probe, not its case list. |

## Exposure flags

Exposure rows whose method text says adjacent disclosure segments differ by more than 3x (`methodFlag` in `lib/metrics.ts`) carry `flag` on their `Point`; Rates (chart and table) and Timeline mark those months with a flag icon and the note.

## Notes

- Strings from the CSVs are only rendered as React text, never as HTML.
- Light and dark follow the OS setting (or `data-theme` on `<html>`).
- Source: `src/Overview.tsx`, `Explorer.tsx`, `Patterns.tsx`, `TransparencyTab.tsx`, `Sources.tsx`.
