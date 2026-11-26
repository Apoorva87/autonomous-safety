"""The golden reference database: every SGO column, every report version, explicit gaps.

build() turns the raw SGO files, the hand-curated manual tables and the previous
golden tables into the new set of tables (spec section 12). Nothing here
touches the disk except reading the raw CSVs: build_db.py reads and writes the
JSONL store and the sqlite file.

Tables
  reports          one row per (Report ID, Report Version) in any SGO file, every
                   version kept, placeholder ("No New or Updated Incident
                   Reports") filings included and flagged
  incidents        one row per incident_key, built from the latest version of
                   each report
  sources, exposure, company_reported, investigations, events, cadence
                   the manual tables, copied unchanged from manual.load()
  runs             one row per build: file hashes and last-modified stamps,
                   counts, placeholder rows, unmapped labels
  labels           reserved for future AI analysis; created empty and never
                   written or deleted by the builder

A reports row has four kinds of keys:
  meta        report_key, is_latest, source_file, row_hash, first_seen_run,
              last_seen_run, removed_in_run, previous_row_hash
  normalized  the harmonized fields (IDENTITY_FIELDS + STATUS_FIELDS + DERIVED_FIELDS)
  status      {field: one of STATUSES} for every field in STATUS_FIELDS
  raw         {source column: original string, whitespace-trimmed}; only the
              columns that exist in the row's era are present

Field status (STATUS_RULES is the one rule table):
  provided              the source gave a value
  reported_unknown      the source column exists but says Unknown, or is blank
  redacted_cbi          the value is the redaction marker, or its CBI flag is Y
  not_collected_in_era  the field's column does not exist in this era's schema
  not_applicable        the field does not apply to this report (a placeholder
                        filing, no crash partner, a no-agency answer ...)
The UI calls everything but "provided" "unavailable", with the status as the reason.
"""
import copy
import datetime
import hashlib
import json

from . import classify, harmonize, manual, schema

# ----------------------------------------------------------------- statuses
PROVIDED = "provided"
REPORTED_UNKNOWN = "reported_unknown"
REDACTED_CBI = "redacted_cbi"
NOT_COLLECTED = "not_collected_in_era"
NOT_APPLICABLE = "not_applicable"
STATUSES = (PROVIDED, REPORTED_UNKNOWN, REDACTED_CBI, NOT_COLLECTED, NOT_APPLICABLE)
UNAVAILABLE_REASONS = STATUSES[1:]

SEVERITY_RANK = {"unknown": 0, "none": 1, "minor": 2, "moderate": 3, "serious": 4, "fatal": 5}

LABEL_COLUMNS = (
    "report_key", "label_set", "label", "rationale", "evidence_fields", "model", "prompt_version", "run_at",
)

# --------------------------------------------------------------- rule table
# Conditions under which a field does not apply (used by "na_if" below).
NA_CONDITIONS = {
    # A fixed object or tree has no pre-crash movement and no contact areas.
    "no_crash_partner": lambda fields: fields["crash_with"] in ("fixed_object", "pole_tree"),
    # Consumer-owned vehicles have no commercial operating entity.
    "consumer_operated": lambda fields: fields["driver_operator_type"] == "consumer",
}


def _same(column, **extra):
    """A rule whose source column is the same in both eras."""
    return {"cols": {"archive": column, "current": column}, **extra}


def _flags(prefix, suffixes):
    return tuple("%s - %s" % (prefix, s) for s in suffixes)


def _both(column):
    return {"archive": column, "current": column}


_SV_CONTACT = _flags("SV Contact Area", schema.CONTACT_AREA_SUFFIXES)
_CP_CONTACT = _flags("CP Contact Area", schema.CONTACT_AREA_SUFFIXES)
_VERSION_RULES = {
    field: {
        "cols": {era: (spec[0] if spec else None) for era, spec in by_era.items()},
        "cbi_flag": {era: (spec[1] if spec else None) for era, spec in by_era.items()},
        "unknown_flag": {era: (spec[2] if spec else None) for era, spec in by_era.items()},
    }
    for field, by_era in schema.VERSION_COLUMNS.items()
}

