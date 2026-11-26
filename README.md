# AV Safety Dashboard

A public dashboard of crash reports for autonomous (ADS) and driver-assist (ADAS)
vehicles. A Python standard-library pipeline in `pipeline/` downloads, harmonizes,
validates and aggregates the data; the site is published on GitHub Pages.

## Data source

NHTSA Standing General Order 2021-01 incident reports
(https://www.nhtsa.gov/laws-regulations/standing-general-order-crash-reporting),
fetched from `static.nhtsa.gov/odi/ffdd/sgo-2021-01/`. Six CSVs are used: ADS, ADAS
and OTHER, each for the `current` era (reports from 2025-06-16) and the `archive`
era (2021-07 to 2025-06-15). Latest raw files live in `data/raw/`; provenance
(retrieval time, ETag, SHA-256, row counts) is logged in `data/registry/fetch_log.json`.

## Usage

Requires Python 3.9+ (standard library only). Run from the repo root.

    python3 -m unittest discover -s pipeline/tests -v   # run tests
    python3 -m pipeline.fetch                           # download SGO CSVs into data/raw/
