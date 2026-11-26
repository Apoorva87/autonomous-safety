"""Load and validate the hand-curated tables in data/manual/.

Every number in these tables was typed in by hand from a company disclosure,
a regulator's file or a study, so each row names the source it came from and
load() refuses the whole set if anything does not check out. Tables:

  sources.csv             source registry; every other table cites it
  exposure.csv            denominators (miles, vehicles, subscribers) exactly
                          as disclosed, typed reported | derived | estimate
  company_reported.csv    company-defined safety metrics (e.g. Tesla's
                          miles per crash, Waymo's benchmark reductions);
                          never to be mixed with NHTSA SGO series
  investigations.csv      NHTSA ODI investigations
  events.csv              timeline annotations
  disclosure_cadence.csv  how often each disclosure is expected (stale flags)

The `region` column says what geography a figure covers: "global" (all
markets the company counts), a two-letter US state or "us", or
"city:<slug>". SGO crash counts are US-only, so a denominator for them needs
region "us" (or a global figure explicitly labelled as such).

`source_id` names one source. A derived or estimate row may combine several
inputs and then lists every source it used, separated by ";".
"""
import csv
import math
import re
import sys
from datetime import date
from pathlib import Path

from . import config


class ManualDataError(ValueError):
    """A manual table is malformed or cites something that does not exist."""


FILES = {
    "sources": "sources.csv",
    "exposure": "exposure.csv",
    "company_reported": "company_reported.csv",
    "investigations": "investigations.csv",
    "events": "events.csv",
    "cadence": "disclosure_cadence.csv",
}

COLUMNS = {
    "sources": (
        "source_id", "publisher", "title", "url", "published", "accessed",
        "date_range", "source_type", "methodology", "caveats", "locator",
    ),
    "exposure": (
        "company", "program", "region", "period", "period_type", "metric",
        "value", "kind", "source_id", "method_note",
    ),
    "company_reported": (
        "company", "program", "region", "period", "period_type", "metric",
        "value", "unit", "window", "source_id", "method_note",
    ),
    "investigations": (
        "investigation_id", "company", "opened", "closed", "status", "type",
        "subject", "vehicles_covered", "url", "source_id",
    ),
    "events": ("date", "company", "program", "type", "label", "source_id"),
    "cadence": ("company", "program", "metric", "expected_every_days", "last_period"),
}

PROGRAMS_BY_COMPANY = {
    "tesla": ("tesla_l2", "tesla_robotaxi"),
    "gm": ("gm_supercruise", "gm_cruise_ads"),
    "waymo": ("waymo_ads",),
    "zoox": ("zoox_ads",),
    "other": ("other_ads", "other_l2"),
}
COMPANIES = tuple(PROGRAMS_BY_COMPANY)

KINDS = ("reported", "derived", "estimate")
EXPOSURE_METRICS = ("miles", "active_vehicles", "subscribers", "cum_miles")
PERIOD_TYPES = ("year", "quarter", "month", "cumulative_to")
SOURCE_TYPES = ("primary", "secondary")
INVESTIGATION_TYPES = ("PE", "EA", "RQ", "DP", "AQ")
INVESTIGATION_STATUSES = ("open", "closed")
EVENT_TYPES = ("regulatory", "launch", "suspension", "recall", "reporting_change", "other")

_NUMBER = re.compile(r"-?\d+(\.\d+)?")
_SOURCE_ID = re.compile(r"[a-z0-9_]+")
_METRIC_SLUG = re.compile(r"[a-z0-9_]+")
_REGION = re.compile(r"global|[a-z]{2}|city:[a-z0-9_]+")
_YEAR = re.compile(r"(\d{4})")
_QUARTER = re.compile(r"(\d{4})-Q([1-4])")
_MONTH = re.compile(r"(\d{4})-(\d{2})")
_DAY = re.compile(r"(\d{4})-(\d{2})-(\d{2})")


# ------------------------------------------------------------------ helpers
class _Ctx:
    """File name and line number, for error messages."""

    def __init__(self, filename, line):
        self.filename = filename
        self.line = line

    def fail(self, message):
        raise ManualDataError(f"{self.filename} line {self.line}: {message}")


def _is_day(text):
    m = _DAY.fullmatch(text)
    if not m:
        return False
    try:
        date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return False
    return True


def _is_month(text):
    m = _MONTH.fullmatch(text)
    return bool(m) and 1 <= int(m.group(2)) <= 12


def _period_ok(period, period_type):
    if period_type == "year":
        return bool(_YEAR.fullmatch(period))
    if period_type == "quarter":
        return bool(_QUARTER.fullmatch(period))
    if period_type == "month":
        return _is_month(period)
    if period_type == "cumulative_to":
        return _is_day(period)
    return False


def _any_period_ok(text):
    return any(_period_ok(text, t) for t in PERIOD_TYPES)


def _partial_date_ok(text):
    return bool(_YEAR.fullmatch(text)) or _is_month(text) or _is_day(text)