# One entry per field that has a status. Keys of a rule:
#   cols          {era: source column | tuple of columns | None}. None means the
#                 era has no such column, so the status is not_collected_in_era.
#                 The test suite checks every column against schema.EXPECTED_COLUMNS.
#   cbi_flag      {era: Y/blank flag column that says the value was withheld as CBI}
#   unknown_flag  {era: Y/blank flag column that says the reporter did not know}
#   na_labels     lower-case source labels that mean "does not apply"
#   na_if         name in NA_CONDITIONS; a blank/unknown value is then not_applicable
#   list          the value is a list built from flag columns, so blank cells are
#                 normal and only the resulting list says whether it is known
#   flag          the value is itself a Y/blank answer; it is always provided
#   narrative     status follows harmonize.is_narrative_redacted
#   custom        status computed from the normalized severity (see _hospitalized)
#   same_as       copy the status of another field
# Evaluation order, first match wins (see field_status): placeholder filing ->
# not_applicable; no column in the era -> not_collected_in_era; CBI flag or
# redaction marker -> redacted_cbi; unknown flag -> reported_unknown; explicit
# "not applicable" label -> not_applicable; blank or unknown value ->
# not_applicable (when na_if holds) or reported_unknown; otherwise provided.
STATUS_RULES = {
    "month": _same("Incident Date", unknown_flag=_both("Incident Date - Unknown")),
    "incident_date_raw": {"same_as": "month"},
    "incident_time": _same("Incident Time (24:00)", unknown_flag=_both("Incident Time - Unknown")),
    "incident_time_unknown": _same("Incident Time - Unknown", flag=True),
    "submitted": _same("Report Submission Date"),
    "make": _same("Make", unknown_flag={"archive": None, "current": "Make - Unknown"}),
    "model": _same("Model", unknown_flag=_both("Model - Unknown")),
    "model_year": _same("Model Year", unknown_flag=_both("Model Year - Unknown")),
    "city": _same("City", unknown_flag=_both("City - Unknown")),
    "state": _same("State"),
    "roadway_type": _same("Roadway Type"),
    "surface": {"cols": {"archive": "Roadway Surface", "current": None}},
    "lighting": {"cols": {"archive": "Lighting", "current": None}},
    "roadway_conditions": {
        "cols": {"archive": "Roadway Description", "current": tuple(schema.ROADWAY_CONDITION_COLUMNS)},
        "list": True,
    },
    "weather": {
        "cols": {era: tuple(columns) for era, columns in schema.WEATHER_COLUMNS.items()},
        "list": True,
    },
    "speed_mph": _same("SV Precrash Speed (MPH)", unknown_flag=_both("SV Pre-crash Speed - Unknown")),
    "speed_limit": {
        "cols": {"archive": "Posted Speed Limit (MPH)", "current": None},
        "unknown_flag": {"archive": "Posted Speed Limit - Unknown", "current": None},
    },
    "crash_with": _same("Crash With"),
    "cp_movement": _same("CP Pre-Crash Movement", na_if="no_crash_partner"),
    "sv_movement": _same("SV Pre-Crash Movement"),
    "severity": _same("Highest Injury Severity Alleged"),
    "hospitalized": _same("Highest Injury Severity Alleged", custom="hospitalized"),
    "airbag": {
        "cols": {"archive": ("SV Any Air Bags Deployed?", "CP Any Air Bags Deployed?"), "current": "Any Air Bags Deployed?"},
        "na_labels": frozenset({"not applicable"}),
    },
    "towed": {
        "cols": {"archive": ("SV Was Vehicle Towed?", "CP Was Vehicle Towed?"), "current": "Was Any Vehicle Towed?"},
        "na_labels": frozenset({"not applicable"}),
    },
    "within_odd": _same("Within ODD?", cbi_flag=_both("Within ODD? - CBI")),
    "narrative": _same("Narrative", cbi_flag=_both("Narrative - CBI?"), narrative=True),
    "sv_contact_areas": _same(_SV_CONTACT, list=True),
    "cp_contact_areas": _same(_CP_CONTACT, list=True, na_if="no_crash_partner"),
    "data_availability": _same(tuple(schema.DATA_AVAILABILITY_COLUMNS), list=True),
    "report_sources": {
        "cols": {era: tuple(columns) for era, columns in schema.REPORT_SOURCE_COLUMNS.items()},
        "list": True,
    },
    "driver_operator_type": _same("Driver / Operator Type"),
    "engagement_status": {"cols": {"archive": None, "current": "Engagement Status"}},
    "automation_engaged": _same("Automation System Engaged?"),
    "ads_equipped": {"cols": {"archive": "ADS Equipped?", "current": None}},
    "operating_entity": _same("Operating Entity", unknown_flag=_both("Operating Entity - Unknown"), na_if="consumer_operated"),
    "belted": {"cols": {"archive": "SV Were All Passengers Belted?", "current": "Were All Passengers Belted?"}},
    "law_enforcement_investigating": {"cols": {"archive": "Law Enforcement Investigating?", "current": None}},
    "property_damage": {"cols": {"archive": "Property Damage?", "current": None}},
    "investigating_agency": _same(
        "Investigating Agency", unknown_flag=_both("Investigating Agency - Unknown"), na_labels=schema.NO_AGENCY),
    "vin_decoded": {"cols": {"archive": None, "current": "VIN Decoded"}},
    "mileage": {
        "cols": {"archive": "Mileage", "current": None},
        "unknown_flag": {"archive": "Mileage - Unknown", "current": None},
    },
    **_VERSION_RULES,
}
STATUS_FIELDS = tuple(STATUS_RULES)

