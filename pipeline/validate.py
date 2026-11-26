"""Validation gate (spec section 9): errors stop the update, warnings are shown.

check(raw_dir, ...) -> (errors, warnings) runs on the raw SGO files and the
manual tables *before* anything is built, so a bad file never reaches the golden
database or the site. check_outputs(outputs, tables) runs after aggregation,
before anything is written, for the checks that need the built tables.

Errors (nothing is built or deployed):
  - a raw file is missing, or its header differs from schema.EXPECTED_COLUMNS
    (missing and extra columns are named)
  - schema.UNMAPPED is not empty: a label the maps do not know (named), never
    silently mapped to unknown
  - a file's row count dropped against the previous fetch log
  - unique real reports dropped against the previous meta.json
  - an expected entity (data/registry/expected_entities.json) disappeared
  - more than PARSE_FAILURE_LIMIT of rows fail date/number parsing
  - a manual row cites a source_id that does not resolve (manual.load raises)
  - a (Report ID, Report Version) appears twice, in one file or across files
  - counts.json does not add up to the unique incidents / reports
Warnings (deploy, but show):
  - a company disclosure is older than disclosure_cadence.csv expects
  - a new reporting entity
  - a company's monthly report count swung by more than 50% (SWING_*)
  - the month-resolution lag note
"""
import csv
import datetime
import json
from collections import Counter, defaultdict
from pathlib import Path

from . import config, harmonize, manual, schema

PARSE_FAILURE_LIMIT = 0.005
EXPECTED_ENTITIES_PATH = config.REPO_ROOT / "data" / "registry" / "expected_entities.json"

# Month-over-month swings: compared over the last SWING_PAIRS month pairs, leaving
# out the newest IMMATURE_MONTHS months (reports for them are still arriving) and
# pairs where both months are below SWING_MIN_COUNT reports.
SWING_FRACTION = 0.5
SWING_MIN_COUNT = 20
SWING_PAIRS = 6
IMMATURE_MONTHS = 2
MAX_LISTED = 12

DATE_COLUMNS = ("Incident Date", "Report Submission Date")
NUMBER_COLUMNS = ("Model Year", "SV Precrash Speed (MPH)", "Posted Speed Limit (MPH)", "Mileage")

LAG_NOTE = (
    "Reporting lag has month resolution only: NHTSA publishes the incident month and the submission month, "
    "so lag is a whole-month difference and the lag-adjusted views are approximate."
)


def load_expected_entities(path=None):
    path = Path(path) if path is not None else EXPECTED_ENTITIES_PATH
    return list(json.loads(path.read_text(encoding="utf-8"))["entities"])


def _cap(items, noun="item"):
    """Items for a message: the first MAX_LISTED, then a count of the rest."""
    items = list(items)
    shown = ", ".join(items[:MAX_LISTED])
    return shown + (" (and %d more)" % (len(items) - MAX_LISTED) if len(items) > MAX_LISTED else "")


# ------------------------------------------------------------------- headers
def read_header(path):
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        return next(csv.reader(f), [])


def check_headers(raw_dir):
    errors = []
    for spec in config.SGO_FILES:
        key = spec["key"]
        path = Path(raw_dir) / (key + ".csv")
        if not path.exists():
            errors.append("%s: file missing (%s)" % (key, path))
            continue
        header = read_header(path)
        names = set(header)
        expected = schema.EXPECTED_COLUMNS[key]
        if names - expected:
            errors.append("%s: extra column(s) not in the expected schema: %s" % (key, _cap(sorted(names - expected))))
        if expected - names:
            errors.append("%s: missing column(s) from the expected schema: %s" % (key, _cap(sorted(expected - names))))
        if len(header) != len(names):
            dupes = sorted(n for n, c in Counter(header).items() if c > 1)
            errors.append("%s: duplicate column name(s): %s" % (key, _cap(dupes)))
    return errors


# --------------------------------------------------------------------- rows
def _read_entries(raw_dir):
    return list(harmonize.iter_source_rows(raw_dir))


def check_duplicates(entries):
    seen, errors = {}, []
    for spec, row in entries:
        key = (harmonize._clean(row.get("Report ID")), harmonize._version(row, spec["era"]))
        if key in seen:
            errors.append("duplicate (Report ID, Version) %s v%d in %s and %s" % (key[0], key[1], seen[key], spec["key"]))
        else:
            seen[key] = spec["key"]
    return errors


def _bad_date(value):
    value = harmonize._clean(value)
    return bool(value) and harmonize._month_year(value) is None


def _bad_number(value):
    value = harmonize._clean(value)
    return bool(value) and not value.isdigit()


def parse_failures(rows):
    """(rows with an unparseable date or number, rows examined). Placeholder filings and blanks are skipped."""
    failed = total = 0
    for row in rows:
        if harmonize.is_placeholder(row):
            continue
        total += 1
        if any(_bad_date(row.get(c)) for c in DATE_COLUMNS) or any(_bad_number(row.get(c)) for c in NUMBER_COLUMNS):
            failed += 1
    return failed, total


