"""Compact JSON exports for the site, derived from the golden tables.

build_all(tables, ...) takes the golden tables (golden.build output, in memory)
and returns every file the site reads from site/public/data/. Nothing here
touches the sources: the golden database is the only input, so a new chart tab
never needs ingestion changes.

A "current" report is a golden reports row with is_latest, not a placeholder
filing and not removed. Every export counts current reports only.

Unique crash = distinct incident_key. Reports that share an incident_key (the
same crash filed by different entities, or several reports of one crash) fold
into one crash row:
  - severity is the highest across the incident's reports (fatal > serious >
    moderate > minor > none; "unknown" ranks lowest, so any known value beats it);
  - every other field comes from the representative report, i.e. the report
    with that highest severity (ties: the lowest report id), so program,
    company, month, tags and conditions are always one real report's values;
  - n_reports says how many reports the crash folds.
A report whose Same Incident ID is blank is its own incident (harmonize gives it
a "solo:<id>" key), so unrelated blank-ID reports never merge.

records.json holds one row per unique incident (the representative report's values).
counts.json counts per program: `reports` tallies each report under its own program,
month and file; `crashes` are the unique incident_keys of that program, and an incident
counts for every program that filed a report in it (a collision between two programs'
vehicles counts once under each). A program's incident takes the highest severity among
that program's own reports of it, and sits in the month and file of that report. Per-program
crash counts therefore overlap for multi-program incidents and must not be summed across
programs; the grand total of unique incidents is counts_total.unique_incidents in meta.json.
SGO gives a severity per report, not deaths: "fatal" is a crash whose severity is fatal.
Total fatalities come only from company_reported and investigations rows. Narratives are
published only where they are not redacted.

Files (see OUTPUT_FILES): records.json, narratives.json, counts.json, lag.json,
exposure.json, company_reported.json, sources.json, investigations.json,
events.json, rules.json, transparency.json, meta.json, changelog.json.
records.json, counts.json, transparency.json and meta.json keep the shapes the
live preview site reads; the new keys sit beside the old ones.
"""
import datetime
import json
import os
from collections import Counter, defaultdict
from pathlib import Path

from . import classify, exposure, golden, responsibility, validate

SEVERITIES = ["none", "minor", "moderate", "serious", "fatal", "unknown"]
_RANK = golden.SEVERITY_RANK
_INJURY = ("minor", "moderate", "serious", "fatal")
_SERIOUS_PLUS = ("serious", "fatal")

STRUCTURAL_BREAK = "2025-06-16"
LAG_DAYS = list(range(0, 366, 15))

OUTPUT_FILES = (
    "records.json", "narratives.json", "counts.json", "lag.json", "exposure.json", "company_reported.json",
    "sources.json", "investigations.json", "events.json", "rules.json", "transparency.json", "meta.json",
    "changelog.json",
) + responsibility.OUTPUT_FILES

# Column order of records.json rows. "id" is the report id of the representative report.
RECORD_FIELDS = [
    "id", "incident_key", "n_reports", "era", "entity", "company", "program", "month",
    "lag_days", "make", "model", "model_year", "city", "state", "roadway_type", "surface",
    "lighting", "weather", "speed_mph", "speed_limit", "speed_band", "crash_with",
    "cp_movement", "sv_movement", "severity", "hospitalized", "airbag", "towed",
    "within_odd", "narrative_redacted", "version_redacted", "tags",
    "sv_contact_areas", "cp_contact_areas",
]
_RECORD_SOURCE = {"id": "report_id"}
# List-valued fields that may be absent on older fixtures; absent means an empty list.
_LIST_FIELDS = {"sv_contact_areas", "cp_contact_areas"}

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


# ------------------------------------------------------------------ selection
def is_current(row):
    return bool(row["is_latest"]) and not row["is_placeholder"] and row["removed_in_run"] is None


def current_reports(tables):
    """The latest version of every real, non-removed report."""
    return [r for r in tables["reports"] if is_current(r)]


