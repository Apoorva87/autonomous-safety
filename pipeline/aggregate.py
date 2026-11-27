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

records.json holds one row per (program, incident) pair: the program's OWN report of the incident
(highest severity among that program's reports of it, ties: lowest report id), with that report's
entity, city, state, severity, month and so on, plus `incident_key` and `n_programs_in_incident`. A crash
filed by two programs is two rows. Per-program row counts therefore equal counts.json's per-program
crashes, and entity and city counts are never taken from another program's report. `tags` is the union
over the program's own reports of the incident (a structured-field basis beats a narrative basis), the same
rule counts.json uses for `vru`. `n_reports` is the number of that program's reports of the incident and
`operator` is the report's Driver / Operator Type (none, remote, in_vehicle, ...). `entity` is the
representative report's filer; `entities` lists every entity that filed a report of the incident under the
program (two filers of one program, e.g. Ford and another other_l2 reporter, share one row), so per-entity
counts use `entities` and add up to the incidents each entity filed. The grand total of unique
incidents is meta.json counts_total.unique_incidents.
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

from . import classify, derive, exposure, golden, responsibility, validate

SEVERITIES = ["none", "minor", "moderate", "serious", "fatal", "unknown"]
_RANK = golden.SEVERITY_RANK
_INJURY = ("minor", "moderate", "serious", "fatal")
_SERIOUS_PLUS = ("serious", "fatal")

STRUCTURAL_BREAK = "2025-06-16"
# Reporting lag in whole months (NHTSA publishes the incident month and the submission month only).
LAG_HORIZON = 12
LAG_MONTHS = list(range(0, LAG_HORIZON + 1))
# Regime of a report = the file era it was filed in: archive (rules before 2025-06-16) or current.
REGIME_OF_ERA = {"archive": "pre", "current": "post"}
NOT_ENGAGED = "verified_not_engaged"

OUTPUT_FILES = (
    "records.json", "narratives.json", "counts.json", "lag.json", "exposure.json", "company_reported.json",
    "sources.json", "investigations.json", "events.json", "rules.json", "transparency.json", "meta.json",
    "changelog.json", "revisions.json",
) + responsibility.OUTPUT_FILES

# Column order of records.json rows. "id" is the report id of the representative report.
RECORD_FIELDS = [
    "id", "incident_key", "n_programs_in_incident", "n_reports", "era", "entity", "entities", "company", "program", "month",
    "lag_days", "make", "model", "model_year", "city", "state", "roadway_type", "surface",
    "lighting", "weather", "speed_mph", "speed_limit", "speed_band", "crash_with",
    "cp_movement", "sv_movement", "severity", "hospitalized", "airbag", "towed",
    "within_odd", "narrative_redacted", "version_redacted", "tags",
    "sv_contact_areas", "cp_contact_areas", "operator",
    # Derived (pipeline/derive.py): threshold-robust class, hour of day and light condition.
    "robust", "hour", "time_basis", "light_condition", "light_condition_basis", "light_from_time",
]
_RECORD_SOURCE = {"id": "report_id", "operator": "driver_operator_type"}
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


def crash_reports(tables):
    """Current reports that count as the program's crashes: every current report except those whose
    Engagement Status (current era only) is "Verified Not Engaged" (the automation was verified off).
    Those are counted separately (not_engaged_summary) and shown on the Data & sources tab."""
    return [r for r in current_reports(tables) if r.get("engagement_status") != NOT_ENGAGED]


def not_engaged_summary(reports):
    """The current reports left out of program crash counts because the automation was verified not engaged."""
    left = sorted((r for r in reports if r.get("engagement_status") == NOT_ENGAGED), key=lambda r: r["report_id"])
    alleged = Counter(r["program"] for r in reports if r.get("engagement_status") == "alleged_engaged")
    return {
        "total": len(left),
        "by_program": dict(sorted(Counter(r["program"] for r in left).items())),
        "by_program_month": dict(sorted(Counter("%s|%s" % (r["program"], r["month"] or "undated") for r in left).items())),
        "report_ids": [r["report_id"] for r in left],
        "alleged_engaged_by_program": dict(sorted(alleged.items())),
        "note": ("Reports whose Engagement Status is 'Verified Not Engaged' (a field of the current file, from 2025-06-16) "
                 "are not counted as crashes of the program: the filer verified that the automation was off. They stay in "
                 "the golden database and in revisions.json. 'Alleged Engaged' reports are counted, as filed."),
    }


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
def programs_per_incident(reports):
    """{incident_key: number of distinct programs with a current report of it}."""
    seen = defaultdict(set)
    for r in reports:
        seen[r["incident_key"]].add(r["program"])
    return {k: len(v) for k, v in seen.items()}


def merged_tags(members):
    """Tag strings over a program's own reports of one incident; a 'field' basis beats a 'narrative' one."""
    basis = {}
    for r in sorted(members, key=lambda m: m["report_id"]):
        for t in r["tags"]:
            if basis.get(t["t"]) != "f":
                basis[t["t"]] = "f" if t["basis"] == "field" else "n"
    return ["%s:%s" % (name, b) for name, b in basis.items()]


def derived_values(rep, members):
    """The derived record columns of one (program, incident): robust over the program's reports, hour and light from the representative."""
    group = derive.group_of(rep["program"])
    condition, basis = derive.light_condition(rep)
    local, time_basis = derive.local_time(rep)
    return {
        "robust": any(derive.is_robust(m, group) for m in members),
        "hour": derive.hour_of(local),
        "time_basis": "utc" if time_basis == "converted from UTC" else "filed",
        "light_condition": condition,
        "light_condition_basis": basis,
        "light_from_time": derive.light_from_report(rep),
    }


def build_records(incidents, n_programs):
    """records.json: one row per (program, incident). `incidents` is program_incidents(), `n_programs` programs_per_incident()."""
    rows = []
    for rep, members in incidents:
        values = dict(rep, n_reports=len(members), tags=merged_tags(members),
                      entities=sorted({m["entity"] for m in members}),
                      n_programs_in_incident=n_programs[rep["incident_key"]], **derived_values(rep, members))
        rows.append([
            values.get(_RECORD_SOURCE.get(f, f), []) if f in _LIST_FIELDS else values[_RECORD_SOURCE.get(f, f)]
            for f in RECORD_FIELDS
        ])
    rows.sort(key=lambda r: (r[0], r[RECORD_FIELDS.index("program")]))
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
            "reports": 0, "crashes": 0, "robust_crashes": 0, "fatal": 0, "serious_plus": 0, "injury": 0, "vru": 0,
            "vru_field": 0,
        })

    for r in reports:
        slot(r)["reports"] += 1
    for rep, members in incidents:
        sev = rep["severity"]
        nested.setdefault(rep["program"], {}).setdefault(rep["month"] or "undated", Counter())[sev] += 1
        row = slot(rep)
        row["crashes"] += 1
        row["robust_crashes"] += any(derive.is_robust(m, derive.group_of(rep["program"])) for m in members)
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
            "robust_crashes": ("crashes meeting a criterion reportable under both the pre- and post-2025-06-16 rules "
                               "(see meta.json robust_definition): comparable across the rule change"),
            "fatal": "crashes whose highest severity is fatal (SGO gives severity, not a death count)",
            "serious_plus": "crashes with serious or fatal severity",
            "injury": "crashes with any injury severity: minor, moderate, serious or fatal",
            "vru": "crashes where a report of the program carries the vru tag (structured field or narrative keyword)",
            "vru_field": "as vru, structured field only (comparable across redaction levels)",
        },
    }


