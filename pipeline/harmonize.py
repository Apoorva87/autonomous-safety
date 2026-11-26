"""Harmonize the archive-era and current-era SGO CSVs into one Record list.

load_all(raw_dir) returns one dict per report (latest version of each Report
ID across all six files). Constants and value maps live in schema.py.

Conventions:
- Every string is stripped; the source pads blanks with single spaces.
- A field that does not exist in an era is None, never imputed.
- Categorical values are looked up in explicit maps. A label that is not in a
  map goes into schema.UNMAPPED as (field, value) and the field takes None
  (severity takes "unknown", since its enum has no None).
"""
import calendar
import csv
import datetime
import re
from collections import Counter
from pathlib import Path

from . import config, schema

# Counters from the last load_all() call, for the build log.
LOAD_STATS = Counter()

_MONTHS = {
    name: i
    for i, name in enumerate(
        ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"), start=1
    )
}
_MONTH_YEAR = re.compile(r"^([A-Za-z]{3})-(\d{4})$")


# ---------------------------------------------------------------- primitives
def _clean(value):
    return (value or "").strip()


def _get(row, era, field):
    """Stripped source value for a record field, or None if the era lacks the column."""
    column = schema.COLUMNS[era][field]
    if column is None:
        return None
    return _clean(row.get(column))


def _cat(field, value, mapping, default=None):
    """Map a categorical label. Blank is None (unless the map lists it); unknown labels are recorded."""
    if value is None:
        return default
    if value in mapping:
        return mapping[value]
    if value == "":
        return default
    schema.UNMAPPED.add((field, value))
    return default


def _flag(row, column):
    """A 'Y'/blank flag column. Anything else is recorded as unmapped and read as not set."""
    value = _clean(row.get(column))
    if value == "Y":
        return True
    if value != "":
        schema.UNMAPPED.add((column, value))
    return False


def _int(field, value):
    if not value:
        return None
    if value.isdigit():
        return int(value)
    schema.UNMAPPED.add((field, value))
    return None


def _text_or_none(value):
    """Free text where 'Unknown'/'UNK'/blank all mean not known."""
    if value is None or value.lower() in schema.UNKNOWN_TEXT:
        return None
    return value


# --------------------------------------------------------------------- dates
def _month_year(text):
    """'SEP-2026' -> (2026, 9); None if blank or not in that format."""
    m = _MONTH_YEAR.match(_clean(text))
    if not m:
        return None
    month = _MONTHS.get(m.group(1).upper())
    if month is None:
        return None
    return int(m.group(2)), month


def parse_month(text):
    """'SEP-2026' -> '2026-09'. None for blank, malformed or placeholder (JAN-1900) values."""
    ym = _month_year(text)
    if ym is None or ym[0] < schema.MIN_INCIDENT_YEAR:
        return None
    return "%04d-%02d" % ym


def _month_end(ym):
    return datetime.date(ym[0], ym[1], calendar.monthrange(ym[0], ym[1])[1])


# ---------------------------------------------------------------- redaction
def is_narrative_redacted(text, cbi=""):
    """The one place that defines narrative redaction.

    True when the narrative is blank, or the redaction markers cover at least
    NARRATIVE_REDACTED_COVERAGE of its characters (a lower
    NARRATIVE_REDACTED_COVERAGE_CBI when the Narrative - CBI? flag is set).
    """
    text = _clean(text)
    if not text:
        return True
    coverage = text.count(schema.REDACTION_MARKER) * len(schema.REDACTION_MARKER) / len(text)
    threshold = schema.NARRATIVE_REDACTED_COVERAGE_CBI if cbi else schema.NARRATIVE_REDACTED_COVERAGE
    return coverage >= threshold


def is_version_redacted(version_text, cbi_flag):
    return bool(cbi_flag) or schema.REDACTION_MARKER in _clean(version_text)