# ------------------------------------------------------------------- crashes
def unique_crashes(reports):
    """[(representative report, number of reports)] per incident_key, sorted by report id."""
    groups = {}
    for r in reports:
        groups.setdefault(r["incident_key"], []).append(r)
    crashes = []
    for members in groups.values():
        rep = min(members, key=lambda r: (-_RANK[r["severity"]], r["report_id"]))
        crashes.append((rep, len(members)))
    crashes.sort(key=lambda c: c[0]["report_id"])
    return crashes


def tag_strings(row):
    """Tags as 'name:f' (structured field) or 'name:n' (narrative keyword)."""
    return ["%s:%s" % (t["t"], "f" if t["basis"] == "field" else "n") for t in row["tags"]]


# ------------------------------------------------------------------- records
def build_records(crashes):
    rows = []
    for rep, n in crashes:
        values = dict(rep, n_reports=n, tags=tag_strings(rep))
        rows.append([
            values.get(_RECORD_SOURCE.get(f, f), []) if f in _LIST_FIELDS else values[_RECORD_SOURCE.get(f, f)]
            for f in RECORD_FIELDS
        ])
    return {"fields": RECORD_FIELDS, "rows": rows}


def build_narratives(reports):
    """{report id: narrative text} for reports whose narrative is not redacted."""
    return {
        r["report_id"]: r["raw"].get("Narrative", "")
        for r in sorted(reports, key=lambda r: r["report_id"])
        if not r["narrative_redacted"] and r["raw"].get("Narrative")
    }


# -------------------------------------------------------------------- counts
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


def _has_tag(row, name, basis=None):
    return any(t["t"] == name and (basis is None or t["basis"] == basis) for t in row["tags"])


def program_incidents(reports):
    """[(representative report, member reports)] per (program, incident_key).

    The representative is the program's own report of the incident with the highest
    severity (ties: lowest report id), so the incident's severity, month and file are
    always one of that program's reports.
    """
    groups = {}
    for r in reports:
        groups.setdefault((r["program"], r["incident_key"]), []).append(r)
    out = []
    for members in groups.values():
        rep = min(members, key=lambda r: (-_RANK[r["severity"]], r["report_id"]))
        out.append((rep, members))
    out.sort(key=lambda c: (c[0]["program"], c[0]["report_id"]))
    return out


def build_counts(reports):
    """counts.json: flat `rows` (program x month x file) plus the nested severity table the site reads."""
    incidents = program_incidents(reports)
    dated = [rep["month"] for rep, _ in incidents if rep["month"]]
    months = _month_range(min(dated), max(dated)) if dated else []
    nested, flat = {}, {}

    def slot(r):
        return flat.setdefault((r["program"], r["month"], r["kind"]), {
            "program": r["program"], "company": r["company"], "month": r["month"], "file": r["kind"],
            "reports": 0, "crashes": 0, "fatal": 0, "serious_plus": 0, "injury": 0, "vru": 0, "vru_field": 0,
        })

    for r in reports:
        slot(r)["reports"] += 1
    for rep, members in incidents:
        sev = rep["severity"]
        nested.setdefault(rep["program"], {}).setdefault(rep["month"] or "undated", Counter())[sev] += 1
        row = slot(rep)
        row["crashes"] += 1
        row["fatal"] += sev == "fatal"
        row["serious_plus"] += sev in _SERIOUS_PLUS
        row["injury"] += sev in _INJURY
        row["vru"] += any(_has_tag(m, "vru") for m in members)
        row["vru_field"] += any(_has_tag(m, "vru", "field") for m in members)
    rows = sorted(flat.values(), key=lambda r: (r["program"], r["month"] or "", r["file"]))
    return {
        "unit": "unique crashes per program (distinct incident_key within the program)",
        "severities": SEVERITIES,
        "months": months,
        "programs": sorted(nested),
        "counts": {p: {m: dict(c) for m, c in sorted(by_month.items())} for p, by_month in sorted(nested.items())},
        "rows": rows,
        "unique_incidents": len({r["incident_key"] for r in reports}),
        "notes": [
            "Crashes are counted per program. An incident filed by two programs (for example a Waymo and an "
            "other-AV collision) counts once under each, so per-program crash counts overlap and must not be "
            "summed across programs. The grand total of unique incidents is unique_incidents here and "
            "counts_total.unique_incidents in meta.json.",
            "Reports are counted under each report's own program, month and file, so they do add up across programs.",
            "A program's incident takes the highest severity among that program's own reports of it, and is "
            "placed in the month and file of that report.",
        ],
        "row_notes": {
            "reports": "current reports filed under this program, month and file",
            "crashes": "unique incident_key within the program (see notes: not additive across programs)",
            "fatal": "crashes whose highest severity is fatal (SGO gives severity, not a death count)",
            "serious_plus": "crashes with serious or fatal severity",
            "injury": "crashes with any injury severity: minor, moderate, serious or fatal",
            "vru": "crashes where a report of the program carries the vru tag (structured field or narrative keyword)",
            "vru_field": "as vru, structured field only (comparable across redaction levels)",
        },
    }


