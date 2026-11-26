# AV & ADAS Safety Disclosure Dashboard — Design

Date: 2026-11-26 · Status: draft for approval

## 1. Intent

A public website for looking at autonomous-vehicle and driver-assist crash data yourself,
to find patterns and compare companies fairly. The owner cares most about:

1. **Provenance**: every number traces to a primary source, with date range and caveats.
2. **Completeness**: every crash record NHTSA publishes is in the local database, not just totals.
3. **Freshness**: one click each month brings in new data, and it is validated before it goes live.
4. **Many lenses**: normalized rates, failure patterns, conditions and hardware, explored with
   interactive and WebGL views, not only bar charts.

Companies: **Tesla** (L2 Autopilot/FSD Supervised + Robotaxi ADS), **GM** (Super Cruise L2 +
Cruise ADS), **Waymo** (ADS), **Zoox / Custom** (the 4th slot can be any reporting entity).

## 2. Goals, non-goals, anti-goals

**Goals**
- Ingest all six NHTSA SGO crash files (ADS, ADAS, OTHER × current + archive), harmonize the
  two schemas, deduplicate, and publish the full record set plus aggregates.
- Curate company exposure disclosures (miles, fleet, subscribers) with a source on every row.
- Compute the requested metrics on annual (2019–present) and monthly (current year) timelines:
  crashes, fatal crashes, fatalities (see §6 caveat), injury crashes, active vehicles, miles per
  vehicle, crashes per 10k vehicles, per million miles, per 1k miles, and miles per crash.
- Company tabs, a head-to-head view, a crash explorer, and a data-health/provenance tab.
- Scenario controls that change assumptions live and are labeled as scenarios.
- A monthly GitHub Action plus a manual "Run update" trigger. It validates the data, then commits
  and deploys to GitHub Pages.

**Non-goals**
- Investment or legal conclusions. The site shows data and caveats, not verdicts.
- Precise geo maps. NHTSA redacts lat/long and ZIP, so the finest location is the city.
- Real-time data. NHTSA publishes roughly monthly (mid-month).

**Anti-goals (a failure even if it works)**
- Any figure without a visible source, or an estimate that looks like a reported number.
- A rate drawn without its uncertainty when counts or exposure are small.
- Silent schema drift: a changed NHTSA column dropping data without the update failing.
- Showing the June 2025 rule change as if it were a safety improvement.

## 3. What the data actually contains (verified 2026-11-26)

| File | Rows (unique reports) | Notes |
|---|---|---|
| current ADS (from 2025-06-16) | 1,792 | Waymo 1,452 · Avride 99 · Zoox 94 · Tesla 65 (Robotaxi) |
| current ADAS | 2,866 | Tesla 2,461 · GM 178 · Ford 53 … |
| current OTHER | ~46 | |
| archive ADS (2021-07 → 2025-06-15) | 2,295 | Waymo 1,281 · Cruise 207 · GM 201 · Zoox 124 |
| archive ADAS | 4,027 | Tesla 3,206 · Honda 159 · GM 71 … |
| archive OTHER | ~3,700 lines | |

Source: `https://static.nhtsa.gov/odi/ffdd/sgo-2021-01/[Archive-2021-2025/]SGO-2021-01_Incident_Reports_{ADS,ADAS,OTHER}.csv`
(last-modified 2026-11-16). The host serves files without CORS, so browsers cannot fetch them
directly. The www.nhtsa.gov page returns 403 to scripts, but the static host does not.

Facts that shape the design:
- **Incident date is month-year only** (e.g. `SEP-2026`). Monthly is the finest time grain.
- **Multiple versions per report** (`Report Version` 1–9). Keep the latest per `Report ID`.
  `Same Incident ID` links reports of the same crash from different entities, so dedupe on it
  to count crashes rather than reports.
- **Schemas differ between archive and current.** Current drops `Lighting`, `Posted Speed Limit`,
  `Mileage` and the HW/SW version columns. Injury labels change ("No Injuries Reported" →
  "No Injured Reported", "Minor" → "Minor W/ / W/O Hospitalization"). The weather fields are
  renamed. A mapping table harmonizes them, and fields missing from one schema stay null, never
  imputed.
- **Redaction**: Tesla redacts 2,460 of 2,461 current-ADAS narratives and 100% of feature
  versions. ~55% of its "Crash With" values are Unknown. Waymo narratives are detailed. This
  asymmetry is itself a dataset that the site visualizes.