# --------------------------------------------------------- airbag and towed
def combine_flags(sv, cp):
    """Whether any vehicle had the condition, from per-vehicle states.

    States: yes, no, unknown, na (vehicle does not exist), blank (no answer).
    True if either is yes. False only if neither is yes and both are a firm
    no/na with at least one no. Otherwise None (unknown).
    """
    if "yes" in (sv, cp):
        return True
    if sv in ("no", "na") and cp in ("no", "na") and "no" in (sv, cp):
        return False
    return None


def _vehicle_flag(field, row, era):
    combined = _get(row, era, field + "_combined")
    if combined is not None:  # current era: one combined label
        pair = _cat(field, combined, schema.FLAG_CURRENT)
        sv, cp = pair if pair else ("blank", "blank")
    else:  # archive era: one answer per vehicle
        sv = _cat(field, _get(row, era, field + "_sv"), schema.FLAG_ARCHIVE, "blank")
        cp = _cat(field, _get(row, era, field + "_cp"), schema.FLAG_ARCHIVE, "blank")
    return combine_flags(sv, cp)


# -------------------------------------------------------------------- program
def company_and_program(entity, kind, engaged):
    """Company and program for a report.

    ADS/ADAS files: the file kind picks the mode (ADS or L2).
    OTHER file: the Automation System Engaged? value picks it (ADS -> ADS,
    ADAS -> L2) and anything unknown defaults to L2.
    Cruise LLC is always gm_cruise_ads; Waymo and Zoox have a single program.
    """
    company = schema.COMPANY_BY_ENTITY.get(entity, "other")
    if entity in schema.ENTITY_PROGRAM_OVERRIDE:
        return company, schema.ENTITY_PROGRAM_OVERRIDE[entity]
    if kind == "ADS":
        mode = "ads"
    elif kind == "ADAS":
        mode = "l2"
    else:
        mode = _cat("engaged", engaged, schema.ENGAGED_MODE, "unknown")
        mode = "ads" if mode == "ads" else "l2"
    return company, schema.PROGRAM_BY_COMPANY_MODE[(company, mode)]


# ----------------------------------------------------------------- unknowns
def _unknown_count(record):
    count = 0
    for field in schema.UNKNOWN_FIELD_KEYS:
        value = record[field]
        if field == "narrative":
            unknown = record["narrative_redacted"]
        elif field == "weather":
            unknown = not value or value == ["unknown"]
        else:
            unknown = value is None or value in ("unknown", "redacted")
        count += unknown
    return count


# ------------------------------------------------------------------ one row
def is_placeholder(row):
    """'No New or Updated Incident Reports' rows are monthly filings with no incident."""
    return _clean(row.get("Report Type")) == schema.PLACEHOLDER_REPORT_TYPE


def _version(row, era):
    raw = _get(row, era, "ver")
    if raw.isdigit():
        return int(raw)
    schema.UNMAPPED.add(("ver", raw))
    return 0