# Fields without their own status: identity, and values computed from statused ones.
IDENTITY_FIELDS = (
    "is_placeholder", "report_id", "version", "incident_key", "era", "kind", "entity", "company", "program",
)
DERIVED_FIELDS = (
    "lag_days", "speed_band", "tags", "unknown_fields", "narrative_redacted", "narrative_partially_redacted",
    "version_redacted",
)
META_FIELDS = (
    "report_key", "is_latest", "source_file", "row_hash", "first_seen_run", "last_seen_run", "removed_in_run",
    "previous_row_hash",
)
# Flat columns of a reports row in canonical order. "narrative" has a status but no
# flat column: its text is raw["Narrative"].
REPORT_COLUMNS = (
    META_FIELDS
    + IDENTITY_FIELDS
    + tuple(f for f in STATUS_FIELDS if f != "narrative")
    + DERIVED_FIELDS
    + ("status", "raw")
)
assert len(set(REPORT_COLUMNS)) == len(REPORT_COLUMNS)

# Every table of the golden database, in build order.
TABLES = ("reports", "incidents") + tuple(manual.FILES) + ("runs", "labels")

# Sort keys for the JSONL files (reports and incidents are sorted by build()).
TABLE_SORT_KEYS = {
    "reports": ("report_key",),
    "incidents": ("incident_key",),
    "sources": ("source_id",),
    "exposure": ("company", "program", "region", "period_type", "period", "metric", "kind", "source_id"),
    "company_reported": ("company", "program", "region", "period_type", "period", "metric", "window", "source_id"),
    "investigations": ("investigation_id",),
    "events": ("date", "company", "program", "type", "label"),
    "cadence": ("company", "program", "metric"),
    "runs": ("run_id",),
    "labels": ("report_key", "label_set", "run_at", "label"),
}


# ------------------------------------------------------------- serialization
def dumps_row(row):
    """The one JSON encoding of a table row: sorted keys, compact, UTF-8 text."""
    return json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def sort_rows(table, rows):
    """Rows in the order they are stored in the JSONL file."""
    keys = TABLE_SORT_KEYS[table]
    return sorted(rows, key=lambda r: tuple("" if r.get(k) is None else str(r[k]) for k in keys))


def row_hash(raw):
    return hashlib.sha256(dumps_row(raw).encode("utf-8")).hexdigest()