def check_unmapped(unmapped):
    return [
        "unmapped %s label %r: not in the value map (add it to schema.py; it is never silently mapped to unknown)"
        % (field, value)
        for field, value in sorted(unmapped)
    ]


def previous_file_rows(previous_fetch_log=None, previous_meta=None):
    """{file key: highest row count recorded by the previous fetch log / meta.json}."""
    rows = {}

    def note(key, n):
        if key is not None and isinstance(n, int):
            rows[key] = max(rows.get(key, 0), n)

    for entry in previous_fetch_log or []:
        note(entry.get("key"), entry.get("rows"))
    meta = previous_meta or {}
    for key, entry in (meta.get("fetch_log") or {}).items():
        note(key, entry.get("rows"))
    for entry in meta.get("files") or []:  # the shape of the first preview meta.json
        note(entry.get("key"), entry.get("rows"))
    return rows


def check_row_counts(current, previous):
    return [
        "%s: row count dropped from %d to %d since the previous fetch" % (key, previous[key], current.get(key, 0))
        for key in sorted(previous)
        if current.get(key, 0) < previous[key]
    ]


def previous_reports_total(previous_meta):
    meta = previous_meta or {}
    total = (meta.get("counts_total") or {}).get("reports")
    return total if total is not None else meta.get("total_reports")


# --------------------------------------------------------------- entities
def check_entities(records, expected, previous_meta):
    errors, warnings = [], []
    present = {r["entity"] for r in records}
    for entity in expected:
        if entity not in present:
            errors.append("expected entity disappeared from the data: %s" % entity)
    previous = (previous_meta or {}).get("entities")
    if previous is not None:
        known = set(previous) | set(expected)
        warnings.extend("new reporting entity: %s" % e for e in sorted(present - known))
    return errors, warnings


# ------------------------------------------------------------------ cadence
def _last_date(period):
    """The last day a cadence period covers: YYYY-MM-DD, YYYY-MM, YYYY-Qn or YYYY."""
    period = period.strip()
    if len(period) == 10:
        return datetime.date.fromisoformat(period)
    if "-Q" in period:
        year, quarter = int(period[:4]), int(period[-1])
        month = 3 * quarter
    elif len(period) == 7:
        year, month = int(period[:4]), int(period[5:7])
    else:
        year, month = int(period), 12
    nxt = datetime.date(year + (month == 12), month % 12 + 1, 1)
    return nxt - datetime.timedelta(days=1)


def cadence_status(cadence_rows, today):
    """One dict per disclosure_cadence row, with the age of its last disclosure and a stale flag."""
    out = []
    for row in cadence_rows:
        last = _last_date(row["last_period"])
        age = (today - last).days
        out.append({
            "company": row["company"], "program": row["program"], "metric": row["metric"],
            "expected_every_days": row["expected_every_days"], "last_period": row["last_period"],
            "last_date": last.isoformat(), "age_days": age, "stale": age > row["expected_every_days"],
        })
    return out


def check_cadence(cadence_rows, today):
    return [
        "stale disclosure: %s/%s %s last covers %s (%d days ago), expected every %d days"
        % (s["company"], s["program"], s["metric"], s["last_period"], s["age_days"], s["expected_every_days"])
        for s in cadence_status(cadence_rows, today) if s["stale"]
    ]


# ------------------------------------------------------------------- swings
def check_swings(records):
    """Warn when a company's monthly report count moves by more than SWING_FRACTION in a month."""
    by_company = defaultdict(Counter)
    for r in records:
        if r["month"]:
            by_company[r["company"]][r["month"]] += 1
    warnings = []
    for company, counts in sorted(by_company.items()):
        months = sorted(counts)
        first, last = months[0], months[-1]
        series = []
        y, m = int(first[:4]), int(first[5:])
        while "%04d-%02d" % (y, m) <= last:
            label = "%04d-%02d" % (y, m)
            series.append((label, counts.get(label, 0)))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        mature = series[:-IMMATURE_MONTHS] if IMMATURE_MONTHS else series
        window = mature[-(SWING_PAIRS + 1):]
        for (_, before), (month, after) in zip(window, window[1:]):
            if before and max(before, after) >= SWING_MIN_COUNT and abs(after - before) / before > SWING_FRACTION:
                warnings.append(
                    "%s: reports by incident month went from %d to %d in %s (%+.0f%% month over month)"
                    % (company, before, after, month, 100.0 * (after - before) / before)
                )
    return warnings