def harmonize_row(row, era, kind):
    """Convert one source row to a Record dict."""
    g = lambda field: _get(row, era, field)  # noqa: E731
    entity = g("entity")
    company, program = company_and_program(entity, kind, g("engaged"))

    incident_ym = _month_year(g("incident_date"))
    if g("incident_date") and incident_ym is None:
        schema.UNMAPPED.add(("incident_date", g("incident_date")))
    month = parse_month(g("incident_date"))
    submitted_ym = _month_year(g("submitted"))
    if g("submitted") and submitted_ym is None:
        schema.UNMAPPED.add(("submitted", g("submitted")))
    # The source gives the submission month only. Use the month's last day so
    # lag is a whole-month difference and a same-month report has lag 0.
    submitted = _month_end(submitted_ym) if submitted_ym else None
    lag_days = None
    if month and submitted:
        lag_days = max(0, (submitted - _month_end(incident_ym)).days)

    severity, hospitalized = _cat("severity", g("severity"), schema.SEVERITY[era], ("unknown", None))

    weather = [
        name for column, name in schema.WEATHER_COLUMNS[era].items() if _flag(row, column)
    ]

    narrative = g("narrative")
    narrative_cbi = _flag(row, schema.COLUMNS[era]["narrative_cbi"])
    version_cbi = _flag(row, schema.COLUMNS[era]["version_cbi"])

    record = {
        "id": g("id"),
        "ver": _version(row, era),
        "incident_key": g("same_incident_id") or "solo:" + g("id"),
        "file": kind,
        "era": era,
        "entity": entity,
        "company": company,
        "program": program,
        "month": month,
        "submitted": submitted.isoformat() if submitted else None,
        "lag_days": lag_days,
        "make": _text_or_none(g("make")),
        "model": _text_or_none(g("model")),
        "model_year": _int("model_year", g("model_year")),
        "city": _text_or_none(g("city")),
        "state": _text_or_none(g("state")),
        "roadway_type": _cat("roadway_type", g("roadway_type"), schema.ROADWAY_TYPE),
        "surface": _cat("surface", g("surface"), schema.SURFACE),
        "lighting": _cat("lighting", g("lighting"), schema.LIGHTING),
        "weather": weather,
        "speed_mph": _int("speed_mph", g("speed_mph")),
        "speed_limit": _int("speed_limit", g("speed_limit")),
        "crash_with": _cat("crash_with", g("crash_with"), schema.CRASH_WITH),
        "cp_movement": _cat("cp_movement", g("cp_movement"), schema.MOVEMENT),
        "sv_movement": _cat("sv_movement", g("sv_movement"), schema.MOVEMENT),
        "severity": severity,
        "hospitalized": hospitalized,
        "airbag": _vehicle_flag("airbag", row, era),
        "towed": _vehicle_flag("towed", row, era),
        "within_odd": _cat("within_odd", g("within_odd"), schema.WITHIN_ODD),
        "narrative": narrative,
        "narrative_redacted": is_narrative_redacted(narrative, narrative_cbi),
        "version_redacted": is_version_redacted(g("version_text"), version_cbi),
    }
    record["unknown_fields"] = _unknown_count(record)
    return record


# ------------------------------------------------------------------ all files
def _read_rows(path):
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        yield from csv.DictReader(f)


def load_all(raw_dir=None, allow_missing=False):
    """Harmonize every SGO file in raw_dir into a list of Records.

    One record per Report ID: the highest Report Version across all files and
    eras wins (a report can move between files, e.g. archive_ADAS v1 to
    current_ADAS v2). Placeholder filings are skipped. schema.UNMAPPED is
    cleared first and then holds every unmapped (field, value) from the rows
    that became records. A missing file raises unless allow_missing is set
    (tests use that with a two-file fixture directory).
    """
    raw_dir = Path(raw_dir if raw_dir is not None else config.RAW_DIR)
    schema.UNMAPPED.clear()
    LOAD_STATS.clear()

    latest = {}  # report id -> (version, row, era, kind)
    for spec in config.SGO_FILES:
        path = raw_dir / (spec["key"] + ".csv")
        if not path.exists():
            if allow_missing:
                continue
            raise FileNotFoundError(path)
        for row in _read_rows(path):
            LOAD_STATS["rows"] += 1
            if is_placeholder(row):
                LOAD_STATS["placeholder_rows"] += 1
                continue
            version = _version(row, spec["era"])
            report_id = _clean(row.get("Report ID"))
            current = latest.get(report_id)
            if current is not None and version == current[0]:
                LOAD_STATS["tied_versions"] += 1
            if current is None or version > current[0]:
                latest[report_id] = (version, row, spec["era"], spec["kind"])

    records = [harmonize_row(row, era, kind) for _, row, era, kind in latest.values()]
    records.sort(key=lambda r: r["id"])
    LOAD_STATS["records"] = len(records)
    LOAD_STATS["superseded_versions"] = LOAD_STATS["rows"] - LOAD_STATS["placeholder_rows"] - len(records)
    return records
