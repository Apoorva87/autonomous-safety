# AV & ADAS Safety Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public GitHub Pages site that ingests every NHTSA SGO crash report plus sourced company exposure data each month, validates it, and lets the viewer compare Tesla, GM, Waymo and Zoox/custom through normalized, uncertainty-aware, interactive (incl. WebGL) views.

**Architecture:** A Python standard-library pipeline (`pipeline/`) fetches → harmonizes → classifies → validates → writes compact JSON into `site/public/data/`. A Vite + React + TypeScript site computes every rate client-side from counts + exposure, so the scenario controls recompute live. A GitHub Action runs the pipeline monthly or on demand, and deploys only if validation passes.

**Tech Stack:** Python 3.9+ (stdlib only, `unittest`), Node 20+, Vite 5, React 18, TypeScript 5, ECharts 5, deck.gl 9, MapLibre GL 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-26-av-safety-dashboard-design.md`

## Global Constraints

- Pipeline: Python stdlib only; must run on Python 3.9 (local) and 3.12 (Actions).
- Every exposure/baseline number carries a `source_id` that resolves in `data/manual/sources.csv`; `kind` ∈ {`reported`,`derived`,`estimate`}.
- Unique-crash counting via `Same Incident ID` by default; a blank `Same Incident ID` means its own incident.
- Keep the highest `Report Version` per `Report ID`.
- Structural break at **2025-06-16** (Third Amended SGO) is drawn on every time chart.
- NHTSA SGO metrics (30 s window) and Tesla Vehicle Safety Report metrics (5 s window) never share a series.
- Every rate shows an exact Poisson 95% CI. Low-sample = expected count < 10 or `kind=estimate` exposure → hatched + labeled.
- Monthly cron: `0 14 20 * *` + `workflow_dispatch`. Failed validation → no commit, no deploy.
- Site base path `/autonomous-safety/`. Narratives and all CSV-derived strings render as text, never HTML.
- Company keys: `tesla`, `gm`, `waymo`, `zoox`, `other`. Program keys: `tesla_l2`, `tesla_robotaxi`, `gm_supercruise`, `gm_cruise_ads`, `waymo_ads`, `zoox_ads`, `other_ads`, `other_l2`.

## Review Focus

1. A new NHTSA categorical label (severity, crash-with, roadway…) not in the mapping → validation fails and names the label; it is never silently mapped to `unknown`.
2. Blank/whitespace `Same Incident ID` (45 archive ADAS rows) → each such report is its own incident, not one giant merged incident.
3. Period with missing or zero exposure → the rate shows "no denominator" (null), never `Infinity`/`0`; zero crashes with miles → miles/crash shows "> lower bound (0 crashes)".
4. Latest report version changes entity/month vs v1 → the latest version's values win everywhere, incl. counts.
5. Hostile/odd text: narratives with `<script>`, CSV fields with embedded newlines/quotes, state codes with trailing spaces (`"CA "`) → render as text, parse intact, normalize by trimming.

---

### Task 1: Repo scaffold + fetch

**Files:**
- Create: `pipeline/__init__.py`, `pipeline/config.py`, `pipeline/fetch.py`, `pipeline/tests/test_fetch.py`, `.gitignore`, `README.md`

**Interfaces:**
- Produces: `config.SGO_FILES: list[dict]` (`{"key": "current_ADS", "era": "current", "kind": "ADS", "url": ...}` ×6); `config.RAW_DIR`, `config.OUT_DIR = site/public/data`, `config.MANUAL_DIR = data/manual`.
- Produces: `fetch.fetch_all(raw_dir: Path, opener=urllib.request.urlopen) -> list[dict]` writing `data/registry/fetch_log.json` entries `{key, url, retrieved_at, last_modified, etag, sha256, bytes, rows}`.

- [ ] Step 1: `git init`; write test `test_fetch_records_hash_and_rows` with a fake opener returning a 3-row CSV (one quoted field with an embedded newline). Assert `rows == 3`, `sha256` matches `hashlib.sha256(body)`, and the file is written to `raw_dir/current_ADS.csv`.
- [ ] Step 2: Run `python3 -m unittest discover -s pipeline/tests -v` → FAIL (no module).
- [ ] Step 3: Implement `fetch_all`. Rows are counted with `csv.reader` (not line count). Send a browser-like User-Agent, use a 120 s timeout and 3 retries with backoff.
- [ ] Step 4: Run tests → PASS. Run `python3 -m pipeline.fetch` live → 6 files, rows ≈ 1792/2866/46/2295/4027/~1000+.
- [ ] Step 5: Commit `feat(pipeline): fetch SGO files with provenance log`.

### Task 2: Harmonize schemas, versions and incidents

**Files:**
- Create: `pipeline/schema.py`, `pipeline/harmonize.py`, `pipeline/tests/fixtures/{archive_ADAS,current_ADS}.csv`, `pipeline/tests/test_harmonize.py`

**Interfaces:**
- Consumes: raw CSV paths from Task 1.
- Produces: `harmonize.load_all(raw_dir) -> list[Record]` where `Record` is a dict:
  `id, ver, incident_key, file(ADS|ADAS|OTHER), era, entity, company, program, month("YYYY-MM"|None), submitted("YYYY-MM-DD"|None), lag_days, make, model, model_year, city, state, roadway_type, surface, lighting, weather(list[str]), speed_mph, speed_limit, crash_with, cp_movement, sv_movement, severity(fatal|serious|moderate|minor|none|unknown), hospitalized(bool|None), airbag(bool|None), towed(bool|None), within_odd, narrative, narrative_redacted(bool), version_redacted(bool), unknown_fields(int)`.
- Produces: `schema.UNMAPPED: set[tuple[field, value]]`, filled during load, for Task 5.
- Produces: `schema.EXPECTED_COLUMNS: dict[str(era_kind), frozenset]`, frozen from today's files.

- [ ] Step 1: Write fixtures. Archive rows: one report at v1 and v2 (v2 changes the month), two entities sharing one Same Incident ID, a blank Same Incident ID ×2, state `"CA "`, and a `<script>` narrative. Current rows: severity `"Minor W/ Hospitalization"` and `"Property Damage. No Injured Reported"`.
- [ ] Step 2: Write tests:
  - `test_latest_version_wins`: one record with `ver==2`, month from v2.
  - `test_blank_incident_ids_not_merged`: two distinct `incident_key`s.
  - `test_shared_incident_grouped`: same `incident_key`.
  - `test_severity_mapping`: `minor` + `hospitalized is True`; `none` + `hospitalized is False`.
  - `test_state_trimmed`: `"CA"`.
  - `test_unmapped_label_recorded`: an injected label `"Catastrophic"` lands in `UNMAPPED`.
  - `test_program_mapping`: Tesla ADS→`tesla_robotaxi`, GM ADAS→`gm_supercruise`, Cruise LLC→`gm_cruise_ads`, GM ADS→`gm_cruise_ads`.
  - `test_month_parse`: `"SEP-2026"`→`"2026-09"`.
- [ ] Step 3: Run → FAIL.
- [ ] Step 4: Implement. `schema.py` holds per-era column → field maps and value maps for severity, lighting, roadway, crash-with and movement, built from the full distinct-value lists in today's six files (enumerate them first). `incident_key` = `Same Incident ID.strip()` or `"solo:"+Report ID`. `lag_days` = submitted − last day of the incident month (≥0).
- [ ] Step 5: Run → PASS; run against the live raw files and print counts per program. Expect `UNMAPPED` to be empty.
- [ ] Step 6: Commit `feat(pipeline): harmonize archive/current SGO schemas`.

### Task 3: Classification tags

**Files:**
- Create: `pipeline/classify.py`, `pipeline/tests/test_classify.py`

**Interfaces:**
- Produces: `classify.tag(record) -> list[{"t": str, "basis": "field"|"narrative", "rule": str}]`, where `t` ∈ {`intersection_signal`,`visibility_glare`,`roadway_departure`,`stationary_hazard`,`low_speed`,`vru`}; `classify.RULES: list[dict(id, t, basis, description)]` (published on the Data tab); plus `speed_band(record) -> "0"|"1-5"|"6-15"|"16-30"|"31-50"|"51+"|"unknown"`.

- [ ] Step 1: Tests:
  - `roadway_type=Intersection` → `intersection_signal/field/INT-1`.
  - Narrative "ran a red light" → `INT-2/narrative`.
  - `sv_movement="Lane / Road Departure"` → `DEP-1`.
  - `speed 3` → `low_speed/LOW-1`.
  - Crash with Pedestrian/Cyclist → `vru`.
  - A redacted narrative yields no narrative-basis tags.
  - Tags are de-duplicated by `t`, preferring field basis.
- [ ] Step 2: FAIL → Step 3: implement the rules from spec §8 → Step 4: PASS.
- [ ] Step 5: Commit `feat(pipeline): transparent failure-pattern tagging`.

### Task 4: Curated sources & exposure (research)

**Files:**
- Create: `data/manual/sources.csv`, `data/manual/exposure.csv`, `data/manual/investigations.csv`, `data/manual/events.csv`, `data/manual/disclosure_cadence.csv`, `pipeline/manual.py`, `pipeline/tests/test_manual.py`

**Interfaces:**
- Produces: `manual.load() -> {"sources": [...], "exposure": [...], "investigations": [...], "events": [...], "cadence": [...]}`, raising `ManualDataError` on a missing `source_id`, bad `kind`, a non-numeric value, or a duplicate (company, program, period, metric, kind).
- `exposure.csv` columns: `company,program,period,period_type(year|quarter|month|cumulative_to),metric(miles|active_vehicles|subscribers|cum_miles),value,kind,source_id,method_note`.
- `cadence.csv`: `company,program,metric,expected_every_days,last_period`, used for stale warnings.

- [ ] Step 1: Tests: a fixture exposure row with an unknown `source_id` raises; `kind="guess"` raises; a valid fixture loads.
- [ ] Step 2: FAIL → implement `manual.py` → PASS.
- [ ] Step 3: Research from primary sources and fill the CSVs, with a URL and published date per source:
  - **Tesla:** quarterly Vehicle Safety Report (miles per crash, Autopilot vs FSD vs no-AP), cumulative FSD miles, FSD subscriber/active-user counts, Robotaxi fleet and miles.
  - **Waymo:** Safety Impact hub rider-only miles by period and city, fleet size, IIHS/Swiss Re matched study results.
  - **GM:** Super Cruise cumulative miles, equipped vehicles and subscribers; Cruise driverless miles to 2023-10; shutdown/merger dates.
  - **Zoox:** CA DMV and company miles, fleet.
  - **ODI investigations** (PE25012, EA26002, and others found).
  - **Events:** permits, launches, SGO amendments.

  Where a period has no disclosure, use an `estimate` row with method_note, or leave the period absent.
- [ ] Step 4: `python3 -m pipeline.manual` loads cleanly. Commit `data: curated exposure & source registry`.

### Task 4b: Golden database (inserted by owner direction; spec §12)

**Files:**
- Create: `pipeline/golden.py`, `pipeline/build_db.py`, `pipeline/tests/test_golden.py`, `data/golden/*.jsonl`

**Interfaces:**
- Consumes: raw CSVs, `harmonize.load_all`, `classify.tag`, `manual.load`.
- Produces: `golden.build(raw_dir, manual, run_id) -> dict[table, list[dict]]` for the tables in spec §12; each normalized field carries a status in `{provided, reported_unknown, redacted_cbi, not_collected_in_era, not_applicable}`; `build_db.write_sqlite(tables, path)`.

- [ ] Test first: all raw columns survive (column set of `reports` ⊇ every source column); all report versions kept with exactly one `is_latest` per Report ID; a current-era row has `lighting` status `not_collected_in_era`; a CBI-redacted narrative has `redacted_cbi`; rebuilding twice gives byte-identical JSONL; a changed row bumps `last_seen_run` only for unchanged hashes.
- [ ] Implement, run on the live files, check row counts against the fetch log; commit.

### Task 5: Aggregate, validate, orchestrate

**Files:**
- Create: `pipeline/aggregate.py`, `pipeline/validate.py`, `pipeline/run.py`, `pipeline/tests/test_aggregate.py`, `pipeline/tests/test_validate.py`, `data/registry/expected_entities.json`

**Interfaces:**
- Consumes: golden tables (Task 4b) plus `load_all`, `tag`, `manual.load`, `schema.UNMAPPED`, `schema.EXPECTED_COLUMNS`.
- Produces in `site/public/data/`:
  - `records.json`: columnar `{fields: [...], rows: [[...]]}`, no narratives.
  - `narratives.json`: `{id: text}`.
  - `counts.json`: rows `{program, company, month, file, reports, crashes, fatal, serious_plus, injury, vru}`. Crashes are unique `incident_key` per program; an incident's severity is the max across its reports.
  - `lag.json`: `{program: [cdf of lag_days at 0..365 step 15]}`.
  - `exposure.json`, `sources.json`, `investigations.json`, `events.json`, `rules.json`, `transparency.json` (program × field → provided/unknown/redacted shares), `meta.json` (`{nhtsa_last_modified, run_at, counts_total, warnings[], fetch_log}`), and `changelog.json` (prepend `{run_at, new_reports, revised_reports, removed_reports}` vs the previous `records.json`).
- Produces: `validate.check(records, manual, previous_meta) -> (errors: list[str], warnings: list[str])`.
- Produces: `python3 -m pipeline.run [--offline]` → exit 1 if errors.

- [ ] Step 1: Tests:
  - Aggregate: two reports of one incident count as `reports==2, crashes==1`, and the incident takes its higher severity.
  - Validate: an extra column → error naming it; `UNMAPPED` non-empty → error naming the label; unique reports drop vs `previous_meta.counts_total` → error; a missing expected entity → error; a stale cadence → warning only; a counts sum != number of unique incidents → error.
- [ ] Step 2: FAIL → implement → PASS.
- [ ] Step 3: `python3 -m pipeline.run --offline` on today's raw files → exit 0. Check record counts by program (sanity check: Tesla L2 crashes in the thousands, Waymo ADS in the thousands).
- [ ] Step 4: Commit `feat(pipeline): aggregates, validation, orchestrator`.

### Task 6: GitHub Action

**Files:**
- Create: `.github/workflows/update.yml`

- [ ] Step 1: Workflow with `on: schedule (0 14 20 * *)` + `workflow_dispatch` + `push` to main (paths `site/**`, `data/manual/**`, `pipeline/**`). Its job runs `pipeline.run` (fetch) → `unittest` → if the data changed, commits as `github-actions[bot]` → `npm ci && npm run build` in `site/` → `actions/upload-pages-artifact` + `actions/deploy-pages`. Permissions: `contents: write, pages: write, id-token: write`.
- [ ] Step 2: Validate YAML locally (`python3 -c "import json,sys"`; a structural review is fine). Live verification happens in Task 11.
- [ ] Step 3: Commit `ci: monthly validated data refresh + Pages deploy`.

### Task 7: Site core: data, metrics, scenario state

**Files:**
- Create: `site/` (Vite React TS), `site/src/data/load.ts`, `site/src/lib/metrics.ts`, `site/src/lib/poisson.ts`, `site/src/state/scenario.ts`, `site/src/lib/metrics.test.ts`, `site/src/lib/poisson.test.ts`, `site/src/App.tsx` (tab shell + header with "NHTSA data as of", run date, warnings, and the Run update link `https://github.com/Apoorva87/autonomous-safety/actions/workflows/update.yml`)

**Interfaces:**
- `poisson.ci95(k: number): [lo: number, hi: number]`: exact (chi-square via the gamma inverse). `k=0` → `[0, 3.689]`.
- `metrics.series(counts, exposure, scenario, opts: {program[], grain: "year"|"month", year?: number, metric: "per1k"|"perM"|"per10kVeh"|"milesPerCrash"|"count", countBy: "crashes"|"reports", severity?: ...}) -> Point[]`, where `Point = {period, k, kAdj, exposure: number|null, exposureKind, rate: number|null, lo, hi, lowSample: boolean, scenario: boolean}`.
- `scenario.ts`: a `useScenario()` hook backed by URL query params. Fields: `windowFactor` (5 s capture factor, default 1 = SGO as-is), `teslaDenominator: "fleet"|"subscribers"|"ap_fleet"`, `estimates: Record<program, {milesPerVehicleYear: number, fleet: number}>`, `lagAdjust: boolean`, `lagMultiplier: number`, `countBy`, `includeOther: boolean`.

- [ ] Step 1: Scaffold Vite React TS. Set `base: '/autonomous-safety/'`. Add echarts, @deck.gl/core/layers/react, maplibre-gl, vitest.
- [ ] Step 2: Tests:
  - `ci95(0)[1]≈3.689`; `ci95(10)≈[4.795,18.39]`.
  - per1k = crashes/miles×1000; milesPerCrash = miles/crashes.
  - exposure null → `rate===null`.
  - Zero crashes with miles → `milesPerCrash` null, with `lo` set to miles/3.689.
  - expected < 10 → `lowSample`.
  - A non-default `windowFactor` → `scenario===true`.
  - `lagAdjust` divides recent-month counts by the CDF at their age.
- [ ] Step 3: FAIL → implement → PASS (`npx vitest run`).
- [ ] Step 4: `npm run build` succeeds. Commit `feat(site): data layer, metrics, scenario state`.

### Task 8: Overview + company tabs

**Files:**
- Create: `site/src/components/DualAxisChart.tsx`, `KpiStrip.tsx`, `FunnelPlot.tsx`, `SmallMultiples.tsx`, `BumpChart.tsx`, `ScenarioPanel.tsx`, `SourceBadge.tsx`, `site/src/views/Overview.tsx`, `site/src/views/Company.tsx`

**Interfaces:**
- Consumes: `metrics.series`, `useScenario`, data from `load.ts`.
- `DualAxisChart({points, volume, events, metricLabel})`: CI band + line on the left Y axis, volume area on the right Y axis, hatched markArea where `lowSample`, markLine at 2025-06-16 and other `events`.
- `SourceBadge({sourceIds})`: an ⓘ popover showing publisher, URL, date range and caveats.

- [ ] Step 1: Build the views per spec §7.1–7.2. The Company tab takes a `company` prop, and the 4th tab has an entity dropdown. Show Tesla's VSR metrics as a separate labeled panel.
- [ ] Step 2: `npm run dev` and check in the browser: every chart has a source badge, the break line is visible, toggling the scenario updates charts and shows the scenario badge, and the URL round-trips.
- [ ] Step 3: Commit `feat(site): overview and company views`.

### Task 9: Crash explorer + patterns + map + transparency

**Files:**
- Create: `site/src/views/Explorer.tsx` (deck.gl ScatterplotLayer, OrthographicView, selectable axes, crossfilter facet panel, detail drawer), `site/src/components/ParallelSets.tsx` (ECharts sankey), `site/src/views/Patterns.tsx` (heatmap, conditions matrix, speed ridgelines, lag histogram), `site/src/views/WhereMap.tsx` (deck.gl ColumnLayer + MapLibre, OpenFreeMap style), `site/public/data/cities.json` (built by `pipeline/geo.py` from the Census gazetteer, US places), `site/src/views/Transparency.tsx`, `site/src/lib/crossfilter.ts`, `site/src/lib/crossfilter.test.ts`

**Interfaces:**
- `crossfilter.apply(records, filters: Record<field, Set<value> | [min,max]>) -> Uint32Array` of matching row indices; `crossfilter.facetCounts(records, idx, field) -> Map<value, number>`.

- [ ] Step 1: crossfilter tests: range + set filters intersect; empty filters → all rows; facet counts sum to `idx.length`.
- [ ] Step 2: FAIL → implement → PASS.
- [ ] Step 3: Build the views. Narrative text goes in via `textContent`/React text only. The map states "exact location redacted by NHTSA; city centroid shown".
- [ ] Step 4: Browser check: 10k points pan/zoom smoothly, brushing the facets updates scatter + sankey + count, and clicking a point shows its narrative and Report ID.
- [ ] Step 5: Commit `feat(site): WebGL explorer, patterns, map, transparency`.

### Task 10: Data & sources tab

**Files:**
- Create: `site/src/views/DataSources.tsx`

- [ ] Step 1: Tables for the source registry, fetch log (hash, bytes, last-modified), validation warnings, changelog, classification rules and methodology notes (30 s vs 5 s, CBI, rule change, dedupe, Poisson). Add download buttons for `records.json`/CSV.
- [ ] Step 2: Browser check, then commit `feat(site): data provenance tab`.

### Task 11: Publish

- [ ] Step 1: `gh repo create Apoorva87/autonomous-safety --public --source . --push` (requires the owner's `gh auth refresh -s workflow`).
- [ ] Step 2: `gh api -X POST repos/Apoorva87/autonomous-safety/pages -f build_type=workflow`; `gh workflow run update.yml`; watch the run.
- [ ] Step 3: Open `https://apoorva87.github.io/autonomous-safety/` in the browser; check every tab loads with no console errors and the header shows today's NHTSA date.
