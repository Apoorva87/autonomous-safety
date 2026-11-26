"""Export the counts-only preview data for the site (site/public/data/*.json).

    python3 -m pipeline.export_preview

Writes records.json, counts.json, transparency.json and meta.json.

Unique crash = distinct incident_key. Reports that share an incident_key (the
same crash filed by different entities, or several reports of one crash) are
folded into one crash row:
  - severity is the highest across the incident's reports (fatal > serious >
    moderate > minor > none; "unknown" ranks lowest, so any known value beats it);
  - every other field comes from the representative report, i.e. the report
    with that highest severity (ties: the lowest report id), so program,
    company, month, tags and conditions are always one real report's values;
  - n_reports says how many reports the crash folds.
Narratives never leave the pipeline.
"""
import datetime
import json
from collections import Counter

from . import classify, config, harmonize

SEVERITIES = ["none", "minor", "moderate", "serious", "fatal", "unknown"]
_RANK = {"unknown": 0, "none": 1, "minor": 2, "moderate": 3, "serious": 4, "fatal": 5}

STRUCTURAL_BREAK = "2025-06-16"

# Column order of records.json rows.
RECORD_FIELDS = [
    "id", "incident_key", "n_reports", "era", "entity", "company", "program", "month",
    "lag_days", "make", "model", "model_year", "city", "state", "roadway_type", "surface",
    "lighting", "weather", "speed_mph", "speed_limit", "speed_band", "crash_with",
    "cp_movement", "sv_movement", "severity", "hospitalized", "airbag", "towed",
    "within_odd", "narrative_redacted", "version_redacted", "tags",
]

# Transparency fields: (field, only_era). only_era restricts the denominator to
# reports from an era that collects the field, so "not collected" is not "unknown".
TRANSPARENCY_FIELDS = [
    ("month", None), ("state", None), ("city", None), ("roadway_type", None),
    ("weather", None), ("crash_with", None), ("sv_movement", None), ("cp_movement", None),
    ("speed_mph", None), ("severity", None), ("within_odd", None), ("airbag", None),
    ("towed", None), ("narrative", None), ("version", None), ("make", None),
    ("model", None), ("model_year", None),
    ("lighting", "archive"), ("surface", "archive"), ("speed_limit", "archive"),
]


# ------------------------------------------------------------------ crashes
def unique_crashes(records):
    """One representative record per incident_key, with max severity (see module doc)."""
    groups = {}
    for r in records:
        groups.setdefault(r["incident_key"], []).append(r)
    crashes = []
    for reports in groups.values():
        rep = min(reports, key=lambda r: (-_RANK[r["severity"]], r["id"]))
        crashes.append((rep, len(reports)))
    crashes.sort(key=lambda c: c[0]["id"])
    return crashes


def tag_strings(record):
    """Tags as 'name:f' (structured field) or 'name:n' (narrative keyword)."""
    return ["%s:%s" % (t["t"], "f" if t["basis"] == "field" else "n") for t in classify.tag(record)]


def build_records(crashes):
    rows = []
    for rep, n in crashes:
        values = dict(rep)
        values["n_reports"] = n
        values["speed_band"] = classify.speed_band(rep)
        values["tags"] = tag_strings(rep)
        rows.append([values[f] for f in RECORD_FIELDS])
    return {"fields": RECORD_FIELDS, "rows": rows}


# ------------------------------------------------------------------- counts
def _month_range(first, last):
    y, m = int(first[:4]), int(first[5:])
    ly, lm = int(last[:4]), int(last[5:])
    out = []
    while (y, m) <= (ly, lm):
        out.append("%04d-%02d" % (y, m))
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


def build_counts(crashes):
    dated = [r["month"] for r, _ in crashes if r["month"]]
    months = _month_range(min(dated), max(dated)) if dated else []
    counts = {}
    for rep, _ in crashes:
        slot = counts.setdefault(rep["program"], {}).setdefault(rep["month"] or "undated", Counter())
        slot[rep["severity"]] += 1
    return {
        "unit": "unique crashes (distinct incident_key)",
        "severities": SEVERITIES,
        "months": months,
        "programs": sorted(counts),
        "counts": {p: {m: dict(c) for m, c in sorted(by_month.items())} for p, by_month in sorted(counts.items())},
    }