- **Autopilot vs FSD cannot be split from NHTSA data** (feature version is CBI-redacted). That split
  exists only in Tesla's own Vehicle Safety Report, and is shown from that source with its 5-second
  method.
- **Fatalities**: SGO gives "Highest Injury Severity" per report, not a death count. "Fatal crashes"
  come from SGO; "total fatalities" need narratives/other sources and are left blank where unknown,
  never guessed.

## 4. Approaches considered (hosting/update)

1. Local app on the Mac + private claude.ai snapshot link: full local DB, but not public.
2. **GitHub repo + Pages + scheduled Action (chosen by owner)**: public, updates itself, versioned history.
3. Link-only artifact refreshed by asking Claude: simplest, but has no update button.

## 5. Architecture

Repo `av-safety-dashboard` (public, account Apoorva87) → GitHub Pages at
`https://apoorva87.github.io/av-safety-dashboard/`.

```
pipeline/            Python 3.9+, standard library only (runs locally and in Actions, no installs)
  fetch.py           download 6 SGO CSVs (+ ODI investigations flat file); record URL, ETag,
                     Last-Modified, sha256, bytes, rows → data/registry/fetch_log.json
  harmonize.py       schema map archive/current → one record shape; latest version per Report ID;
                     incident grouping by Same Incident ID; company/program mapping
  classify.py        failure pattern + conditions + hardware tags, each tag recording its basis
                     (structured-field rule vs narrative keyword) so redaction bias is visible
  validate.py        hard fails: unknown/missing columns, row count drop vs last run, unmapped
                     key entities, parse errors > 0.5%. Warnings: stale company disclosures.
  aggregate.py       metrics per company × program × period → site/public/data/*.json
data/raw/            latest raw CSVs (git history keeps every prior month)
data/manual/         hand-curated, every row sourced:
  exposure.csv       company, program, period, metric(miles|active_vehicles|subscribers|cum_miles),
                     value, kind(reported|derived|estimate), source_id, method_note
  sources.csv        source_id, publisher, title, url, published, date_range, methodology, caveats
  investigations.csv ODI investigation id, company, opened, status, scope, url
  events.csv         timeline annotations (Cruise permit suspension 2023-10, SGO amendment
                     2025-06-16, Tesla Robotaxi launch 2025-06, etc.)
site/                Vite + React + TypeScript; ECharts (2D, dual axis, sankey, heatmap,
                     parallel coords) + deck.gl (WebGL crash cloud, city columns on a MapLibre basemap)
.github/workflows/update.yml   cron monthly on the 20th + workflow_dispatch: fetch → validate →
                     commit data + changelog → build → deploy Pages. Fails loudly, deploys nothing.
```

The "Update data" button on the site opens the workflow's *Run* page on GitHub. A static page
can't trigger it without embedding a token, and that won't happen. The site shows "NHTSA data as
of …", "last pipeline run …", and a changelog ("+142 reports, 9 revised since last month").

Company exposure (miles, fleet) is published in PDFs and web pages, which can't be scraped
reliably. Those rows are curated by hand with sources. The pipeline flags each one as stale when
a newer disclosure is due (e.g. a Tesla quarterly report), and the site shows that flag.

## 6. Metrics and statistical honesty

- Counts: reports, unique crashes, fatal crashes, injury crashes (any severity above
  property-damage), serious+ crashes, VRU crashes (pedestrian/cyclist).
- Exposure: active vehicles, miles, miles per active vehicle (from §5 manual data, typed by `kind`).
- Rates: crashes / 10k vehicles, / 1M miles, / 1k miles = crashes ÷ miles × 1000, and miles/crash.
- **Every rate carries an exact Poisson 95% interval**, drawn as a band. When the expected count
  is below 10 or exposure is an estimate, the band is hatched with a "low sample / estimate" marker.
- **Reporting-lag correction**: the empirical lag (submission date − incident month) per company
  gives a completeness curve. Recent months can show "as reported" or "lag-adjusted". The lag
  multiplier slider defaults to the empirical value.
- **Structural break** line at 2025-06-16 (Third Amended SGO changed reportability thresholds).
- Tesla-reported metrics (5 s window, all crashes incl. non-SGO) and NHTSA SGO metrics (30 s
  window, reportable crashes only) are **never put in the same series**. They appear side by side,
  each labeled with its definition.

## 7. Views