# -------------------------------------------------------------- normalizing
# harmonize's private helpers are used on purpose: the golden builder is part of
# the same package and must read cells exactly as harmonize does.
_clean = harmonize._clean
_cat = harmonize._cat
_flag = harmonize._flag


def _flag_list(row, columns):
    """Labels of the flag columns that are set, in the order of the column map."""
    return [label for column, label in columns.items() if _flag(row, column)]


def _text(value):
    """Free text, or None when blank or Unknown (see schema.UNKNOWN_TEXT)."""
    return harmonize._text_or_none(value)


def _time(value):
    """'9:05' -> '09:05'; None for blank; unparseable values go to UNMAPPED."""
    if not value:
        return None
    try:
        parsed = datetime.datetime.strptime(value, "%H:%M")
    except ValueError:
        schema.UNMAPPED.add(("incident_time", value))
        return None
    return parsed.strftime("%H:%M")


def _version_text(row, era, field):
    spec = schema.VERSION_COLUMNS[field][era]
    if spec is None:
        return None
    value = _clean(row.get(spec[0]))
    if schema.REDACTION_MARKER in value:
        return None
    return _text(value)


def _contact_areas(row, side):
    columns = {"%s Contact Area - %s" % (side, suffix): label for suffix, label in schema.CONTACT_AREA_SUFFIXES.items()}
    return _flag_list(row, columns)


def _roadway_conditions(row, era):
    if era == "archive":
        label = _cat("roadway_conditions", _clean(row.get("Roadway Description")), schema.ROADWAY_CONDITION_LABELS)
        return [label] if label else []
    return _flag_list(row, schema.ROADWAY_CONDITION_COLUMNS)


def _scalar_fields(row, era, fields):
    """Fields that Task 2's Record does not carry."""
    cell = lambda column: _clean(row.get(column)) if column else None  # noqa: E731
    cols = {field: rule["cols"][era] for field, rule in STATUS_RULES.items() if "cols" in rule}
    out = {
        "incident_date_raw": cell("Incident Date") or None,
        "incident_time": _time(cell("Incident Time (24:00)")),
        "incident_time_unknown": _flag(row, "Incident Time - Unknown"),
        "roadway_conditions": _roadway_conditions(row, era),
        "sv_contact_areas": _contact_areas(row, "SV"),
        "cp_contact_areas": _contact_areas(row, "CP"),
        "data_availability": _flag_list(row, schema.DATA_AVAILABILITY_COLUMNS),
        "report_sources": _flag_list(row, schema.REPORT_SOURCE_COLUMNS[era]),
        "driver_operator_type": _cat("driver_operator_type", cell("Driver / Operator Type"), schema.DRIVER_OPERATOR_TYPE),
        "engagement_status": (
            _cat("engagement_status", cell("Engagement Status"), schema.ENGAGEMENT_STATUS) if cols["engagement_status"] else None
        ),
        "automation_engaged": _cat("engaged", cell("Automation System Engaged?"), schema.ENGAGED_MODE, "unknown"),
        "ads_equipped": _cat("ads_equipped", cell(cols["ads_equipped"]), schema.YES_NO_UNKNOWN),
        "operating_entity": _text(cell("Operating Entity")),
        "belted": _cat("belted", cell(cols["belted"]), schema.BELTED),
        "law_enforcement_investigating": _cat(
            "law_enforcement_investigating", cell(cols["law_enforcement_investigating"]), schema.YES_NO_UNKNOWN),
        "property_damage": _cat("property_damage", cell(cols["property_damage"]), schema.YES_NO_UNKNOWN),
        "vin_decoded": _cat("vin_decoded", cell(cols["vin_decoded"]), schema.VIN_DECODED),
        "mileage": harmonize._int("mileage", cell(cols["mileage"])) if cols["mileage"] else None,
    }
    agency = cell("Investigating Agency")
    out["investigating_agency"] = None if agency.lower() in schema.NO_AGENCY else _text(agency)
    for field in schema.VERSION_COLUMNS:
        out[field] = _version_text(row, era, field)
    return out