# ----------------------------------------------------------------- the gate
def check(raw_dir, today=None, manual_dir=None, expected_entities=None, previous_meta=None, previous_fetch_log=None):
    """Validate the raw files and manual tables. Returns (errors, warnings); errors mean: build nothing."""
    today = today or datetime.date.today()
    errors, warnings = [], []
    errors.extend(check_headers(raw_dir))
    try:
        tables = manual.load(manual_dir, today=today)
    except manual.ManualDataError as exc:
        errors.append("manual data invalid: %s" % exc)
        tables = None
    if errors:
        return errors, warnings  # the files cannot be read reliably; the rest would only add noise

    entries = _read_entries(raw_dir)
    errors.extend(check_duplicates(entries))
    current_rows = Counter(spec["key"] for spec, _ in entries)
    errors.extend(check_row_counts(current_rows, previous_file_rows(previous_fetch_log, previous_meta)))
    failed, total = parse_failures(row for _, row in entries)
    if total and failed / total > PARSE_FAILURE_LIMIT:
        errors.append("date/number parse failures: %d of %d rows (%.2f%%) exceed the %.1f%% limit"
                      % (failed, total, 100.0 * failed / total, 100.0 * PARSE_FAILURE_LIMIT))

    records = harmonize.load_all(raw_dir)  # fills schema.UNMAPPED
    errors.extend(check_unmapped(schema.UNMAPPED))
    previous_total = previous_reports_total(previous_meta)
    if previous_total is not None and len(records) < previous_total:
        errors.append("unique reports dropped from %d to %d since the previous run" % (previous_total, len(records)))
    entity_errors, entity_warnings = check_entities(
        records, expected_entities if expected_entities is not None else load_expected_entities(), previous_meta)
    errors.extend(entity_errors)
    warnings.extend(entity_warnings)

    if tables is not None:
        warnings.extend(check_cadence(tables["cadence"], today))
    warnings.extend(check_swings(records))
    warnings.append(LAG_NOTE)
    return errors, warnings


# ------------------------------------------------------- checks after aggregate
def check_counts(rows, reports, unique_incidents):
    """counts.json must reconcile with the current golden reports, program by program.

    reports  the current golden reports rows. Per program: the `reports` column adds up to that
    program's reports and `crashes` to its unique incident_keys. Globally, the unique
    incident_keys equal `unique_incidents` (crashes are not additive across programs).
    """
    errors = []
    want_reports = Counter(r["program"] for r in reports)
    want_crashes = defaultdict(set)
    for r in reports:
        want_crashes[r["program"]].add(r["incident_key"])
    got_reports, got_crashes = Counter(), Counter()
    for row in rows:
        got_reports[row["program"]] += row["reports"]
        got_crashes[row["program"]] += row["crashes"]
    for program in sorted(set(want_reports) | set(got_reports)):
        if got_reports[program] != want_reports[program]:
            errors.append("counts.json %s: rows add up to %d reports but the program has %d current reports"
                          % (program, got_reports[program], want_reports[program]))
        if got_crashes[program] != len(want_crashes[program]):
            errors.append("counts.json %s: rows add up to %d crashes but the program has %d unique incidents"
                          % (program, got_crashes[program], len(want_crashes[program])))
    total = len({r["incident_key"] for r in reports})
    if total != unique_incidents:
        errors.append("unique incidents total is %d but the current reports hold %d" % (unique_incidents, total))
    return errors


def check_exposure_sources(outputs):
    known = {s["source_id"] for s in outputs["sources.json"]["rows"]}
    errors = []
    for row in outputs["exposure.json"]["rows"]:
        if not row["source_ids"]:
            errors.append("exposure row %s/%s/%s %s has no source_id" % (row.get("program"), row.get("region"), row.get("metric"), row.get("period")))
        for sid in row["source_ids"]:
            if sid not in known:
                errors.append("exposure row cites unknown source_id %s" % sid)
    return errors


def check_responsibility(tables, reports):
    """Every current report has exactly one responsibility label, and no label points at a vanished report.

    tables   needs "labels"; reports  the golden reports rows (any version, any state).
    """
    from . import responsibility

    current = {r["report_key"] for r in reports if responsibility.is_current(r)}
    seen = Counter(l["report_key"] for l in tables.get("labels", []) if l.get("label_set") == responsibility.LABEL_SET)
    errors = []
    for key in sorted(current):
        if seen[key] != 1:
            errors.append("report %s has %s %s label(s), expected exactly one"
                          % (key, "no" if not seen[key] else seen[key], responsibility.LABEL_SET))
    for key in sorted(set(seen) - current):
        errors.append("%s label for %s, which is not a current report" % (responsibility.LABEL_SET, key))
    return errors


def check_outputs(outputs, tables):
    """Post-aggregate checks (errors only)."""
    from . import aggregate

    reports = aggregate.current_reports(tables)
    incidents = len({r["incident_key"] for r in reports})
    errors = check_counts(outputs["counts.json"]["rows"], reports, outputs["meta.json"]["counts_total"]["unique_incidents"])
    if incidents != len(tables["incidents"]):
        errors.append("golden incidents table has %d rows but the reports hold %d unique incidents" % (len(tables["incidents"]), incidents))
    if len(outputs["records.json"]["rows"]) != incidents:
        errors.append("records.json has %d rows but there are %d unique incidents" % (len(outputs["records.json"]["rows"]), incidents))
    reports_by_program = Counter(r["program"] for r in reports)
    for program, entry in outputs["lag.json"]["programs"].items():
        if entry["n_reports"] != reports_by_program[program]:
            errors.append("lag.json %s: %d reports but counts has %d" % (program, entry["n_reports"], reports_by_program[program]))
    errors.extend(check_exposure_sources(outputs))
    return errors