1. **Overview / head-to-head**: KPI strip per company; normalized rate small multiples; a
   **funnel plot** (rate vs exposure with control limits, the standard way to compare units whose
   volumes differ wildly); a rank-over-time bump chart.
2. **Company tabs** (Tesla, GM, Waymo, Zoox/Custom): dual-Y chart (rate + CI band on the left,
   fleet/miles volume curve on the right, low-sample shading); program split (e.g. Tesla L2 vs
   Robotaxi, GM Super Cruise vs Cruise); severity mix; failure pattern breakdown; models/hardware;
   disclosures table; open ODI investigations.
3. **Crash explorer (WebGL)**: every unique crash as a point (deck.gl). Axes are user-selectable
   (month, pre-crash speed, severity, any categorical with jitter), with color, size and filter
   linked to a cross-filter panel. A parallel-sets/sankey view (pre-crash movement → crash
   partner → severity) shares the same filters. Click a point to see its full record, narrative
   and NHTSA Report ID.
4. **Patterns**: company × failure pattern heatmap (counts or share, with a toggle to normalize by
   exposure); a conditions matrix (road type × lighting × weather); a speed distribution
   ridgeline per company; a reporting-lag distribution.
5. **Where**: city-level 3D columns on a map (deck.gl ColumnLayer). Cities are geocoded from a
   bundled US Census gazetteer, and the redaction of exact location is stated on the map.
6. **Transparency**: per company × field, % Unknown / redacted (CBI) / provided, as a heatmap;
   narrative availability over time.
7. **Data & sources**: the full source registry, fetch log with hashes, validation report,
   changelog, methodology notes, and a CSV/JSON download of the harmonized dataset.

**Scenario panel** (global, persists in the URL so views are shareable):
- Reporting window 30 s (SGO) vs 5 s (Tesla). This applies a user-set capture factor to SGO
  counts. It is an assumption, labeled as such, because the SGO data has no engagement timing
  to re-derive from.
- Tesla denominator: all FSD-capable fleet vs active FSD subscribers vs Autopilot fleet.
- Estimated miles/fleet for non-disclosing companies (GM Super Cruise, Zoox), with sliders that
  default to sourced estimates.
- Reporting-lag multiplier, and an on/off toggle for lag adjustment.
Any metric computed under a non-default scenario carries a "scenario" badge.

## 8. Failure-pattern classification (rules, transparent)

Each crash gets 0..n tags. Each tag records its basis (`field` or `narrative`) and the rule ID.
The rules are published on the Data tab.
- intersection / signal: Roadway Type = Intersection, or narrative mentions signal / red light /
  stop sign, or CP movement crossing.
- reduced visibility / glare: Lighting dark/dawn/dusk, weather fog/rain/snow, narrative "glare / sun".
- roadway departure: SV movement "Lane / Road Departure", or Crash With fixed object at speed ≥ 25.
- stationary hazard: CP movement Stopped/Parked with SV moving, or crash with a fixed object,
  emergency vehicle, or debris.
- low-speed contact: SV speed ≤ 5 mph, or SV stopped and struck.
Conditions: weather, lighting, road type, surface, speed bands. Hardware: make, model, model year,
and the version-CBI flag.

## 9. Validation (fail the update, deploy nothing)

Column set differs from the expected schema · total unique reports drop vs previous run · a tracked
entity disappears · > 0.5% of rows fail date/number parsing · any exposure row lacks a source_id ·
aggregate totals don't reconcile to the record count. Warnings (deploy, but flag): stale
disclosures, a new reporting entity, a > 50% month-over-month swing for a company.

## 10. Calls made by the builder (owner can override)

- Repo name `av-safety-dashboard`, public, under Apoorva87; Pages from Actions.
- Python stdlib pipeline; Vite + React + TS + ECharts + deck.gl front end.
- Monthly cron on the 20th (NHTSA refreshes around the 15th–16th).
- Unique-crash counting (by Same Incident ID) by default; the report count is a toggle.
- 4th slot defaults to Zoox; a dropdown offers every other ADS/ADAS reporting entity.
- Pushing workflow files needs the `workflow` token scope: the owner runs
  `gh auth refresh -s workflow` once.

## 11. Left to the builder

Visual styling, exact chart composition per tab, and the classification keyword lists (published).
Also which disclosure figures exist for each period: research fills these in, and where none
exist the row is marked as an estimate or left blank.