# ----------------------------------------------------------------------- lag
def chain_ladder_cdf(pairs, last, horizon=LAG_HORIZON):
    """Completeness F(k) = share of a month's reports filed within k months, k = 0..horizon, with F(horizon) = 1.

    pairs  [(incident month number, lag in months)]; last  the last submission month number observed.
    Each step F(k)/F(k+1) is estimated only from incident months old enough to have shown lags up to k+1
    (age >= k+1), so recent months do not make the curve look faster than it is (right-censoring).
    Reports filed more than `horizon` months late are outside the curve.
    """
    ratios = []
    for k in range(horizon):
        eligible = [lag for month, lag in pairs if last - month >= k + 1]
        a = sum(1 for lag in eligible if lag <= k)
        b = sum(1 for lag in eligible if lag <= k + 1)
        ratios.append(a / b if b else 1.0)
    cdf = [1.0] * (horizon + 1)
    for k in range(horizon - 1, -1, -1):
        cdf[k] = cdf[k + 1] * ratios[k]
    return [round(x, 4) for x in cdf]


def _severity_group(severity):
    return severity if severity in SEVERITIES else "unknown"


def build_lag(reports):
    """Reporting lag in whole months, per program and regime (never pooled across the 2025-06-16 change).

    regimes.<pre|post>.cdf  chain-ladder completeness by months since the incident month (lag-adjust within a regime only)
    regimes.<pre|post>.raw_cdf  the plain share filed within k months over all of the regime's reports (biased fast by recent months)
    hist.<regime>.<severity>  report counts by lag month 0..12 and a last bin for later (filed later = serious crashes, see the site)
    """
    by = defaultdict(list)
    totals = Counter(r["program"] for r in reports)
    for r in reports:
        lag = derive.lag_months(r)
        if lag is None:
            continue
        by[(r["program"], REGIME_OF_ERA.get(r["era"], "post"))].append((derive.month_number(r["month"]), lag, r))
    last_by_regime = {}
    for r in reports:
        regime = REGIME_OF_ERA.get(r["era"], "post")
        n = derive.month_number(r.get("submitted"))
        if n is not None:
            last_by_regime[regime] = max(last_by_regime.get(regime, n), n)
    programs = {}
    for program in sorted({p for p, _ in by}):
        entry = {"n_reports": totals[program], "regimes": {}, "hist": {}}
        for regime in ("pre", "post"):
            items = by.get((program, regime), [])
            if not items:
                continue
            pairs = [(m, lag) for m, lag, _ in items]
            n = len(items)
            hist = {}
            for _, lag, r in items:
                slot = hist.setdefault(_severity_group(r["severity"]), [0] * (LAG_HORIZON + 2))
                slot[min(lag, LAG_HORIZON + 1)] += 1
            entry["regimes"][regime] = {
                "n": n,
                "cdf": chain_ladder_cdf(pairs, last_by_regime[regime]),
                "raw_cdf": [round(sum(1 for _, lag in pairs if lag <= k) / n, 4) for k in LAG_MONTHS],
                "beyond_horizon": sum(1 for _, lag in pairs if lag > LAG_HORIZON),
            }
            entry["hist"][regime] = dict(sorted(hist.items()))
        entry["n"] = sum(v["n"] for v in entry["regimes"].values())
        programs[program] = entry
    return {
        "resolution": "month",
        "months": LAG_MONTHS,
        "pooled": False,
        "regimes": {
            "pre": "reports in the archive file (filed under the rules before 2025-06-16)",
            "post": "reports in the current file (filed under the Third Amended SGO, from 2025-06-16)",
        },
        "last_submission_month": {k: "%04d-%02d" % (v // 12, v % 12 + 1) for k, v in sorted(last_by_regime.items())},
        "note": ("NHTSA publishes only the incident month and the submission month, so lag is a whole number of months "
                 "(submission month minus incident month, floored at 0). Curves are per regime and never pooled: filing got "
                 "faster after 2025-06-16. cdf is a chain-ladder completeness estimate (each step uses only incident months "
                 "old enough to show it), with reports more than 12 months late outside the curve; adjust a month's count "
                 "only with the curve of its own regime."),
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


# ---------------------------------------------------------------- revisions
REVISION_FIELDS = ("sv_movement", "crash_with", "cp_movement", "sv_contact_areas", "roadway_type", "speed_mph", "severity")
# The "all unknown" block: pre-crash movement, crash partner and road type all reported unknown.
ALL_UNKNOWN_FIELDS = ("sv_movement", "crash_with", "roadway_type")


def _unknown(row, field):
    return (row.get("status") or {}).get(field) == golden.REPORTED_UNKNOWN


def build_revisions(tables):
    """revisions.json: per program and incident month, how many reports were revised and what revision fills in.

    Built from every version in the golden reports table (placeholders and removed rows left out). A report is
    "revised" when it has more than one version. For revised reports the unknown share of each field is given for
    the first and the latest version; for single-version reports, for that one version. Aggregates only.
    """
    versions = defaultdict(list)
    for r in tables["reports"]:
        if r["is_placeholder"] or r["removed_in_run"] is not None:
            continue
        versions[r["report_id"]].append(r)
    slots = {}
    for report_id in sorted(versions):
        rows = sorted(versions[report_id], key=lambda r: r["version"])
        latest = next((r for r in rows if r["is_latest"]), None)
        if latest is None:
            continue
        first = rows[0]
        key = (latest["program"], latest["month"] or "undated")
        slot = slots.setdefault(key, {
            "program": key[0], "month": key[1], "reports": 0, "revised": 0, "versions": 0,
            "first_unknown_revised": [0] * len(REVISION_FIELDS), "latest_unknown_revised": [0] * len(REVISION_FIELDS),
            "unknown_single": [0] * len(REVISION_FIELDS), "unknown_latest": [0] * len(REVISION_FIELDS),
            "all_unknown_latest": 0, "all_unknown_first_revised": 0, "all_unknown_latest_revised": 0, "gap_months": {},
        })
        slot["reports"] += 1
        slot["versions"] += len(rows)
        revised = len(rows) > 1
        all_latest = all(_unknown(latest, f) for f in ALL_UNKNOWN_FIELDS)
        slot["all_unknown_latest"] += all_latest
        for i, field in enumerate(REVISION_FIELDS):
            slot["unknown_latest"][i] += _unknown(latest, field)
            if revised:
                slot["first_unknown_revised"][i] += _unknown(first, field)
                slot["latest_unknown_revised"][i] += _unknown(latest, field)
            else:
                slot["unknown_single"][i] += _unknown(latest, field)
        if revised:
            slot["revised"] += 1
            slot["all_unknown_first_revised"] += all(_unknown(first, f) for f in ALL_UNKNOWN_FIELDS)
            slot["all_unknown_latest_revised"] += all_latest
            a, b = derive.month_number(first.get("submitted")), derive.month_number(latest.get("submitted"))
            if a is not None and b is not None:
                gap = str(min(max(0, b - a), 13))
                slot["gap_months"][gap] = slot["gap_months"].get(gap, 0) + 1
    rows = sorted(slots.values(), key=lambda r: (r["program"], r["month"]))
    for row in rows:
        row["gap_months"] = dict(sorted(row["gap_months"].items(), key=lambda kv: int(kv[0])))
    return {
        "unit": "reports (Report IDs), placed by the incident month of their latest version",
        "fields": list(REVISION_FIELDS),
        "all_unknown_fields": list(ALL_UNKNOWN_FIELDS),
        "unknown_means": "the field's golden status is reported_unknown (Unknown or blank in the source); redacted and not-applicable values are not unknown",
        "gap_months_note": "revised reports by whole months from the first to the latest version's submission month; 13 means 13 or more",
        "notes": [
            "A report is revised when the golden store holds more than one version of it. Recent incident months have had "
            "less time to be revised, so their revised share is a lower bound.",
            "first_unknown_revised and latest_unknown_revised cover revised reports only; unknown_single covers reports with "
            "one version; unknown_latest covers every report (latest version).",
            "Every report counts once, under its own program, so reports add up across programs (unlike crashes).",
        ],
        "total_reports": sum(r["reports"] for r in rows),
        "rows": rows,
    }


def _light_table(reports, derive_fn):
    table = {}
    for r in reports:
        recorded = derive.RECORDED_LIGHT.get(r.get("lighting"))
        derived = derive_fn(r)
        if not recorded or derived == "unknown":
            continue
        cell = table.setdefault(recorded, {"day": 0, "twilight": 0, "night": 0})
        cell[derived] += 1
    n = sum(sum(c.values()) for c in table.values())
    opposite = table.get("day", {}).get("night", 0) + table.get("night", {}).get("day", 0)
    clear = n - sum(c["twilight"] for c in table.values()) - sum(table.get("twilight", {}).values())
    return {"recorded_by_derived": dict(sorted(table.items())), "n": n,
            "agree": sum(table.get(k, {}).get(k, 0) for k in ("day", "twilight", "night")), "opposite": opposite,
            "day_night_agreement": round(1 - opposite / clear, 4) if clear else None}


def light_check(reports):
    """How the time-derived light condition compares with the recorded Lighting field, where both exist (archive era),
    for every reporter as converted, and for Tesla as filed vs converted from UTC (the evidence for the conversion)."""
    tesla = [r for r in reports if r.get("entity") in derive.UTC_ENTITIES]
    as_filed = lambda r: derive.light_from_time(r.get("incident_time"), r.get("month"), r.get("state"))  # noqa: E731
    return {
        "unit": "archive-era reports with both a recorded Lighting value and an incident time",
        "all_reporters": _light_table(reports, derive.light_from_report),
        "other_reporters": _light_table([r for r in reports if r not in tesla], derive.light_from_report),
        "tesla_as_filed": _light_table(tesla, as_filed),
        "tesla_converted_from_utc": _light_table(tesla, derive.light_from_report),
        "note": "rows: recorded Lighting (daylight = day, dawn/dusk = twilight, any dark = night); columns: derived from time. "
                "'opposite' counts day read as night or night read as day; day_night_agreement = 1 - opposite / reports "
                "where neither side is twilight.",
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


def build_meta(tables, reports, crashes, fetch_log, run_id, run_at, today, warnings, offline=False, current=None):
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
        "not_engaged": not_engaged_summary(current if current is not None else reports),
        "robust_definition": derive.ROBUST_DEFINITION,
        "light_rule": derive.LIGHT_RULE,
        "time_rule": derive.TIME_RULE,
        "sun_table": derive.sun_table_clock(),
        "light_check": light_check(reports),
        "field_notes": {
            "hospitalized": "Collected only in the current file (from 2025-06-16): the archive severity labels do not say "
                            "whether an injury was hospital-treated, so it is never true before the change.",
            "lighting": "Collected only in the archive file (through 2025-06-15); use light_from_time to compare across the change.",
            "light_from_time": "Approximate, derived from incident time and month (see light_rule).",
            "hour": "Local hour of the incident time, null when not given. Tesla, Inc. files times in UTC; they are converted "
                    "to the local time of the report's state (time_basis = utc). See time_rule.",
        },
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
    """({file name: JSON-able object}, warnings) for every site file.

    Crash exports (records, counts, lag, transparency, responsibility, meta totals) use crash_reports(): current
    reports minus "Verified Not Engaged" ones. revisions.json and narratives.json cover every current report.
    """
    current = current_reports(tables)
    reports = crash_reports(tables)
    crashes = unique_crashes(reports)
    exposure_json, exposure_warnings = build_exposure(tables.get("exposure", []), today)
    all_warnings = list(warnings) + exposure_warnings
    entry = changelog_entry(previous_tables or {}, tables, run_id, run_at)
    outputs = {
        "records.json": build_records(program_incidents(reports), programs_per_incident(reports)),
        "narratives.json": build_narratives(current),
        "counts.json": build_counts(reports),
        "lag.json": build_lag(reports),
        "exposure.json": exposure_json,
        "company_reported.json": {"rows": tables.get("company_reported", [])},
        "sources.json": {"rows": tables.get("sources", [])},
        "investigations.json": {"rows": tables.get("investigations", [])},
        "events.json": {"rows": tables.get("events", [])},
        "rules.json": {
            "rules_version": golden.RULES_VERSION, "rules": classify.RULES,
            "derived": {"robust": derive.ROBUST_DEFINITION, "light": derive.LIGHT_RULE, "time": derive.TIME_RULE,
                        "sun_table": derive.sun_table_clock()},
        },
        "transparency.json": build_transparency(reports),
        "meta.json": build_meta(tables, reports, crashes, fetch_log, run_id, run_at, today, all_warnings, offline, current),
        "changelog.json": merge_changelog(previous_changelog, entry),
        "revisions.json": build_revisions(tables),
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
