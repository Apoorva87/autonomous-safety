# Autonomous Safety

An open, source-traced reference dataset and dashboard for crash and exposure disclosures from
autonomous-driving (ADS) and driver-assist (ADAS) programs: **Tesla** (Autopilot, FSD Supervised,
Robotaxi), **GM** (Super Cruise + Cruise), **Waymo**, **Zoox**, and any other company that
reports to NHTSA.

**Live site: https://apoorva87.github.io/autonomous-safety/**

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
| Curated company disclosures (miles, fleet, subscribers, company-reported safety metrics, investigations, events), each row with a source | `data/manual/`, `pipeline/manual.py` | **Built** |
| Golden database: every source column, every report version, explicit missing-value reasons (see [Golden database](#golden-database)) | `pipeline/golden.py`, `pipeline/build_db.py`, `data/golden/` | **Built** |
| Aggregation + validation gates (a bad update deploys nothing) | `pipeline/aggregate.py`, `validate.py`, `exposure.py`, `run.py` | **Built** |
| Monthly GitHub Action + GitHub Pages deploy | `.github/workflows/` | **Planned** |
| Dashboard on GitHub Pages, in five groups. **Overview**: crashes per million miles and miles per crash for every program with disclosed miles (driverless and Level 2 in separate panels; crash type picker; last 24 months with a 3-month rolling rate, or years from 2020), monthly counts, injury mix with counts. **Rates**: rate explorer (uncertainty bands, scenarios, funnel), before/after the 2025-06-16 rule change (one summary table), by city, timeline with events and investigations, claims vs filings. **Crashes**: WebGL crash explorer, patterns (tags with counts and disclosed miles, incident mix, time of day), impact map. **Responsibility** lens (counts with shares). **Data**: sources, transparency (reporting completeness and revisions) | `site/` | **Built** (deployed to the `gh-pages` branch by hand) |
| Responsibility pass 1 (rules on structured fields, with a rough narrative audit) | `pipeline/responsibility.py` | **Built** |
| Derived per-crash fields: threshold-robust class (`robust`), local `hour` (Tesla converted from UTC), `light_condition` from time when Lighting is missing; `revisions.json`; reporting-lag curves per regime; "Verified Not Engaged" reports kept out of crash counts | `pipeline/derive.py`, `pipeline/aggregate.py` | **Built** |

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

- **Level 2 and ADS programs are not comparable.** SGO reporting thresholds differ: a Level 2 crash is
  reportable only with a severity, vulnerable-road-user, airbag or tow-away criterion, an ADS crash at almost any
  contact. The site never puts the two kinds on one axis, funnel, ranking or overlaid line (kind groups: ADS =
  Waymo, GM Cruise, Zoox, Tesla Robotaxi, other ADS; L2 = Tesla Autopilot/FSD, GM Super Cruise, other L2).
- SGO reports (ADS and L2 alike) use a **30-second** engagement window; Tesla's own Vehicle Safety Report counts
  crashes with Autopilot active, or deactivated, within **5 seconds** before impact. The two are never put in one series.
- Waymo, Cruise, Zoox and Tesla Robotaxi miles are **rider-only**: by default their rates count only crashes whose
  operator type is none or remote, and the number excluded is shown (scenario toggle).
- California DMV testing miles (Dec-Nov years, including safety drivers) are an informational series only: never a denominator.
- Per-vehicle rates are per **vehicle-year** (partial years flagged); Tesla L2 gets no per-mile series unless the user sets a
  miles-per-vehicle assumption; recent months whose reports are still arriving are drawn hatched or dotted.
- NHTSA reporting rules changed on **2025-06-16** (minor ADS crashes and Level 2 tow-only crashes stopped being
  reportable). Time charts count **threshold-robust crashes** by default (any injury, an air bag, a tow-away for ADS, or a
  pedestrian/cyclist: reportable under both rules; unknown counts as not met, so it is a lower bound), lines are not
  joined across the break, and before/after comparisons (Rates → Before / after) never pool the two regimes. Reporting-lag curves
  are estimated per regime. "All reportable crashes" stays available as a toggle.
- **Tesla files incident times in UTC**; every other reporter uses local time. Hours are converted to the state's main
  time zone (daylight saving by month); the evidence (recorded Lighting agreement 55% as filed vs 99% converted) is in
  `meta.json` and on Data & sources. Light condition after 2025-06-15 is derived from time (approximate, one US-wide sun table).
- Reports NHTSA marks **Verified Not Engaged** (84) are not counted as crashes; they are counted separately.
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
(about 6 s). Run it once per refresh, and **only after the validation gate (`pipeline.run`) has passed**: a
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
| `labels` | (report version, label set) | Reserved for the future AI avoidability analysis. **Keyed by `report_key`, i.e. per report version**, a deliberate deviation from the spec sketch (which said `report_id`), so a label always points at the exact text it judged. The builder never writes or deletes label rows once present; pass-1 rule labels are written by `pipeline.responsibility`. Columns: `report_key, label_set, label, rationale, evidence_fields, model, prompt_version, run_at`. |

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
version and withdrawal tracking, `rules_version`. Planned: filling `labels` with the AI avoidability analysis (pass 2). The validation gates run before a build is committed (`pipeline.run`), and the site reads the exports built from the golden store.

## Still planned (not yet implemented)

Anyone is welcome to pick these up.

- **Automatic monthly deploy.** A scheduled GitHub Action plus a manual run button: run `python3 -m pipeline.run`,
  commit data, build `site/`, deploy Pages (today the build is deployed by hand to `gh-pages`). Needs a token with the
  `workflow` scope (`gh auth refresh -s workflow`).
- **Responsibility pass 2.** An LLM reads narratives where they are not redacted (Waymo, Zoox, Cruise; almost none for
  Tesla) to label crashes and to audit and tune the pass-1 rules; results go in the versioned `labels` table with model,
  prompt version, rationale and evidence. For Level 2 programs, driver vs. system cannot be separated from NHTSA data;
  the lens says so rather than guessing. Pass 1 rules are documented in `responsibility_rules.json`
  (RESP-OTH-1..4, SUB-1..3, IND-1..4, NAR-1; SUB-4 retired after the audit).
- **Better exposure data.** Added in this round: Waymo rider-only miles from 2023 (January 2023 milestone, the 7.14 M-mile
  study), Super Cruise from 2022-10 (Trimble), Tesla North America FSD (Supervised) miles from 2024-10 (two non-overlapping
  rolling 12-month totals, split by month along Tesla's own mileage counter) and Tesla Robotaxi miles spread from launch.
  Still missing: Waymo before 2023, Tesla Autopilot-only miles (not disclosed, so Tesla's per-mile rate puts Autopilot
  crashes over FSD miles), Zoox miles, California DMV 2025 and CPUC data, US-only splits of Super Cruise miles, and a
  reconciliation of GM's March 2026 (800 M) and April 2026 (1 B) figures. Monthly splits flagged ">3x" are unreliable.
- **A derived `pii_withheld` flag** (VIN, ZIP, exact location are kept raw-only today), a `narrative_readable` column
  in the responsibility export, and an `includeOther` scenario control.
- **Alternative front ends.** The site only reads the golden database exports, so other visualization stacks
  (Svelte, Observable, custom WebGL) can live in parallel.
- **Redaction-aware uncertainty bounds** (e.g. Tesla's ~94% unknown injury severity) on severity charts.
- **Round-2 review items not yet done:** an hour axis/filter and hexbin in the crash explorer; claims reconciliation
  panels; a known-only severity bar on Overview; month/severity revisions in the changelog; a Waymo "US minus disclosed
  areas" row on Cities; a clickable coverage matrix and default funnel on Rates; Impact map small multiples and a time
  filter; per-year selection on Transparency (a pooled-years caveat is shown instead); tab grouping.

## Usage

Requires Python 3.9+ (standard library only). Run from the repo root.

```bash
python3 -m unittest discover -s pipeline/tests -v   # run tests
python3 -m pipeline.fetch                           # download SGO CSVs into data/raw/
python3 -m pipeline.run [--offline] [--run-id ID]   # fetch, validate, build golden DB, write site/public/data/
python3 -m pipeline.build_db                        # build the golden database only (skips the validation gate)
```

`pipeline.run` is the one command for a refresh. It downloads into a staging directory, validates the
files and manual tables (`pipeline/validate.py`: header drift, unmapped labels, row-count and report
drops, a vanished entity, parse failures, duplicate report versions, unresolved sources, counts that do
not add up) and, on any error, prints it, exits 1 and writes **nothing**. Otherwise it builds the
golden database and writes the site files (`records`, one row per program and incident, `narratives`, `counts`, `lag`, `exposure`,
`company_reported`, `sources`, `investigations`, `events`, `rules`, `transparency`, `meta`,
`changelog`). Warnings (stale disclosures, new entities, >50% monthly swings) go to `meta.json` and the
console. `--offline` reuses `data/raw/`.

## License and data terms

Code: [MIT](LICENSE). NHTSA data is U.S. government public data. Company figures are quoted with attribution
for analysis; follow each source's terms (see `data/manual/sources.csv`). Nothing here is legal, safety or
investment advice.
