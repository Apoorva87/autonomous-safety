# Autonomous Safety

An open, source-traced reference dataset and dashboard for crash and exposure disclosures from
autonomous-driving (ADS) and driver-assist (ADAS) programs: **Tesla** (Autopilot, FSD Supervised,
Robotaxi), **GM** (Super Cruise + Cruise), **Waymo**, **Zoox**, and any other company that
reports to NHTSA.

> **Status: work in progress.** The sections marked **Built** exist today. Everything marked
> **Planned** is intended future work, documented here so anyone can pick it up.

## Why this exists

1. **Provenance first.** Every number traces to a primary source, with date range and methodology caveats.
2. **Completeness.** Keep every field every source gives us. Where a source is silent, record it as
   *unavailable* (with the reason), never as a silent blank.
3. **Refreshable.** One monthly refresh pulls new data, validates it and republishes.
4. **Many lenses.** Compare companies fairly with normalized, uncertainty-aware rates, and explore
   the raw incidents in many ways, not only bar charts.

The long-term product is a **golden reference database** that we keep growing. Visualizations
are separate consumers of it, so new chart tabs and new front-end technologies can be added
without touching ingestion.

## Architecture

```
sources → pipeline (fetch → harmonize → classify → validate) → golden database → site(s)
```

| Layer | Where | Status |
|---|---|---|
| Fetch NHTSA SGO files with a provenance log (URL, ETag, SHA-256, row counts) | `pipeline/fetch.py`, `data/registry/` | **Built** |
| Harmonize the old (2021–Jun 2025) and new (Jun 2025–) NHTSA formats; latest version of each report; group reports into unique crashes | `pipeline/harmonize.py`, `pipeline/schema.py` | **Built** |
| Transparent failure-pattern tags (each records whether it came from a structured field or the narrative) | `pipeline/classify.py` | **Built** |
| Curated company disclosures (miles, fleet, subscribers, company-reported safety metrics, investigations, events), each row with a source | `data/manual/`, `pipeline/manual.py` | In progress |
| Golden database: every source column, every report version, explicit missing-value reasons (see [Golden database](#golden-database)) | `pipeline/golden.py`, `pipeline/build_db.py`, `data/golden/` | **Built** |
| Aggregation + validation gates (a bad update deploys nothing) | `pipeline/aggregate.py`, `validate.py` | **Planned** |
| Monthly GitHub Action + GitHub Pages deploy | `.github/workflows/` | **Planned** |
| Dashboard: head-to-head, company tabs, WebGL crash explorer, patterns, city map, transparency | `site/` | **Planned** |

Design: [`docs/superpowers/specs/2026-11-26-av-safety-dashboard-design.md`](docs/superpowers/specs/2026-11-26-av-safety-dashboard-design.md).
Implementation plan: [`docs/superpowers/plans/2026-11-26-av-safety-dashboard.md`](docs/superpowers/plans/2026-11-26-av-safety-dashboard.md).

## Data sources

- **NHTSA Standing General Order 2021-01** crash reports (ADS, Level 2 ADAS, Other), current and
  archive files, from `static.nhtsa.gov/odi/ffdd/sgo-2021-01/`. Raw files are in `data/raw/`.
- **Company disclosures** (Tesla Vehicle Safety Report, Waymo Safety Impact hub, GM and Zoox
  filings, CA DMV/CPUC data) in `data/manual/`, one row per figure, each with `source_id` →
  `sources.csv` (publisher, URL, date range, methodology, caveats, where in the document it sits).
- **NHTSA ODI investigations** (e.g. PE25012, EA26002).

### Known data caveats (read before drawing conclusions)

- SGO counts reportable crashes within a **30-second** engagement window; Tesla's own report uses
  a **5-second** window. The two are never put in one series.
- NHTSA reporting rules changed on **2025-06-16**; the break is marked on time charts, so a drop is
  not read as improvement.
- Tesla redacts most narratives and its software version as confidential business information,
  so Autopilot vs FSD cannot be separated in NHTSA data, and description-based failure tags are
  unavailable for Tesla.
- Incident dates are **month-level** only; exact GPS and ZIP are redacted (city is the finest location).
- SGO records injury severity per report, **not a count of deaths**.
- Mileage/fleet figures differ in reliability: each is labelled `reported`, `derived` or
  `estimate`. Estimates are never shown as reported numbers.

## Golden database

The durable asset. Every column of every SGO report version is kept, merged into one format, and
nothing is silently blank. Built by `python3 -m pipeline.build_db [--run-id ID]` into `data/golden/`
(about 6 s). Run it once per refresh, and **only after the validation gate (Task 5) has passed**: a
build records a run and commits to whatever the raw files contain. Unchanged reports are not
rewritten, so a refresh only diffs rows that are new, changed or removed, plus one new line in
`runs.jsonl`. The JSONL files are written atomically (temp files, then rename).

**Storage.** One JSONL file per table (sorted by key, keys sorted, UTF-8, `\n` line endings, so an
unchanged rebuild is byte-identical) is the canonical, committed store. `reports` is about 106 MB,
so it is split into `reports.<era>_<kind>.jsonl` shards (30 MB at most; the builder switches to
shards by itself above 60 MB). `data/golden/golden.sqlite` is compiled from the JSONL as a download and
is **not committed** (git-ignored; rebuild it with the command above).

| Table | One row per | Notes |
|---|---|---|
| `reports` | (Report ID, Report Version) in any SGO file | Every version kept. `raw` holds every source column (see notes below; columns the era lacks are absent); the normalized fields sit beside it, with a `status` per field. `row_hash`, `first_seen_run`, `removed_in_run`, `previous_row_hash` trace corrections and withdrawals (`last_seen_run` is derived, in sqlite only). |
| `incidents` | `incident_key` (Same Incident ID, else `solo:<id>`) | Member `report_ids`, all `report_keys`, `latest_report_keys`, companies, programs, month, max severity. |
| `sources`, `exposure`, `company_reported`, `investigations`, `events`, `cadence` | the hand-curated rows of `data/manual/` | Copied unchanged (including `region`, `recall_units`, `date_precision`). |
| `runs` | build | Run id, `rules_version`, NHTSA `Last-Modified` and SHA-256 per file, row counts, placeholder rows, unmapped labels. |
| `labels` | (report version, label set) | Reserved for the future AI avoidability analysis. **Keyed by `report_key`, i.e. per report version**, a deliberate deviation from the spec sketch (which said `report_id`), so a label always points at the exact text it judged. Created empty, and the builder never writes or deletes label rows once present. Columns: `report_key, label_set, label, rationale, evidence_fields, model, prompt_version, run_at`. |

**Field status.** Each normalized field has one of five statuses in `reports.status`. The UI shows
the last four as "unavailable" and the status as the reason.

| Status | Meaning |
|---|---|
| `provided` | The source gave a value. |
| `reported_unknown` | The column exists but says Unknown, or is blank. |
| `redacted_cbi` | The value is the redaction marker, or its CBI flag is Y (Tesla's narratives and versions, most "Within ODD?" answers). |
| `not_collected_in_era` | The column does not exist in this report's era (for example `lighting` after 2025-06-16). |
| `not_applicable` | The field does not apply (placeholder filing, no crash partner, consumer-owned vehicle, "N/A" agency). |

The rules live in one table, `golden.STATUS_RULES`. `golden.RULES_VERSION` is a short string that
is bumped by hand whenever a schema map, a status rule or the classify rules change, and is
stored in every `runs` row; `row_hash` covers only the raw row, so this is how you tell which
rules produced the normalized fields.

**Things to know when reading `reports`.**

- **`raw` is trimmed, and not byte-lossless.** Values are whitespace-trimmed only, and undecodable
  bytes in the source CSV are replaced with U+FFFD (one such row today, in `archive_ADAS`). The
  lossless pointer is the source file's SHA-256 recorded per run in `runs.file_sha256`
  (and `data/registry/fetch_log.json`).
- **`is_latest`:** exactly one row per Report ID is `is_latest` among the non-removed rows
  (`removed_in_run IS NULL`). If the newest version vanishes from the source, the next one down
  takes over; if every version vanishes, the ID has none. Removed rows keep their data and
  have `is_latest = 0`.
- **Placeholder filings carry `is_latest = 1` too.** "No New or Updated Incident Reports" rows are
  kept (`is_placeholder = true`, every status `not_applicable`) but are not crashes. Consumers must
  filter `is_placeholder = false`; the sqlite view `latest_reports` already does (and drops
  removed rows). Incidents are built without placeholders.
- **`last_seen_run`** exists only in sqlite: the latest run in `runs` for rows still in the source,
  or the run before `removed_in_run` for removed rows.
- **PII-withheld cells** (`[MAY CONTAIN PERSONALLY IDENTIFIABLE INFORMATION]` in VIN, serial number,
  latitude/longitude, address, ZIP, officer details) stay in `raw` only and have no normalized field,
  because the five statuses have no PII reason. If needed later, a derived `pii_withheld` flag per
  report is the option, rather than overloading `redacted_cbi`.

**Query it.**

```bash
sqlite3 data/golden/golden.sqlite
```
```sql
-- Latest Tesla L2 reports by month
SELECT month, COUNT(*) FROM latest_reports WHERE program = 'tesla_l2' GROUP BY month ORDER BY month;
-- How often is lighting unavailable, and why
SELECT json_extract(status, '$.lighting') AS why, COUNT(*) FROM latest_reports GROUP BY why;
-- Subject vehicle struck at the rear while stopped (inputs for the avoidability analysis)
SELECT report_key, sv_movement, sv_contact_areas FROM latest_reports
WHERE sv_movement = 'stopped' AND sv_contact_areas = '["rear"]';
-- Every source column of one report
SELECT raw FROM reports WHERE report_key = '<Report ID>|v1';
```

**Built vs planned.** Built: the tables above, the JSONL store (atomic writes), sqlite compile, field statuses,
version and withdrawal tracking, `rules_version`. Planned: filling `labels` (AI avoidability analysis), validation
gates that run before a build is committed, and the site reading its exports from the golden store.

## Planned work (not yet implemented)

Anyone is welcome to pick these up.

- **AI avoidability analysis.** Classify each incident as *unavoidable by an automated driver*
  (e.g. struck from behind or the side while stopped) vs. *plausibly the automation's fault*. The
  data to support it is retained (SV/CP contact areas, pre-crash movement, speed, engagement,
  narrative where not redacted). Plan: a rules-based first pass on structured fields, then an
  LLM pass for narratives, stored in a versioned `labels` table with model, prompt version,
  rationale and evidence fields; labels never overwrite source data.
- **Responsibility ("who was at fault") lens.** NHTSA records no fault field, so this is an *inference*,
  always labeled with its evidence basis and confidence, never presented as a finding of fault.
  Outputs: other party / automated system / human driver (Level 2 only) / indeterminate. Pass 1:
  rules on structured fields (SV/CP contact areas, pre-crash movements, speed, crash-with, engagement).
  Pass 2: an LLM reads narratives where they are not redacted (Waymo, Zoox, Cruise; almost none
  for Tesla) and is used to calibrate and audit pass 1. For Level 2 programs, driver vs. system cannot
  be separated from NHTSA data; the lens says so rather than guessing. Stored in the `labels` table.
- **More compound views (planned tabs):** exposure learning curves (rate vs cumulative miles); a car-outline
  impact heatmap (contact areas by program, filterable by speed and severity); a movement → partner →
  contact → severity → inferred-responsibility Sankey; per-city rates (SGO city counts joined with
  Waymo's per-city miles); a timeline overlay of launches, recalls, investigations and rule changes on rate
  curves; company-reported vs. NHTSA-derived rates side by side with the 5 s / 30 s window gap shown;
  an "investigation lens" that filters the explorer to the scenario a probe describes (e.g. EA26002 reduced
  visibility); redaction-aware uncertainty bounds (e.g. Tesla's ~94% unknown injury severity).
- **Statistical views:** exact Poisson intervals on every rate, funnel plots for comparing companies with very
  different volumes, reporting-lag correction, low-sample warnings (e.g. GM after Cruise's shutdown).
- **Interactive and WebGL views:** a crash explorer (every incident a point, selectable axes,
  cross-filtering, sankey of movement → partner → severity), failure-pattern/conditions
  heatmaps, speed distributions, a 3D city-level map, a transparency matrix of what each company
  withholds.
- **Scenario controls** (shareable via URL): 5 s vs 30 s window, fleet denominator (total equipped
  vs active paid users), estimated mileage for non-disclosing companies, reporting-lag multiplier.
- **Alternative front ends.** Because the site only reads the golden database, other visualization
  stacks (React, Svelte, Observable, custom WebGL) can live in parallel.
- **Monthly automation:** scheduled GitHub Action + manual run button, validation that blocks
  a bad update, changelog of what changed each month.

## Usage

Requires Python 3.9+ (standard library only). Run from the repo root.

```bash
python3 -m unittest discover -s pipeline/tests -v   # run tests
python3 -m pipeline.fetch                           # download SGO CSVs into data/raw/
python3 -m pipeline.build_db                        # build the golden database in data/golden/
```

## License and data terms

NHTSA data is U.S. government public data. Company figures are quoted with attribution for
analysis; follow each source's terms. Code license: to be decided by the repository owner.