def _number(ctx, text, field="value", allow_negative=True):
    if not _NUMBER.fullmatch(text):
        ctx.fail(f"{field} {text!r} is not a plain number (digits, optional '-' and '.', no commas)")
    value = float(text) if "." in text else int(text)
    if not math.isfinite(value):
        ctx.fail(f"{field} {text!r} is not finite")
    if not allow_negative and value < 0:
        ctx.fail(f"{field} {text!r} is negative")
    return value


def _require(ctx, row, *fields):
    for field in fields:
        if not row[field]:
            ctx.fail(f"{field} is blank")


def _company_program(ctx, row, allow_all=False, allow_blank_program=False):
    company, program = row["company"], row["program"]
    if allow_all and company == "all":
        if program:
            ctx.fail(f"program {program!r} given for company 'all'")
        return
    if company not in PROGRAMS_BY_COMPANY:
        ctx.fail(f"unknown company {company!r}; expected one of {COMPANIES}")
    if allow_blank_program and not program:
        return
    if program not in PROGRAMS_BY_COMPANY[company]:
        ctx.fail(
            f"program {program!r} does not belong to company {company!r}; "
            f"expected one of {PROGRAMS_BY_COMPANY[company]}"
        )


def _source_ids(ctx, text, known, single):
    ids = [s.strip() for s in text.split(";")] if text else []
    if not ids or any(not s for s in ids):
        ctx.fail("source_id is blank")
    if single and len(ids) != 1:
        ctx.fail(f"source_id {text!r}: a reported row must cite exactly one source")
    for sid in ids:
        if sid not in known:
            ctx.fail(f"source_id {sid!r} is not in sources.csv")
    return ids


def _read(directory, name):
    path = Path(directory) / FILES[name]
    if not path.is_file():
        raise ManualDataError(f"{FILES[name]}: file not found in {directory}")
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        header = [h.strip() for h in (reader.fieldnames or [])]
        expected = COLUMNS[name]
        missing = [c for c in expected if c not in header]
        extra = [c for c in header if c not in expected]
        if missing or extra:
            raise ManualDataError(
                f"{FILES[name]}: columns differ from the expected set "
                f"(missing: {missing}, extra: {extra})"
            )
        reader.fieldnames = header
        rows = []
        for row in reader:
            if None in row:
                raise ManualDataError(
                    f"{FILES[name]} line {reader.line_num}: more fields than columns"
                )
            clean = {k: (v or "").strip() for k, v in row.items()}
            if not any(clean.values()):
                continue
            rows.append((_Ctx(FILES[name], reader.line_num), clean))
    return rows


# --------------------------------------------------------------- validators
def _sources(rows):
    out, seen = [], set()
    for ctx, row in rows:
        _require(ctx, row, "source_id", "publisher", "title", "url", "published",
                 "accessed", "locator")
        sid = row["source_id"]
        if not _SOURCE_ID.fullmatch(sid):
            ctx.fail(f"source_id {sid!r} must be lowercase letters, digits and '_'")
        if sid in seen:
            ctx.fail(f"duplicate source_id {sid!r}")
        seen.add(sid)
        if not row["url"].startswith(("https://", "http://")):
            ctx.fail(f"url {row['url']!r} must start with http:// or https://")
        if not _partial_date_ok(row["published"]):
            ctx.fail(f"published {row['published']!r} must be YYYY, YYYY-MM or YYYY-MM-DD")
        if not _is_day(row["accessed"]):
            ctx.fail(f"accessed {row['accessed']!r} must be YYYY-MM-DD")
        if row["source_type"] not in SOURCE_TYPES:
            ctx.fail(f"source_type {row['source_type']!r} must be one of {SOURCE_TYPES}")
        out.append(row)
    return out


def _period_fields(ctx, row):
    if row["period_type"] not in PERIOD_TYPES:
        ctx.fail(f"period_type {row['period_type']!r} must be one of {PERIOD_TYPES}")
    if not _period_ok(row["period"], row["period_type"]):
        ctx.fail(f"period {row['period']!r} does not match period_type {row['period_type']!r}")
    if not _REGION.fullmatch(row["region"]):
        ctx.fail(f"region {row['region']!r} must be 'global', a 2-letter code or 'city:<slug>'")


def _exposure(rows, known):
    out, seen = [], set()
    for ctx, row in rows:
        _company_program(ctx, row)
        _period_fields(ctx, row)
        if row["metric"] not in EXPOSURE_METRICS:
            ctx.fail(f"metric {row['metric']!r} must be one of {EXPOSURE_METRICS}")
        if row["kind"] not in KINDS:
            ctx.fail(f"kind {row['kind']!r} must be one of {KINDS}")
        if row["kind"] != "reported" and not row["method_note"]:
            ctx.fail(f"a {row['kind']} row needs a method_note saying how it was computed")
        value = _number(ctx, row["value"], allow_negative=False)
        ids = _source_ids(ctx, row["source_id"], known, single=row["kind"] == "reported")
        key = (row["company"], row["program"], row["region"], row["period"],
               row["metric"], row["kind"])
        if key in seen:
            ctx.fail(f"duplicate (company, program, region, period, metric, kind) {key}")
        seen.add(key)
        out.append(dict(row, value=value, source_ids=ids))
    return out