# ----------------------------------------------------------------------- lag
def build_lag(reports):
    """Empirical CDF of the reporting lag per program, on LAG_DAYS (months resolution)."""
    lags = defaultdict(list)
    totals = Counter(r["program"] for r in reports)
    for r in reports:
        if r["lag_days"] is not None:
            lags[r["program"]].append(r["lag_days"])
    programs = {}
    for program, values in sorted(lags.items()):
        n = len(values)
        programs[program] = {"n": n, "n_reports": totals[program], "cdf": [round(sum(1 for v in values if v <= d) / n, 4) for d in LAG_DAYS]}
    return {
        "days": LAG_DAYS,
        "resolution": "month",
        "note": ("NHTSA publishes only the incident month and the submission month, so lag is a whole-month "
                 "difference (submission month end minus incident month end, floored at 0). "
                 "Share of reports filed within the given number of days."),
        "programs": programs,
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


def build_transparency(reports):
    """Share of reports (latest version of each, not deduplicated) per program and field."""
    programs = sorted({r["program"] for r in reports})
    cells = {}
    for program in programs:
        mine = [r for r in reports if r["program"] == program]
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


# ------------------------------------------------------------------ exposure
def build_exposure(rows, today):
    out, warnings = exposure.normalize(rows, today)
    return {
        "metrics": ["miles", "active_vehicles", "subscribers", "recall_units"],
        "kinds": list(exposure.KIND_RANK),
        "carry_forward_months": exposure.CARRY_MONTHS,
        "notes": [
            "Rows are per program, region and metric; a US series and a California-only or global series are never mixed.",
            "recall_units is a recall's potential units affected, never a fleet size.",
            "A period with no row has no usable disclosure: show 'no data', never zero.",
        ],
        "rows": out,
    }, warnings


# ---------------------------------------------------------------------- meta
def _stamp(http_date):
    try:
        return datetime.datetime.strptime(http_date, "%a, %d %b %Y %H:%M:%S GMT")
    except (TypeError, ValueError):
        return None


def build_meta(tables, reports, crashes, fetch_log, run_id, run_at, today, warnings, offline=False):
    stamps = {e["key"]: _stamp(e.get("last_modified")) for e in fetch_log}
    known = [s for s in stamps.values() if s is not None]
    months = sorted(r["month"] for r in reports if r["month"])
    retrieved = [e["retrieved_at"] for e in fetch_log if e.get("retrieved_at")]
    placeholders = sum(1 for r in tables["reports"] if r["is_placeholder"] and r["removed_in_run"] is None)
    return {
        "source": "NHTSA SGO 2021-01",
        "run_id": run_id,
        "run_at": run_at,
        "run_date": today.isoformat(),
        "fetched_date": max(retrieved)[:10] if retrieved else today.isoformat(),
        "nhtsa_last_modified": max(known).date().isoformat() if known else None,
        "nhtsa_last_modified_by_file": {
            k: (s.strftime("%Y-%m-%dT%H:%M:%SZ") if s else None) for k, s in sorted(stamps.items())
        },
        "structural_break": STRUCTURAL_BREAK,
        "total_reports": len(reports),
        "total_incidents": len(crashes),
        "counts_total": {"reports": len(reports), "incidents": len(crashes), "unique_incidents": len(crashes)},
        "offline": bool(offline),
        "offline_note": (
            "Raw files were not downloaded in this run: the sha256 values in fetch_log come from the previous "
            "fetch log and were not re-verified, and row-drop checks compare against the previous fetch log only."
            if offline else None),
        "placeholder_rows_skipped": placeholders,
        "placeholders_skipped": placeholders,
        "first_month": months[0] if months else None,
        "last_month": months[-1] if months else None,
        "rules_version": golden.RULES_VERSION,
        "entities": sorted({r["entity"] for r in reports}),
        "warnings": list(warnings),
        "disclosures": validate.cadence_status(tables.get("cadence", []), today),
        "fetch_log": {
            e["key"]: {k: e.get(k) for k in ("rows", "bytes", "sha256", "last_modified", "retrieved_at")}
            for e in fetch_log
        },
        "files": [
            {k: e.get(k) for k in ("key", "url", "last_modified", "retrieved_at", "sha256", "bytes", "rows")}
            for e in fetch_log
        ],
        "tag_rules": [{k: r[k] for k in ("id", "t", "basis", "description")} for r in classify.RULES],
    }


# ----------------------------------------------------------------- changelog
def _report_hashes(tables):
    """{report id: {report key: row hash}} for the real, non-removed rows (every version)."""
    state = defaultdict(dict)
    for r in tables.get("reports", []):
        if not r["is_placeholder"] and r["removed_in_run"] is None:
            state[r["report_id"]][r["report_key"]] = r["row_hash"]
    return state


def changelog_entry(previous_tables, tables, run_id, run_at):
    """What changed since the previous golden build, by comparing row hashes.

    new      a Report ID that was not in the previous build
    revised  a Report ID whose rows changed: a corrected row or a new version
    removed  a Report ID that was in the previous build and is gone now
    """
    before, after = _report_hashes(previous_tables), _report_hashes(tables)
    return {
        "run_id": run_id,
        "run_at": run_at,
        "new_reports": len(after.keys() - before.keys()),
        "revised_reports": sum(1 for i in after.keys() & before.keys() if after[i] != before[i]),
        "removed_reports": len(before.keys() - after.keys()),
    }


def merge_changelog(previous, entry):
    """changelog.json with `entry` prepended. A rebuild of the same run id changes nothing."""
    entries = list((previous or {}).get("entries", []))
    if entries and entries[0].get("run_id") == entry["run_id"]:
        return {"entries": entries}
    return {"entries": [entry] + entries}


# ---------------------------------------------------------------------- main
def build_all(tables, fetch_log, run_id, run_at, today, previous_tables=None, previous_changelog=None, warnings=(),
              offline=False):
    """({file name: JSON-able object}, warnings) for every site file."""
    reports = current_reports(tables)
    crashes = unique_crashes(reports)
    exposure_json, exposure_warnings = build_exposure(tables.get("exposure", []), today)
    all_warnings = list(warnings) + exposure_warnings
    entry = changelog_entry(previous_tables or {}, tables, run_id, run_at)
    outputs = {
        "records.json": build_records(crashes),
        "narratives.json": build_narratives(reports),
        "counts.json": build_counts(reports),
        "lag.json": build_lag(reports),
        "exposure.json": exposure_json,
        "company_reported.json": {"rows": tables.get("company_reported", [])},
        "sources.json": {"rows": tables.get("sources", [])},
        "investigations.json": {"rows": tables.get("investigations", [])},
        "events.json": {"rows": tables.get("events", [])},
        "rules.json": {"rules_version": golden.RULES_VERSION, "rules": classify.RULES},
        "transparency.json": build_transparency(reports),
        "meta.json": build_meta(tables, reports, crashes, fetch_log, run_id, run_at, today, all_warnings, offline),
        "changelog.json": merge_changelog(previous_changelog, entry),
        **responsibility.build_outputs(reports, tables.get("labels", []), run_id),
    }
    assert set(outputs) == set(OUTPUT_FILES)
    return outputs, all_warnings


def write_all(outputs, out_dir):
    """Write every file: temp files first, then renames, so a failure leaves the old files intact."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    temps = []
    try:
        for name, obj in outputs.items():
            temp = out_dir / ("." + name + ".tmp")
            temp.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")
            temps.append((temp, out_dir / name))
        for temp, path in temps:
            os.replace(temp, path)
    except BaseException:
        for temp, _ in temps:
            if temp.exists():
                temp.unlink()
        raise