# Record fields copied into the golden row as they are.
_RECORD_FIELDS = (
    "incident_key", "entity", "company", "program", "month", "submitted", "lag_days", "make", "model", "model_year",
    "city", "state", "roadway_type", "surface", "lighting", "weather", "speed_mph", "speed_limit", "crash_with",
    "cp_movement", "sv_movement", "severity", "hospitalized", "airbag", "towed", "within_odd", "narrative_redacted",
    "version_redacted", "unknown_fields",
)


def _placeholder_fields(row, era, kind):
    """A placeholder filing says "no new reports this month": identity only."""
    fields = {name: None for name in REPORT_COLUMNS if name not in META_FIELDS + ("status", "raw")}
    entity = _clean(row.get("Reporting Entity"))
    fields.update(
        is_placeholder=True,
        report_id=_clean(row.get("Report ID")),
        version=harmonize._version(row, era),
        era=era,
        kind=kind,
        entity=entity,
        company=schema.COMPANY_BY_ENTITY.get(entity, "other"),
        tags=[],
    )
    for field in ("weather", "roadway_conditions", "sv_contact_areas", "cp_contact_areas", "data_availability",
                  "report_sources"):
        fields[field] = []
    return fields


def _hospitalized_status(fields, era):
    """The archive severity labels carry no hospitalization; current labels spell it out."""
    severity = fields["severity"]
    if severity == "unknown":
        return REPORTED_UNKNOWN
    if severity == "none":
        return PROVIDED
    if era == "archive":
        return NOT_COLLECTED
    return NOT_APPLICABLE if severity == "fatal" else PROVIDED


_CUSTOM = {"hospitalized": _hospitalized_status}


def _is_unknown(value):
    if isinstance(value, list):
        return not value or set(value) == {"unknown"}
    return value is None or value == "unknown"


def field_status(field, row, era, fields):
    """Status of one normalized field for one source row (rules: STATUS_RULES)."""
    rule = STATUS_RULES[field]
    cols = rule["cols"][era]
    if cols is None:
        return NOT_COLLECTED
    if rule.get("flag"):
        return PROVIDED
    if "custom" in rule:
        return _CUSTOM[rule["custom"]](fields, era)
    cells = [_clean(row.get(c)) for c in ((cols,) if isinstance(cols, str) else cols)]

    cbi_column = rule.get("cbi_flag", {}).get(era)
    flagged = bool(cbi_column) and _clean(row.get(cbi_column)) == "Y"
    if rule.get("narrative"):
        if not cells[0]:
            return REDACTED_CBI if flagged else REPORTED_UNKNOWN
        return REDACTED_CBI if fields["narrative_redacted"] else PROVIDED
    if flagged or any(schema.REDACTION_MARKER in c for c in cells):
        return REDACTED_CBI

    unknown_column = rule.get("unknown_flag", {}).get(era)
    if unknown_column and _clean(row.get(unknown_column)) == "Y":
        return REPORTED_UNKNOWN

    value = fields[field]
    unknown = _is_unknown(value) or (not rule.get("list") and not any(cells))
    if not unknown:
        return PROVIDED
    given = [c.lower() for c in cells if c]
    if given and all(c in rule.get("na_labels", ()) for c in given):
        return NOT_APPLICABLE
    condition = rule.get("na_if")
    if condition and NA_CONDITIONS[condition](fields):
        return NOT_APPLICABLE
    return REPORTED_UNKNOWN