def _company_reported(rows, known):
    out, seen = [], set()
    for ctx, row in rows:
        _company_program(ctx, row)
        _period_fields(ctx, row)
        _require(ctx, row, "metric", "unit")
        if not _METRIC_SLUG.fullmatch(row["metric"]):
            ctx.fail(f"metric {row['metric']!r} must be lowercase letters, digits and '_'")
        value = _number(ctx, row["value"])
        ids = _source_ids(ctx, row["source_id"], known, single=False)
        key = (row["company"], row["program"], row["region"], row["period"], row["metric"])
        if key in seen:
            ctx.fail(f"duplicate (company, program, region, period, metric) {key}")
        seen.add(key)
        out.append(dict(row, value=value, source_ids=ids))
    return out


def _investigations(rows, known):
    out, seen = [], set()
    for ctx, row in rows:
        _require(ctx, row, "investigation_id", "subject", "url")
        iid = row["investigation_id"]
        if iid in seen:
            ctx.fail(f"duplicate investigation_id {iid!r}")
        seen.add(iid)
        if row["company"] not in COMPANIES:
            ctx.fail(f"unknown company {row['company']!r}; expected one of {COMPANIES}")
        if row["type"] not in INVESTIGATION_TYPES:
            ctx.fail(f"type {row['type']!r} must be one of {INVESTIGATION_TYPES}")
        if not iid.startswith(row["type"]):
            ctx.fail(f"investigation_id {iid!r} does not start with its type {row['type']!r}")
        if not _is_day(row["opened"]):
            ctx.fail(f"opened {row['opened']!r} must be YYYY-MM-DD")
        status, closed = row["status"], row["closed"]
        if status not in INVESTIGATION_STATUSES:
            ctx.fail(f"status {status!r} must be one of {INVESTIGATION_STATUSES}")
        if status == "closed" and not _is_day(closed):
            ctx.fail(f"status closed needs a closed date (YYYY-MM-DD), got {closed!r}")
        if status == "open" and closed:
            ctx.fail(f"status open but closed date {closed!r} is set")
        if not row["url"].startswith(("https://", "http://")):
            ctx.fail(f"url {row['url']!r} must start with http:// or https://")
        vehicles = row["vehicles_covered"]
        vehicles = (
            _number(ctx, vehicles, "vehicles_covered", allow_negative=False) if vehicles else None
        )
        if isinstance(vehicles, float):
            ctx.fail(f"vehicles_covered {row['vehicles_covered']!r} must be a whole number")
        _source_ids(ctx, row["source_id"], known, single=True)
        out.append(dict(row, vehicles_covered=vehicles))
    return out


def _events(rows, known):
    out = []
    for ctx, row in rows:
        _require(ctx, row, "label")
        if not _is_day(row["date"]):
            ctx.fail(f"date {row['date']!r} must be YYYY-MM-DD")
        _company_program(ctx, row, allow_all=True, allow_blank_program=True)
        if row["type"] not in EVENT_TYPES:
            ctx.fail(f"type {row['type']!r} must be one of {EVENT_TYPES}")
        _source_ids(ctx, row["source_id"], known, single=False)
        out.append(row)
    return out


def _cadence(rows):
    out, seen = [], set()
    for ctx, row in rows:
        _company_program(ctx, row)
        _require(ctx, row, "metric")
        days = row["expected_every_days"]
        if not days.isdigit() or int(days) <= 0:
            ctx.fail(f"expected_every_days {days!r} must be a positive whole number")
        if not _any_period_ok(row["last_period"]):
            ctx.fail(
                f"last_period {row['last_period']!r} must be YYYY, YYYY-Qn, YYYY-MM or YYYY-MM-DD"
            )
        key = (row["company"], row["program"], row["metric"])
        if key in seen:
            ctx.fail(f"duplicate (company, program, metric) {key}")
        seen.add(key)
        out.append(dict(row, expected_every_days=int(days)))
    return out


# --------------------------------------------------------------------- API
def load(manual_dir=None):
    """Read and validate every manual table; raise ManualDataError on any problem."""
    directory = Path(manual_dir) if manual_dir is not None else config.MANUAL_DIR
    sources = _sources(_read(directory, "sources"))
    known = {s["source_id"] for s in sources}
    return {
        "sources": sources,
        "exposure": _exposure(_read(directory, "exposure"), known),
        "company_reported": _company_reported(_read(directory, "company_reported"), known),
        "investigations": _investigations(_read(directory, "investigations"), known),
        "events": _events(_read(directory, "events"), known),
        "cadence": _cadence(_read(directory, "cadence")),
    }


def main():
    try:
        data = load()
    except ManualDataError as exc:
        print(f"manual data invalid: {exc}", file=sys.stderr)
        return 1
    for name, rows in data.items():
        print(f"{FILES[name]:24s} {len(rows):4d} rows")
    counts = {}
    for row in data["exposure"]:
        key = (row["program"], row["kind"])
        counts[key] = counts.get(key, 0) + 1
    for (program, kind), n in sorted(counts.items()):
        print(f"  exposure {program:16s} {kind:9s} {n:4d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