# ------------------------------------------------------------- transparency
def _state(field, r):
    """'provided' | 'unknown' | 'redacted' for one report and field."""
    if field == "narrative":
        return "redacted" if r["narrative_redacted"] else "provided"
    if field == "version":
        return "redacted" if r["version_redacted"] else "provided"
    value = r[field]
    if field == "within_odd" and value == "redacted":
        return "redacted"
    if field == "weather":
        return "unknown" if (not value or value == ["unknown"]) else "provided"
    if value is None or value == "unknown":
        return "unknown"
    return "provided"


def build_transparency(records):
    """Share of reports (latest version of each, not deduplicated) per program and field."""
    programs = sorted({r["program"] for r in records})
    cells = {}
    for program in programs:
        mine = [r for r in records if r["program"] == program]
        cells[program] = {}
        for field, only_era in TRANSPARENCY_FIELDS:
            rows = [r for r in mine if only_era is None or r["era"] == only_era]
            c = Counter(_state(field, r) for r in rows)
            n = len(rows)
            cells[program][field] = {
                "n": n,
                "provided": c["provided"] / n if n else None,
                "unknown": c["unknown"] / n if n else None,
                "redacted": c["redacted"] / n if n else None,
            }
    return {
        "unit": "reports (latest version of each Report ID)",
        "programs": programs,
        "fields": [f for f, _ in TRANSPARENCY_FIELDS],
        "era_limited": {f: e for f, e in TRANSPARENCY_FIELDS if e},
        "cells": cells,
    }


# --------------------------------------------------------------------- meta
def build_meta(records, crashes, fetch_log, placeholder_rows_skipped, run_date):
    def stamp(entry):
        return datetime.datetime.strptime(entry["last_modified"], "%a, %d %b %Y %H:%M:%S GMT")

    newest = max(fetch_log, key=stamp)
    months = sorted(r["month"] for r in records if r["month"])
    return {
        "source": "NHTSA SGO 2021-01",
        "run_date": run_date.isoformat(),
        "fetched_date": max(e["retrieved_at"] for e in fetch_log)[:10],
        "nhtsa_last_modified": stamp(newest).date().isoformat(),
        "structural_break": STRUCTURAL_BREAK,
        "total_reports": len(records),
        "total_incidents": len(crashes),
        "placeholder_rows_skipped": placeholder_rows_skipped,
        "first_month": months[0] if months else None,
        "last_month": months[-1] if months else None,
        "files": [
            {k: e[k] for k in ("key", "url", "last_modified", "retrieved_at", "sha256", "bytes", "rows")}
            for e in fetch_log
        ],
        "tag_rules": [{k: r[k] for k in ("id", "t", "basis", "description")} for r in classify.RULES],
    }


# --------------------------------------------------------------------- main
def build_all(records, fetch_log, placeholder_rows_skipped, run_date):
    crashes = unique_crashes(records)
    return {
        "records.json": build_records(crashes),
        "counts.json": build_counts(crashes),
        "transparency.json": build_transparency(records),
        "meta.json": build_meta(records, crashes, fetch_log, placeholder_rows_skipped, run_date),
    }


def write_all(outputs, out_dir):
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, obj in outputs.items():
        (out_dir / name).write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")


def main():
    records = harmonize.load_all(config.RAW_DIR)
    fetch_log = json.loads(config.FETCH_LOG.read_text(encoding="utf-8"))
    outputs = build_all(records, fetch_log, harmonize.SKIPPED_PLACEHOLDERS, datetime.date.today())
    write_all(outputs, config.OUT_DIR)
    meta = outputs["meta.json"]
    print("wrote %s: %d reports, %d unique crashes" % (config.OUT_DIR, meta["total_reports"], meta["total_incidents"]))


if __name__ == "__main__":
    main()