def normalize_row(row, era, kind, ads_entities=frozenset()):
    """(fields, status) for one raw row, whatever its version.

    fields holds the identity, normalized and derived values; status maps every
    STATUS_FIELDS name to one of STATUSES. Make and model are spelled as in the
    row; build() unifies spellings across the whole dataset afterwards.
    """
    if harmonize.is_placeholder(row):
        fields = _placeholder_fields(row, era, kind)
        return fields, {field: NOT_APPLICABLE for field in STATUS_FIELDS}

    record = harmonize.harmonize_row(row, era, kind, ads_entities)
    fields = {name: record[name] for name in _RECORD_FIELDS}
    fields.update(
        is_placeholder=False,
        report_id=record["id"],
        version=record["ver"],
        era=era,
        kind=kind,
        speed_band=classify.speed_band(record),
        tags=classify.tag(record),
    )
    fields.update(_scalar_fields(row, era, fields))
    text = record["narrative"]
    fields["narrative_partially_redacted"] = bool(text) and not record["narrative_redacted"] and schema.REDACTION_MARKER in text

    status = {}
    for field in STATUS_FIELDS:
        if "same_as" not in STATUS_RULES[field]:
            status[field] = field_status(field, row, era, fields)
    for field in STATUS_FIELDS:
        if "same_as" in STATUS_RULES[field]:
            status[field] = status[STATUS_RULES[field]["same_as"]]
    return fields, {field: status[field] for field in STATUS_FIELDS}


# ------------------------------------------------------------------- build
def _source_item(spec, row):
    raw = {}
    for column, value in row.items():
        if column is None:
            raise ValueError("%s: a row has more cells than the header" % spec["key"])
        raw[column] = (value or "").strip()
    report_id = raw.get("Report ID", "")
    version = harmonize._version(row, spec["era"])
    return {
        "spec": spec,
        "row": row,
        "raw": raw,
        "report_id": report_id,
        "version": version,
        "key": "%s|v%d" % (report_id, version),
        "placeholder": harmonize.is_placeholder(row),
    }


def _mark_latest(items):
    """Set item["latest"]: one per Report ID, the highest version.

    A real report outranks a placeholder filing with the same ID; among real
    reports this is exactly harmonize.load_all's choice.
    """
    best = {}
    for item in items:
        rank = (not item["placeholder"], item["version"])
        current = best.get(item["report_id"])
        if current is None or rank > current[0]:
            best[item["report_id"]] = (rank, item)
    for item in items:
        item["latest"] = best[item["report_id"]][1] is item


def _stamp(http_date):
    try:
        return datetime.datetime.strptime(http_date, "%a, %d %b %Y %H:%M:%S GMT").strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError):
        return http_date


def _build_incidents(reports):
    active = [r for r in reports if r["removed_in_run"] is None and not r["is_placeholder"]]
    keys_by_report = {}
    for r in active:
        keys_by_report.setdefault(r["report_id"], []).append(r["report_key"])
    groups = {}
    for r in active:
        if r["is_latest"]:
            groups.setdefault(r["incident_key"], []).append(r)
    incidents = []
    for incident_key, rows in groups.items():
        rep = min(rows, key=lambda r: (-SEVERITY_RANK[r["severity"]], r["report_id"]))
        ids = sorted(r["report_id"] for r in rows)
        incidents.append({
            "incident_key": incident_key,
            "month": rep["month"],
            "companies": sorted({r["company"] for r in rows}),
            "programs": sorted({r["program"] for r in rows}),
            "max_severity": rep["severity"],
            "report_count": len(rows),
            "report_ids": ids,
            "report_keys": sorted(k for i in ids for k in keys_by_report[i]),
            "latest_report_keys": sorted(r["report_key"] for r in rows),
            "representative_report_key": rep["report_key"],
        })
    return sort_rows("incidents", incidents)


