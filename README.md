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
| Golden database: every source column, every report version, explicit missing-value reasons | `pipeline/golden.py` | **Planned** (next) |
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

## Planned work (not yet implemented)

Anyone is welcome to pick these up.

- **Golden database.** Keep *all* ~137/~116 source columns and every report version, with a status per
  field (`provided`, `reported_unknown`, `redacted_cbi`, `not_collected_in_era`, `not_applicable`).
  Canonical store is diff-friendly JSONL in git, plus a compiled SQLite file for download.
- **AI avoidability analysis.** Classify each incident as *unavoidable by an automated driver*
  (e.g. struck from behind or the side while stopped) vs. *plausibly the automation's fault*. The
  data to support it is retained (SV/CP contact areas, pre-crash movement, speed, engagement,
  narrative where not redacted). Plan: a rules-based first pass on structured fields, then an
  LLM pass for narratives, stored in a versioned `labels` table with model, prompt version,
  rationale and evidence fields; labels never overwrite source data.
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
```

## License and data terms

NHTSA data is U.S. government public data. Company figures are quoted with attribution for
analysis; follow each source's terms. Code license: to be decided by the repository owner.