def build(raw_dir, manual_tables, run_id, previous=None, fetch_log=None, allow_missing=False):
    """Build every golden table (dict table name -> list of row dicts).

    raw_dir          directory with the six SGO CSVs
    manual_tables    manual.load() output
    run_id           names this build (a UTC timestamp in production). Rows seen
                     before keep first_seen_run; rows present now get
                     last_seen_run = run_id; rows that vanished get removed_in_run
    previous         the tables of the last build (build_db.read_previous), for
                     first_seen_run carry-over, the runs history and labels
    fetch_log        the parsed data/registry/fetch_log.json, for the runs table
    allow_missing    tolerate absent source files (tests use a partial directory)
    """
    previous = previous or {}
    schema.UNMAPPED.clear()
    entries = list(harmonize.iter_source_rows(raw_dir, allow_missing))
    ads_entities = harmonize.collect_ads_entities(entries)

    items, seen, file_rows = [], {}, {}
    for spec, row in entries:
        item = _source_item(spec, row)
        if item["key"] in seen:
            raise ValueError("duplicate report %s in %s and %s" % (item["key"], seen[item["key"]], spec["key"]))
        seen[item["key"]] = spec["key"]
        file_rows[spec["key"]] = file_rows.get(spec["key"], 0) + 1
        items.append(item)
    _mark_latest(items)

    for item in items:
        spec = item["spec"]
        item["fields"], item["status"] = normalize_row(item["row"], spec["era"], spec["kind"], ads_entities)
    real_latest = [i["fields"] for i in items if i["latest"] and not i["placeholder"]]
    for field in ("make", "model"):
        canonical = harmonize.canonical_spellings(real_latest, field)
        for item in items:
            value = item["fields"][field]
            if value is not None:
                item["fields"][field] = canonical.get(harmonize.name_key(value), value)

    old = {r["report_key"]: r for r in previous.get("reports", [])}
    reports = []
    for item in items:
        digest = row_hash(item["raw"])
        before = old.get(item["key"])
        if before is None:
            first, replaced = run_id, None
        elif before["row_hash"] == digest:
            first, replaced = before["first_seen_run"], before.get("previous_row_hash")
        else:
            first, replaced = run_id, before["row_hash"]
        report = {
            "report_key": item["key"],
            "is_latest": item["latest"],
            "source_file": item["spec"]["key"],
            "row_hash": digest,
            "first_seen_run": first,
            "last_seen_run": run_id,
            "removed_in_run": None,
            "previous_row_hash": replaced,
            **item["fields"],
            "status": item["status"],
            "raw": item["raw"],
        }
        reports.append(report)
    present = {r["report_key"] for r in reports}
    for key, before in old.items():
        if key not in present:  # withdrawn from the source: kept, marked, never deleted
            gone = copy.deepcopy(before)
            gone["is_latest"] = False
            gone["removed_in_run"] = before.get("removed_in_run") or run_id
            reports.append(gone)
    reports = sort_rows("reports", reports)
    incidents = _build_incidents(reports)

    tables = {"reports": reports, "incidents": incidents}
    for name in manual.FILES:
        tables[name] = copy.deepcopy(list(manual_tables.get(name, [])))
    tables["runs"] = sort_rows(
        "runs",
        [r for r in previous.get("runs", []) if r["run_id"] != run_id]
        + [_run_row(run_id, reports, incidents, entries, file_rows, fetch_log)],
    )
    tables["labels"] = list(previous.get("labels", []))
    return tables


def _run_row(run_id, reports, incidents, entries, file_rows, fetch_log):
    active = [r for r in reports if r["removed_in_run"] is None]
    log = {e["key"]: e for e in (fetch_log or [])}
    placeholders = sum(1 for _, row in entries if harmonize.is_placeholder(row))
    return {
        "run_id": run_id,
        "nhtsa_last_modified": {k: _stamp(e.get("last_modified")) for k, e in sorted(log.items())},
        "file_sha256": {k: e.get("sha256") for k, e in sorted(log.items())},
        "file_rows": dict(sorted(file_rows.items())),
        "placeholder_rows_skipped": placeholders,
        "counts": {
            "reports": len(reports),
            "active_reports": len(active),
            "latest_reports": sum(1 for r in active if r["is_latest"] and not r["is_placeholder"]),
            "incidents": len(incidents),
            "new_rows": sum(1 for r in active if r["first_seen_run"] == run_id and r["previous_row_hash"] is None),
            "changed_rows": sum(1 for r in active if r["first_seen_run"] == run_id and r["previous_row_hash"] is not None),
            "removed_rows": sum(1 for r in reports if r["removed_in_run"] == run_id),
        },
        "unmapped": sorted("%s=%s" % pair for pair in schema.UNMAPPED),
    }
