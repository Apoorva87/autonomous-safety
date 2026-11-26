"""Tests for the golden database builder (pipeline/golden.py, pipeline/build_db.py).

Most tests use the small fixture CSVs in tests/fixtures (three files, with
multi-version reports, a shared incident, a CBI-redacted narrative and a
placeholder filing) and one-off rows edited in memory. Tests marked "live" use
the real files in data/raw and skip cleanly when they are absent.
"""
import copy
import csv
import hashlib
import json
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from pipeline import aggregate, build_db, config, golden, harmonize, manual, schema

FIXTURES = Path(__file__).resolve().parent / "fixtures"
EMPTY_MANUAL = {name: [] for name in manual.FILES}
LIVE_AVAILABLE = all((config.RAW_DIR / (s["key"] + ".csv")).exists() for s in config.SGO_FILES)

FETCH_LOG = [
    {"key": "archive_ADAS", "last_modified": "Thu, 26 Mar 2026 20:12:34 GMT", "sha256": "aa", "bytes": 10, "rows": 6},
    {"key": "current_ADS", "last_modified": "Mon, 16 Nov 2026 13:31:10 GMT", "sha256": "bb", "bytes": 20, "rows": 5},
]


def fixture_row(filename, report_id, version=None):
    with open(FIXTURES / filename, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row["Report ID"] == report_id and (version is None or row["Report Version"] == version):
                return dict(row)
    raise KeyError(report_id)


def era_kind(filename):
    era, kind = filename[:-4].split("_")
    return era, kind


def normalize(filename, report_id, **changes):
    """Normalize a fixture row after editing some of its columns."""
    row = fixture_row(filename, report_id)
    row.update(changes)
    era, kind = era_kind(filename)
    return golden.normalize_row(row, era, kind)


def record_crashes(records):
    """[(representative record, report count)] per incident_key, restated over harmonize Records.

    Independent of aggregate.unique_crashes (which reads golden rows), so the incidents
    table is checked against a second implementation of the representative-report rule.
    """
    groups = {}
    for r in records:
        groups.setdefault(r["incident_key"], []).append(r)
    return [(min(g, key=lambda r: (-golden.SEVERITY_RANK[r["severity"]], r["id"])), len(g)) for g in groups.values()]


def copy_fixtures(directory):
    for path in FIXTURES.glob("*.csv"):
        shutil.copy(path, Path(directory) / path.name)


def edit_csv(path, edit):
    """Rewrite a CSV after `edit(rows)` changed the list of row dicts in place."""
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames
        rows = list(reader)
    edit(rows)
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def drop_rows(rows, keep):
    """For edit_csv: keep only the rows for which keep(row) is true."""
    rows[:] = [r for r in rows if keep(r)]


def golden_last_seen(tables):
    """Independent restatement of the last_seen_run rule for sqlite."""
    runs = sorted(r["run_id"] for r in tables["runs"])
    out = {}
    for row in tables["reports"]:
        if row["removed_in_run"] is None:
            out[row["report_key"]] = runs[-1]
        else:
            out[row["report_key"]] = max(r for r in runs if r < row["removed_in_run"])
    return out


def by_key(rows, key="report_key"):
    return {r[key]: r for r in rows}


_LIVE = {}


def live_tables():
    if "tables" not in _LIVE:
        _LIVE["tables"] = golden.build(config.RAW_DIR, EMPTY_MANUAL, "RUN-LIVE")
    return _LIVE["tables"]


class FixtureCase(unittest.TestCase):
    """Builds the fixture directory into tables once per test."""

    def setUp(self):
        schema.UNMAPPED.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.raw = Path(self.tmp.name) / "raw"
        self.raw.mkdir()
        copy_fixtures(self.raw)
        self.golden_dir = Path(self.tmp.name) / "golden"

    def build(self, run_id="R1", previous=None, manual_data=EMPTY_MANUAL, fetch_log=None):
        return golden.build(self.raw, manual_data, run_id, previous=previous, fetch_log=fetch_log, allow_missing=True)


# ------------------------------------------------------------------ raw rows
class RawRowTests(FixtureCase):
    def test_every_fixture_row_is_kept_with_every_source_column(self):
        tables = self.build()
        n = 0
        for filename in ("archive_ADAS.csv", "current_ADS.csv", "current_OTHER.csv"):
            key = filename[:-4]
            expected = schema.EXPECTED_COLUMNS[key]
            rows = [r for r in tables["reports"] if r["source_file"] == key]
            with open(FIXTURES / filename, encoding="utf-8", newline="") as f:
                source = list(csv.DictReader(f))
            self.assertEqual(len(rows), len(source))
            for r in rows:
                self.assertEqual(set(r["raw"]), set(expected))
            n += len(rows)
        self.assertEqual(n, len(tables["reports"]))

    def test_raw_values_are_trimmed_only(self):
        tables = self.build()
        row = by_key(tables["reports"])["T-100|v1"]
        self.assertEqual(row["raw"]["State"], "CA")  # source has 'CA '
        self.assertEqual(row["raw"]["Crash With"], "Passenger Car")
        # blank cells stay as empty strings: the column exists but is empty
        self.assertEqual(row["raw"]["Zip Code"], "")

    def test_columns_absent_in_era_are_absent_from_raw(self):
        rows = by_key(self.build()["reports"])
        self.assertNotIn("Lighting", rows["TR-1|v1"]["raw"])
        self.assertNotIn("Engagement Status", rows["T-100|v1"]["raw"])
        self.assertIn("Lighting", rows["T-100|v1"]["raw"])

    def test_row_hash_is_sha256_of_canonical_raw_row(self):
        row = by_key(self.build()["reports"])["T-100|v1"]
        canonical = json.dumps(row["raw"], sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        self.assertEqual(row["row_hash"], hashlib.sha256(canonical.encode("utf-8")).hexdigest())

    def test_row_hash_differs_between_versions(self):
        rows = by_key(self.build()["reports"])
        self.assertNotEqual(rows["T-100|v1"]["row_hash"], rows["T-100|v2"]["row_hash"])

    def test_duplicate_report_id_and_version_is_an_error(self):
        edit_csv(self.raw / "archive_ADAS.csv", lambda rows: rows.append(dict(rows[0])))
        with self.assertRaises(ValueError):
            self.build()


# ------------------------------------------------------------------ versions
class VersionTests(FixtureCase):
    def test_all_versions_kept(self):
        rows = by_key(self.build()["reports"])
        self.assertIn("T-100|v1", rows)
        self.assertIn("T-100|v2", rows)
        self.assertEqual(rows["T-100|v1"]["version"], 1)
        self.assertEqual(rows["T-100|v2"]["report_id"], "T-100")

    def test_exactly_one_latest_per_report_id(self):
        reports = self.build()["reports"]
        latest = {}
        for r in reports:
            if r["is_latest"]:
                latest.setdefault(r["report_id"], []).append(r["report_key"])
        self.assertEqual({k: len(v) for k, v in latest.items()}, {rid: 1 for rid in {r["report_id"] for r in reports}})
        self.assertEqual(latest["T-100"], ["T-100|v2"])

    def test_latest_equals_harmonize_choice(self):
        reports = self.build()["reports"]
        records = harmonize.load_all(FIXTURES, allow_missing=True)
        latest = {r["report_id"]: r for r in reports if r["is_latest"] and not r["is_placeholder"]}
        self.assertEqual(set(latest), {r["id"] for r in records})
        for rec in records:
            self.assertEqual(latest[rec["id"]]["version"], rec["ver"])

    def test_normalized_fields_match_harmonize_records(self):
        reports = self.build()["reports"]
        records = harmonize.load_all(FIXTURES, allow_missing=True)
        latest = {r["report_id"]: r for r in reports if r["is_latest"] and not r["is_placeholder"]}
        renamed = {"id": "report_id", "ver": "version", "file": "kind"}
        for rec in records:
            row = latest[rec["id"]]
            for field, value in rec.items():
                if field == "narrative":
                    self.assertEqual(row["raw"]["Narrative"], value)
                    continue
                self.assertEqual(row[renamed.get(field, field)], value, (rec["id"], field))

    def test_placeholder_rows_are_kept_and_flagged(self):
        rows = by_key(self.build()["reports"])
        self.assertTrue(rows["P-1|v1"]["is_placeholder"])
        self.assertFalse(rows["T-100|v1"]["is_placeholder"])
        self.assertTrue(rows["P-1|v1"]["is_latest"])
        self.assertEqual(set(rows["P-1|v1"]["status"].values()) - {"not_applicable", "provided"}, set())

    def test_superseded_row_keeps_its_own_normalized_values(self):
        rows = by_key(self.build()["reports"])
        self.assertEqual(rows["T-100|v1"]["month"], "2024-01")
        self.assertEqual(rows["T-100|v2"]["month"], "2024-02")
        self.assertEqual(rows["T-100|v1"]["weather"], ["clear"])
        self.assertEqual(rows["T-100|v2"]["weather"], ["rain"])

    @unittest.skipUnless(LIVE_AVAILABLE, "raw files not present")
    def test_live_versions_and_latest(self):
        reports = live_tables()["reports"]
        records = harmonize.load_all(config.RAW_DIR)
        latest = {}
        for r in reports:
            if r["is_latest"]:
                self.assertNotIn(r["report_id"], latest)
                latest[r["report_id"]] = r
        self.assertEqual(len({r["report_id"] for r in reports}), len(latest))
        real = {k: r for k, r in latest.items() if not r["is_placeholder"]}
        self.assertEqual({k: r["version"] for k, r in real.items()}, {r["id"]: r["ver"] for r in records})
        self.assertGreater(len(reports), len(records))  # superseded versions are kept
        self.assertEqual(len(reports), harmonize.LOAD_STATS["rows"])

    @unittest.skipUnless(LIVE_AVAILABLE, "raw files not present")
    def test_live_every_frozen_source_column_survives(self):
        reports = live_tables()["reports"]
        for spec in config.SGO_FILES:
            rows = [r for r in reports if r["source_file"] == spec["key"]]
            self.assertTrue(rows, spec["key"])
            expected = schema.EXPECTED_COLUMNS[spec["key"]]
            for r in rows:
                self.assertEqual(set(r["raw"]), set(expected), spec["key"])

    @unittest.skipUnless(LIVE_AVAILABLE, "raw files not present")
    def test_live_normalized_fields_match_load_all(self):
        reports = live_tables()["reports"]
        records = {r["id"]: r for r in harmonize.load_all(config.RAW_DIR)}
        renamed = {"id": "report_id", "ver": "version", "file": "kind"}
        for r in reports:
            if not r["is_latest"] or r["is_placeholder"]:
                continue
            rec = records[r["report_id"]]
            for field, value in rec.items():
                if field != "narrative":
                    self.assertEqual(r[renamed.get(field, field)], value, (rec["id"], field))


# ------------------------------------------------------------------- statuses
class StatusTests(unittest.TestCase):
    def setUp(self):
        schema.UNMAPPED.clear()

    def status(self, filename, report_id, field, **changes):
        fields, status = normalize(filename, report_id, **changes)
        return status[field]

    def test_current_era_row_has_lighting_not_collected(self):
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "lighting"), "not_collected_in_era")
        self.assertIsNone(normalize("current_ADS.csv", "TR-1")[0]["lighting"])

    def test_archive_era_row_has_lighting_provided(self):
        self.assertEqual(self.status("archive_ADAS.csv", "T-100", "lighting"), "provided")

    def test_other_archive_only_fields_not_collected_in_current(self):
        for field in ("surface", "speed_limit", "ads_equipped", "mileage", "hardware_version",
                      "software_version", "law_enforcement_investigating", "property_damage"):
            self.assertEqual(self.status("current_ADS.csv", "TR-1", field), "not_collected_in_era", field)

    def test_current_only_fields_not_collected_in_archive(self):
        for field in ("engagement_status", "vin_decoded"):
            self.assertEqual(self.status("archive_ADAS.csv", "T-100", field), "not_collected_in_era", field)

    def test_cbi_redacted_narrative(self):
        fields, status = normalize("archive_ADAS.csv", "G-300")
        self.assertEqual(status["narrative"], "redacted_cbi")
        self.assertTrue(fields["narrative_redacted"])

    def test_blank_narrative_with_cbi_flag_is_redacted(self):
        self.assertEqual(self.status("current_ADS.csv", "CR-1", "narrative"), "redacted_cbi")

    def test_blank_narrative_without_flag_is_reported_unknown(self):
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "narrative", Narrative=""), "reported_unknown")

    def test_readable_narrative_is_provided_even_with_some_redaction(self):
        text = ("The AV stopped at the light on the main road with its brake lights on and the hazard lights flashing, "
                "waiting for the traffic ahead to clear the junction. At " + schema.REDACTION_MARKER +
                " another vehicle approached from behind at speed and struck the AV, pushing it forward a short distance.")
        fields, status = normalize("current_ADS.csv", "TR-1", Narrative=text, **{"Narrative - CBI?": "Y"})
        self.assertEqual(status["narrative"], "provided")
        self.assertTrue(fields["narrative_partially_redacted"])

    def test_within_odd_marker_is_redacted_cbi(self):
        self.assertEqual(self.status("current_ADS.csv", "CR-1", "within_odd"), "redacted_cbi")

    def test_within_odd_cbi_flag_is_redacted_cbi(self):
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "within_odd", **{"Within ODD? - CBI": "Y"}), "redacted_cbi")

    def test_version_cbi_marker_is_redacted(self):
        fields, status = normalize("current_ADS.csv", "CR-1")
        self.assertEqual(status["system_version"], "redacted_cbi")
        self.assertIsNone(fields["system_version"])
        self.assertEqual(self.status("archive_ADAS.csv", "T-200", "system_version"), "redacted_cbi")

    def test_version_provided_when_given(self):
        fields, status = normalize("current_ADS.csv", "TR-1")
        self.assertEqual((fields["system_version"], status["system_version"]), ("v5.1", "provided"))

    def test_reported_unknown_crash_with(self):
        fields, status = normalize("current_ADS.csv", "TR-1", **{"Crash With": "Unknown"})
        self.assertEqual(fields["crash_with"], "unknown")
        self.assertEqual(status["crash_with"], "reported_unknown")

    def test_normal_crash_with_is_provided(self):
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "crash_with"), "provided")

    def test_blank_value_is_reported_unknown_not_provided(self):
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "state", State=""), "reported_unknown")
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "speed_mph", **{"SV Precrash Speed (MPH)": ""}), "reported_unknown")

    def test_zero_is_a_provided_value(self):
        fields, status = normalize("current_ADS.csv", "TR-1", **{"SV Precrash Speed (MPH)": "0"})
        self.assertEqual((fields["speed_mph"], status["speed_mph"]), (0, "provided"))

    def test_unknown_flag_column_wins(self):
        self.assertEqual(self.status("archive_ADAS.csv", "T-100", "model_year", **{"Model Year - Unknown": "Y", "Model Year": ""}),
                         "reported_unknown")

    def test_unknown_month_placeholder_is_reported_unknown(self):
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "month", **{"Incident Date": "JAN-1900"}), "reported_unknown")

    def test_weather_unknown_is_reported_unknown(self):
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "weather", **{"Weather - Clear": "", "Weather - Unk - See Narrative": "Y"}),
                         "reported_unknown")
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "weather"), "provided")

    def test_cp_fields_not_applicable_without_crash_partner(self):
        changes = {"Crash With": "Other Fixed Object", "CP Pre-Crash Movement": ""}
        fields, status = normalize("current_ADS.csv", "TR-1", **changes)
        self.assertEqual(status["cp_movement"], "not_applicable")
        self.assertEqual(status["cp_contact_areas"], "not_applicable")
        self.assertEqual(fields["cp_contact_areas"], [])

    def test_cp_movement_unknown_with_a_vehicle_partner(self):
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "cp_movement", **{"CP Pre-Crash Movement": "Unknown"}), "reported_unknown")
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "cp_movement", **{"CP Pre-Crash Movement": ""}), "reported_unknown")

    def test_airbag_not_applicable_label(self):
        fields, status = normalize("current_ADS.csv", "TR-1", **{"Any Air Bags Deployed?": "Not Applicable"})
        self.assertIsNone(fields["airbag"])
        self.assertEqual(status["airbag"], "not_applicable")

    def test_airbag_unknown_label(self):
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "airbag", **{"Any Air Bags Deployed?": "Unknown"}), "reported_unknown")

    def test_airbag_archive_per_vehicle(self):
        self.assertEqual(self.status("archive_ADAS.csv", "T-100", "airbag"), "provided")  # SV No, CP No
        self.assertEqual(self.status("archive_ADAS.csv", "T-100", "towed"), "reported_unknown")  # SV No, CP Unknown
        self.assertEqual(self.status("archive_ADAS.csv", "T-100", "airbag", **{"SV Any Air Bags Deployed?": "Unknown", "CP Any Air Bags Deployed?": "Unknown"}),
                         "reported_unknown")

    def test_agency_n_a_is_not_applicable(self):
        fields, status = normalize("archive_ADAS.csv", "T-100", **{"Investigating Agency": "N/A"})
        self.assertIsNone(fields["investigating_agency"])
        self.assertEqual(status["investigating_agency"], "not_applicable")
        fields, status = normalize("archive_ADAS.csv", "T-100", **{"Investigating Agency": "Austin Police Department"})
        self.assertEqual((fields["investigating_agency"], status["investigating_agency"]), ("Austin Police Department", "provided"))
        self.assertEqual(self.status("archive_ADAS.csv", "T-100", "investigating_agency"), "reported_unknown")

    def test_operating_entity_not_applicable_for_consumer_vehicles(self):
        self.assertEqual(
            self.status("archive_ADAS.csv", "T-100", "operating_entity", **{"Driver / Operator Type": "Consumer"}),
            "not_applicable")
        self.assertEqual(
            self.status("archive_ADAS.csv", "T-100", "operating_entity", **{"Driver / Operator Type": "Remote (Commercial / Test)"}),
            "reported_unknown")
        self.assertEqual(
            self.status("archive_ADAS.csv", "T-100", "operating_entity", **{"Operating Entity": "Waymo LLC"}), "provided")

    def test_hospitalized_statuses(self):
        # current era spells hospitalization out
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "hospitalized"), "provided")
        self.assertEqual(self.status("current_ADS.csv", "TR-1", "hospitalized", **{"Highest Injury Severity Alleged": "Fatality"}),
                         "not_applicable")
        self.assertEqual(self.status("current_ADS.csv", "CR-1", "hospitalized"), "reported_unknown")  # severity Unknown
        # archive era does not
        self.assertEqual(self.status("archive_ADAS.csv", "T-100", "hospitalized"), "not_collected_in_era")  # Minor
        self.assertEqual(self.status("archive_ADAS.csv", "T-200", "hospitalized"), "provided")  # No Injuries Reported -> False

    def test_placeholder_row_fields_are_not_applicable(self):
        fields, status = normalize("archive_ADAS.csv", "P-1")
        self.assertTrue(fields["is_placeholder"])
        self.assertEqual(set(status.values()), {"not_applicable"})
        self.assertIsNone(fields["speed_mph"])

    def test_every_status_value_is_legal_and_every_field_has_one(self):
        for filename, rid in (("archive_ADAS.csv", "T-100"), ("current_ADS.csv", "TR-1"), ("current_OTHER.csv", "O-1"),
                              ("archive_ADAS.csv", "P-1")):
            fields, status = normalize(filename, rid)
            self.assertEqual(set(status), set(golden.STATUS_FIELDS))
            self.assertTrue(set(status.values()) <= set(golden.STATUSES), status)
            for field in golden.STATUS_FIELDS:
                if field != "narrative":  # its text lives in raw["Narrative"]
                    self.assertIn(field, fields)

    def test_status_vocabulary(self):
        self.assertEqual(set(golden.STATUSES),
                         {"provided", "reported_unknown", "redacted_cbi", "not_collected_in_era", "not_applicable"})
        self.assertEqual(set(golden.UNAVAILABLE_REASONS), set(golden.STATUSES) - {"provided"})

    def test_rule_table_columns_exist_in_the_frozen_column_sets(self):
        for field, rule in golden.STATUS_RULES.items():
            for era, cols in rule.get("cols", {}).items():
                if cols is None:
                    continue
                cols = [cols] if isinstance(cols, str) else cols
                for col in cols:
                    self.assertIn(col, schema.EXPECTED_COLUMNS[era + "_ADS"], (field, era, col))
            for key in ("cbi_flag", "unknown_flag"):
                for era, col in rule.get(key, {}).items():
                    if col is not None:
                        self.assertIn(col, schema.EXPECTED_COLUMNS[era + "_ADS"], (field, key, era, col))

    def test_rule_table_covers_every_status_field(self):
        self.assertEqual(set(golden.STATUS_RULES), set(golden.STATUS_FIELDS))

    def test_rule_table_era_gaps_match_harmonize(self):
        """A field harmonize maps to no column in an era is not_collected_in_era there."""
        for field in ("surface", "lighting", "speed_limit"):
            self.assertIsNone(golden.STATUS_RULES[field]["cols"]["current"])
            self.assertIsNone(schema.COLUMNS["current"][field])
            self.assertIsNotNone(golden.STATUS_RULES[field]["cols"]["archive"])


# -------------------------------------------------------------- list fields
class ListFieldTests(unittest.TestCase):
    def setUp(self):
        schema.UNMAPPED.clear()

    def test_contact_areas_parsed_from_flag_columns(self):
        fields, status = normalize(
            "current_ADS.csv", "TR-1",
            **{"SV Contact Area - Rear": "Y", "SV Contact Area - Rear Left": "Y",
               "CP Contact Area - Front": "Y"})
        self.assertEqual(fields["sv_contact_areas"], ["rear", "rear_left"])
        self.assertEqual(fields["cp_contact_areas"], ["front"])
        self.assertEqual(status["sv_contact_areas"], "provided")
        self.assertEqual(status["cp_contact_areas"], "provided")

    def test_contact_area_all_columns_map(self):
        row = fixture_row("archive_ADAS.csv", "T-100")
        for suffix in schema.CONTACT_AREA_SUFFIXES:
            row["SV Contact Area - " + suffix] = "Y"
        fields, _ = golden.normalize_row(row, "archive", "ADAS")
        self.assertEqual(set(fields["sv_contact_areas"]), set(schema.CONTACT_AREA_SUFFIXES.values()))

    def test_contact_area_unknown_flag_is_reported_unknown(self):
        fields, status = normalize("current_ADS.csv", "TR-1", **{"SV Contact Area - Unknown": "Y"})
        self.assertEqual(fields["sv_contact_areas"], ["unknown"])
        self.assertEqual(status["sv_contact_areas"], "reported_unknown")

    def test_contact_area_with_no_flag_is_reported_unknown(self):
        fields, status = normalize("current_ADS.csv", "TR-1")
        self.assertEqual(fields["sv_contact_areas"], [])
        self.assertEqual(status["sv_contact_areas"], "reported_unknown")

    def test_data_availability_and_report_sources(self):
        fields, status = normalize(
            "current_ADS.csv", "TR-1",
            **{"Data Availability - EDR": "Y", "Data Availability - Police Rpt": "Y", "Data Availability - Video": "Y",
               "Source - Telematics": "Y", "Source - NHTSA VOQ": "Y", "Source - Other - See Narrative": "Y"})
        self.assertEqual(fields["data_availability"], ["edr", "police_report", "video"])
        self.assertEqual(set(fields["report_sources"]), {"telematics", "nhtsa_voq", "other"})
        self.assertEqual(status["data_availability"], "provided")
        self.assertEqual(status["report_sources"], "provided")

    def test_data_availability_no_data_and_unknown(self):
        fields, status = normalize("current_ADS.csv", "TR-1", **{"Data Availability - No Data": "Y"})
        self.assertEqual((fields["data_availability"], status["data_availability"]), (["none"], "provided"))
        fields, status = normalize("current_ADS.csv", "TR-1", **{"Data Availability - Unknown": "Y"})
        self.assertEqual((fields["data_availability"], status["data_availability"]), (["unknown"], "reported_unknown"))

    def test_report_sources_differ_by_era(self):
        fields, _ = normalize("archive_ADAS.csv", "T-100", **{"Source - Media": "Y", "Source - Testing": "Y"})
        self.assertEqual(set(fields["report_sources"]), {"media", "testing"})

    def test_roadway_conditions_both_eras(self):
        fields, status = normalize("archive_ADAS.csv", "T-100", **{"Roadway Description": "Work Zone"})
        self.assertEqual((fields["roadway_conditions"], status["roadway_conditions"]), (["work_zone"], "provided"))
        fields, status = normalize("current_ADS.csv", "TR-1", **{"Roadway-Work Zone": "Y", "Roadway-Wet Surface Condition": "Y"})
        self.assertEqual(set(fields["roadway_conditions"]), {"work_zone", "wet_surface"})
        self.assertEqual(status["roadway_conditions"], "provided")

    def test_scalar_categoricals(self):
        fields, _ = normalize(
            "current_ADS.csv", "TR-1",
            **{"Driver / Operator Type": "In-Vehicle and Remote (Commercial / Test)", "Engagement Status": "Verified Engaged",
               "Were All Passengers Belted?": "Subject Vehicle - All Belted", "VIN Decoded": "Y",
               "Incident Time (24:00)": "9:05", "Incident Time - Unknown": "", "Operating Entity": "Waymo LLC"})
        self.assertEqual(fields["driver_operator_type"], "in_vehicle_and_remote")
        self.assertEqual(fields["engagement_status"], "verified_engaged")
        self.assertEqual(fields["belted"], "all_belted")
        self.assertIs(fields["vin_decoded"], True)
        self.assertEqual(fields["incident_time"], "09:05")
        self.assertIs(fields["incident_time_unknown"], False)
        self.assertEqual(fields["operating_entity"], "Waymo LLC")
        self.assertEqual(fields["automation_engaged"], "ads")
        self.assertEqual(fields["incident_date_raw"], "SEP-2026")

    def test_archive_only_scalars(self):
        fields, status = normalize(
            "archive_ADAS.csv", "T-100",
            **{"ADS Equipped?": "No", "Mileage": "1589", "Law Enforcement Investigating?": "Yes", "Property Damage?": "Unknown",
               "SV Were All Passengers Belted?": "No, see Narrative"})
        self.assertEqual(fields["ads_equipped"], "no")
        self.assertEqual(fields["mileage"], 1589)
        self.assertEqual(fields["law_enforcement_investigating"], "yes")
        self.assertEqual(fields["property_damage"], "unknown")
        self.assertEqual(status["property_damage"], "reported_unknown")
        self.assertEqual(fields["belted"], "not_all_belted")

    def test_unmapped_labels_are_recorded_not_hidden(self):
        fields, status = normalize("current_ADS.csv", "TR-1", **{"Driver / Operator Type": "Robot Chauffeur"})
        self.assertIsNone(fields["driver_operator_type"])
        self.assertIn(("driver_operator_type", "Robot Chauffeur"), schema.UNMAPPED)
        self.assertEqual(status["driver_operator_type"], "reported_unknown")

    def test_derived_fields_present(self):
        fields, _ = normalize("current_ADS.csv", "TR-1")
        self.assertEqual(fields["speed_band"], "6-15")
        self.assertIsInstance(fields["tags"], list)
        self.assertEqual(fields["tags"][0].keys(), {"t", "basis", "rule"})  # intersection INT-1
        self.assertEqual(fields["unknown_fields"], harmonize.harmonize_row(fixture_row("current_ADS.csv", "TR-1"), "current", "ADS")["unknown_fields"])


# ------------------------------------------------------------------ incidents
class IncidentTests(FixtureCase):
    def test_incident_grouping_and_max_severity(self):
        tables = self.build()
        inc = by_key(tables["incidents"], "incident_key")
        shared = inc["SHAREDINCIDENT1"]
        self.assertEqual(shared["report_count"], 2)
        self.assertEqual(shared["report_ids"], ["G-300", "T-400"])
        self.assertEqual(shared["max_severity"], "fatal")
        self.assertEqual(shared["companies"], ["gm", "tesla"])
        self.assertEqual(shared["programs"], ["gm_supercruise", "tesla_l2"])
        self.assertEqual(shared["latest_report_keys"], ["G-300|v1", "T-400|v1"])
        self.assertEqual(shared["representative_report_key"], "G-300|v1")
        self.assertEqual(shared["month"], harmonize.parse_month(fixture_row("archive_ADAS.csv", "G-300")["Incident Date"]))

    def test_member_keys_include_every_version(self):
        inc = by_key(self.build()["incidents"], "incident_key")
        self.assertEqual(inc["solo:T-100"]["report_keys"], ["T-100|v1", "T-100|v2"])
        self.assertEqual(inc["solo:T-100"]["latest_report_keys"], ["T-100|v2"])
        self.assertEqual(inc["solo:T-100"]["report_count"], 1)

    def test_placeholders_are_not_incidents(self):
        inc = by_key(self.build()["incidents"], "incident_key")
        self.assertNotIn("solo:P-1", inc)

    def test_incident_count_matches_unique_crashes(self):
        tables = self.build()
        records = harmonize.load_all(FIXTURES, allow_missing=True)
        self.assertEqual(len(tables["incidents"]), len(record_crashes(records)))

    def test_aggregate_uses_the_golden_severity_rank(self):
        self.assertIs(aggregate._RANK, golden.SEVERITY_RANK)

    @unittest.skipUnless(LIVE_AVAILABLE, "raw files not present")
    def test_live_incident_count_matches_unique_crashes(self):
        tables = live_tables()
        records = harmonize.load_all(config.RAW_DIR)
        crashes = {c[0]["id"]: c for c in record_crashes(records)}
        self.assertEqual(len(tables["incidents"]), len(crashes))
        reps = {i["representative_report_key"].split("|")[0]: i for i in tables["incidents"]}
        self.assertEqual(set(reps), set(crashes))
        for rid, (rec, n) in crashes.items():
            self.assertEqual(reps[rid]["report_count"], n)
            self.assertEqual(reps[rid]["max_severity"], rec["severity"])


# ------------------------------------------------------------------ run table
class RunTableTests(FixtureCase):
    def test_run_row(self):
        tables = self.build(run_id="20261126T000000Z", fetch_log=FETCH_LOG)
        self.assertEqual(len(tables["runs"]), 1)
        run = tables["runs"][0]
        self.assertEqual(run["run_id"], "20261126T000000Z")
        self.assertEqual(run["nhtsa_last_modified"]["current_ADS"], "2026-11-16T13:31:10Z")
        self.assertEqual(run["file_sha256"], {"archive_ADAS": "aa", "current_ADS": "bb"})
        self.assertEqual(run["file_rows"], {"archive_ADAS": 6, "current_ADS": 5, "current_OTHER": 3})
        self.assertEqual(run["placeholder_rows_skipped"], 1)
        self.assertEqual(run["counts"]["reports"], 14)
        self.assertEqual(run["counts"]["latest_reports"], 12)  # 13 Report IDs, one is a placeholder
        self.assertEqual(run["counts"]["incidents"], len(tables["incidents"]))
        self.assertEqual(run["counts"]["new_rows"], 14)
        self.assertEqual(run["counts"]["removed_rows"], 0)
        self.assertEqual(run["unmapped"], sorted("%s=%s" % pair for pair in schema.UNMAPPED))

    def test_unmapped_labels_listed(self):
        edit_csv(self.raw / "current_ADS.csv", lambda rows: rows[0].update({"Roadway Type": "Moon Base"}))
        run = self.build()["runs"][0]
        self.assertIn("roadway_type=Moon Base", run["unmapped"])

    def test_runs_accumulate_and_same_run_id_replaces(self):
        first = self.build("R1")
        second = self.build("R2", previous=first)
        self.assertEqual([r["run_id"] for r in second["runs"]], ["R1", "R2"])
        again = self.build("R2", previous=second)
        self.assertEqual([r["run_id"] for r in again["runs"]], ["R1", "R2"])
        self.assertEqual(again["runs"], second["runs"])

    def test_labels_table_is_empty_with_documented_columns(self):
        tables = self.build()
        self.assertEqual(tables["labels"], [])
        self.assertEqual(golden.LABEL_COLUMNS, (
            "report_key", "label_set", "label", "rationale", "evidence_fields", "model", "prompt_version", "run_at"))

    def test_labels_pass_through_untouched(self):
        labels = [{"report_key": "T-100|v2", "label_set": "x", "label": "y", "rationale": "", "evidence_fields": ["a"],
                   "model": "m", "prompt_version": "1", "run_at": "t"}]
        tables = self.build(previous={"labels": labels})
        self.assertEqual(tables["labels"], labels)

    def test_manual_tables_copied_unchanged(self):
        data = manual.load()
        tables = self.build(manual_data=data)
        for name in manual.FILES:
            self.assertEqual(tables[name], data[name])
            self.assertEqual(len(tables[name]), len(data[name]))
        self.assertIn("region", tables["exposure"][0])
        self.assertTrue(any(r["metric"] == "recall_units" for r in tables["exposure"]))
        self.assertIn("date_precision", tables["events"][0])


# ------------------------------------------------------------ carry-over runs
class CarryOverTests(FixtureCase):
    def write_and_read(self, tables, name):
        directory = Path(self.tmp.name) / name
        build_db.write_jsonl(tables, directory)
        return directory

    def snapshot(self, directory):
        return {p.name: p.read_bytes() for p in sorted(directory.glob("*.jsonl"))}

    def test_same_run_id_rebuild_is_byte_identical(self):
        d1 = self.write_and_read(self.build("R1"), "g1")
        previous = build_db.read_previous(d1)
        d2 = self.write_and_read(self.build("R1", previous=previous), "g2")
        self.assertEqual(self.snapshot(d1), self.snapshot(d2))
        # and building from scratch twice is identical too
        d3 = self.write_and_read(self.build("R1"), "g3")
        self.assertEqual(self.snapshot(d1), self.snapshot(d3))

    def test_jsonl_format(self):
        d1 = self.write_and_read(self.build("R1"), "g1")
        data = (d1 / "reports.jsonl").read_bytes()
        self.assertNotIn(b"\r", data)
        self.assertTrue(data.endswith(b"\n"))
        keys = []
        for line in data.decode("utf-8").splitlines():
            row = json.loads(line)
            keys.append(row["report_key"])
            self.assertEqual(line, json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":")))
        self.assertEqual(keys, sorted(keys))
        self.assertEqual(len(keys), 14)

    def test_new_run_id_with_unchanged_inputs_leaves_reports_untouched(self):
        first = self.build("R1")
        second = self.build("R2", previous=first)
        self.assertEqual(second["reports"], first["reports"])
        self.assertEqual(second["incidents"], first["incidents"])
        for row in second["reports"]:
            self.assertEqual(row["first_seen_run"], "R1")
            self.assertNotIn("last_seen_run", row)
        self.assertEqual([r["run_id"] for r in second["runs"]], ["R1", "R2"])
        self.assertEqual(second["runs"][1]["counts"]["new_rows"], 0)

    def test_new_run_id_changes_only_runs_jsonl_on_disk(self):
        d1 = Path(self.tmp.name) / "g1"
        build_db.write_jsonl(self.build("R1"), d1)
        before = self.snapshot(d1)
        build_db.write_jsonl(self.build("R2", previous=build_db.read_previous(d1)), d1)
        after = self.snapshot(d1)
        self.assertEqual({n for n in before if before[n] != after[n]}, {"runs.jsonl"})
        self.assertEqual(len(after["runs.jsonl"].splitlines()), 2)

    def test_old_jsonl_with_last_seen_run_is_upgraded(self):
        first = self.build("R1")
        legacy = copy.deepcopy(first)
        for row in legacy["reports"]:
            row["last_seen_run"] = "R1"
        edit_csv(self.raw / "archive_ADAS.csv", lambda rows: drop_rows(rows, lambda r: r["Report ID"] != "G-300"))
        second = self.build("R2", previous=legacy)
        for row in second["reports"]:
            self.assertNotIn("last_seen_run", row)
        self.assertEqual(by_key(second["reports"])["G-300|v1"]["removed_in_run"], "R2")

    def test_modified_row_gets_new_hash_and_first_seen(self):
        first = self.build("R1")
        edit_csv(self.raw / "archive_ADAS.csv",
                 lambda rows: [r.update({"Narrative": "Edited narrative."}) for r in rows if r["Report ID"] == "T-200"])
        second = self.build("R2", previous=first)
        a, b = by_key(first["reports"]), by_key(second["reports"])
        old, new = a["T-200|v1"], b["T-200|v1"]
        self.assertNotEqual(old["row_hash"], new["row_hash"])
        self.assertEqual(new["first_seen_run"], "R2")
        self.assertEqual(new["previous_row_hash"], old["row_hash"])
        self.assertEqual(new["raw"]["Narrative"], "Edited narrative.")
        # a row that did not change keeps its history
        self.assertEqual(b["T-100|v1"], a["T-100|v1"])
        self.assertIsNone(b["T-100|v1"]["previous_row_hash"])
        self.assertEqual(second["runs"][1]["counts"]["changed_rows"], 1)

    def test_changed_hash_survives_an_unchanged_rerun(self):
        first = self.build("R1")
        edit_csv(self.raw / "archive_ADAS.csv",
                 lambda rows: [r.update({"Narrative": "Edited narrative."}) for r in rows if r["Report ID"] == "T-200"])
        second = self.build("R2", previous=first)
        third = self.build("R3", previous=second)
        row = by_key(third["reports"])["T-200|v1"]
        self.assertEqual(row["first_seen_run"], "R2")
        self.assertEqual(row["previous_row_hash"], by_key(first["reports"])["T-200|v1"]["row_hash"])

    def test_new_version_is_a_new_report_key(self):
        first = self.build("R1")

        def add_version(rows):
            v2 = dict(next(r for r in rows if r["Report ID"] == "T-200"))
            v2["Report Version"] = "2"
            rows.append(v2)

        edit_csv(self.raw / "archive_ADAS.csv", add_version)
        second = self.build("R2", previous=first)
        b = by_key(second["reports"])
        self.assertEqual(b["T-200|v2"]["first_seen_run"], "R2")
        self.assertTrue(b["T-200|v2"]["is_latest"])
        self.assertFalse(b["T-200|v1"]["is_latest"])
        self.assertEqual(b["T-200|v1"]["first_seen_run"], "R1")

    def test_vanished_row_is_marked_removed_not_deleted(self):
        first = self.build("R1")
        edit_csv(self.raw / "archive_ADAS.csv", lambda rows: drop_rows(rows, lambda r: r["Report ID"] != "G-300"))
        second = self.build("R2", previous=first)
        b = by_key(second["reports"])
        gone = b["G-300|v1"]
        self.assertEqual(gone["removed_in_run"], "R2")
        self.assertEqual(gone["first_seen_run"], "R1")
        self.assertFalse(gone["is_latest"])
        self.assertEqual(gone["raw"], by_key(first["reports"])["G-300|v1"]["raw"])
        self.assertIsNone(b["T-400|v1"]["removed_in_run"])
        self.assertNotIn("G-300", [i for inc in second["incidents"] for i in inc["report_ids"]])
        self.assertEqual(second["runs"][1]["counts"]["removed_rows"], 1)
        # stays removed (with the first removal run) on a later run
        third = self.build("R3", previous=second)
        self.assertEqual(by_key(third["reports"])["G-300|v1"]["removed_in_run"], "R2")

    def test_reappearing_row_clears_removed(self):
        first = self.build("R1")
        original = (self.raw / "archive_ADAS.csv").read_bytes()
        edit_csv(self.raw / "archive_ADAS.csv", lambda rows: drop_rows(rows, lambda r: r["Report ID"] != "G-300"))
        second = self.build("R2", previous=first)
        (self.raw / "archive_ADAS.csv").write_bytes(original)
        third = self.build("R3", previous=second)
        row = by_key(third["reports"])["G-300|v1"]
        self.assertIsNone(row["removed_in_run"])
        self.assertEqual(row["first_seen_run"], "R1")
        self.assertTrue(row["is_latest"])

    def test_exactly_one_latest_per_id_among_active_rows(self):
        first = self.build("R1")
        edit_csv(self.raw / "archive_ADAS.csv", lambda rows: drop_rows(rows, lambda r: r["Report ID"] != "T-100" or r["Report Version"] == "1"))
        second = self.build("R2", previous=first)
        active = [r for r in second["reports"] if r["removed_in_run"] is None]
        ids = [r["report_id"] for r in active if r["is_latest"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(by_key(second["reports"])["T-100|v1"]["is_latest"], True)
        self.assertEqual(by_key(second["reports"])["T-100|v2"]["removed_in_run"], "R2")

    def test_newest_version_vanished_older_one_becomes_latest(self):
        first = self.build("R1")
        edit_csv(self.raw / "archive_ADAS.csv",
                 lambda rows: drop_rows(rows, lambda r: not (r["Report ID"] == "T-100" and r["Report Version"] == "2")))
        second = self.build("R2", previous=first)
        rows = by_key(second["reports"])
        self.assertTrue(rows["T-100|v1"]["is_latest"])
        self.assertIsNone(rows["T-100|v1"]["removed_in_run"])
        self.assertFalse(rows["T-100|v2"]["is_latest"])
        self.assertEqual(rows["T-100|v2"]["removed_in_run"], "R2")
        latest = [r["report_key"] for r in second["reports"] if r["report_id"] == "T-100" and r["is_latest"] and r["removed_in_run"] is None]
        self.assertEqual(latest, ["T-100|v1"])
        incident = by_key(second["incidents"], "incident_key")["solo:T-100"]
        self.assertEqual(incident["latest_report_keys"], ["T-100|v1"])
        self.assertEqual(incident["report_keys"], ["T-100|v1"])

    def test_all_versions_vanished_leaves_no_latest_and_no_incident(self):
        first = self.build("R1")
        edit_csv(self.raw / "archive_ADAS.csv", lambda rows: drop_rows(rows, lambda r: r["Report ID"] != "T-100"))
        second = self.build("R2", previous=first)
        rows = [r for r in second["reports"] if r["report_id"] == "T-100"]
        self.assertEqual(len(rows), 2)
        for r in rows:
            self.assertEqual(r["removed_in_run"], "R2")
            self.assertFalse(r["is_latest"])
        self.assertNotIn("solo:T-100", by_key(second["incidents"], "incident_key"))
        # every other ID still has exactly one latest among its non-removed rows
        latest = [r["report_id"] for r in second["reports"] if r["removed_in_run"] is None and r["is_latest"]]
        active_ids = {r["report_id"] for r in second["reports"] if r["removed_in_run"] is None}
        self.assertEqual(sorted(latest), sorted(active_ids))

    def test_jsonl_write_is_atomic(self):
        directory = Path(self.tmp.name) / "atomic"
        tables = self.build("R1")
        build_db.write_jsonl(tables, directory)
        before = self.snapshot(directory)
        broken = dict(tables, cadence=[{"company": "x", "program": "y", "metric": "z", "bad": object()}])
        with self.assertRaises(TypeError):
            build_db.write_jsonl(broken, directory)
        self.assertEqual(self.snapshot(directory), before)
        self.assertEqual([p.name for p in directory.iterdir() if p.name.startswith(".")], [])
        # a failing rename leaves no temp files behind either
        real_replace = build_db.os.replace
        calls = []

        def flaky(src, dst):
            calls.append(dst)
            if len(calls) == 3:
                raise OSError("disk full")
            real_replace(src, dst)

        build_db.os.replace = flaky
        try:
            with self.assertRaises(OSError):
                build_db.write_jsonl(tables, directory)
        finally:
            build_db.os.replace = real_replace
        self.assertEqual([p.name for p in directory.iterdir() if p.name.startswith(".")], [])

    def test_labels_preserved_across_rebuilds_on_disk(self):
        golden_dir = self.golden_dir
        build_db.run(self.raw, golden_dir, EMPTY_MANUAL, "R1", None, allow_missing=True, sqlite_path=None)
        self.assertEqual((golden_dir / "labels.jsonl").read_bytes(), b"")
        label = {"report_key": "T-100|v2", "label_set": "avoidability_v1", "label": "struck_from_behind",
                 "rationale": "SV Contact Area - Rear only", "evidence_fields": ["sv_contact_areas"],
                 "model": "none", "prompt_version": "0", "run_at": "2026-12-01T00:00:00Z"}
        content = (json.dumps(label, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        (golden_dir / "labels.jsonl").write_bytes(content)
        build_db.run(self.raw, golden_dir, EMPTY_MANUAL, "R2", None, allow_missing=True, sqlite_path=None)
        self.assertEqual((golden_dir / "labels.jsonl").read_bytes(), content)
        sqlite_path = Path(self.tmp.name) / "g.sqlite"
        build_db.run(self.raw, golden_dir, EMPTY_MANUAL, "R3", None, allow_missing=True, sqlite_path=sqlite_path)
        self.assertEqual((golden_dir / "labels.jsonl").read_bytes(), content)
        con = sqlite3.connect(sqlite_path)
        self.addCleanup(con.close)
        self.assertEqual(con.execute("SELECT report_key, label FROM labels").fetchall(), [("T-100|v2", "struck_from_behind")])

    def test_sharding_splits_reports_by_source_file(self):
        tables = self.build("R1")
        directory = Path(self.tmp.name) / "sharded"
        written = build_db.write_jsonl(tables, directory, shard_threshold=1)
        names = sorted(p.name for p in directory.glob("reports*.jsonl"))
        self.assertEqual(names, ["reports.archive_ADAS.jsonl", "reports.current_ADS.jsonl", "reports.current_OTHER.jsonl"])
        self.assertIn(directory / "reports.archive_ADAS.jsonl", [p for p, _ in written])
        previous = build_db.read_previous(directory)
        self.assertEqual(previous["reports"], tables["reports"])
        # switching layout removes the stale files
        build_db.write_jsonl(tables, directory)
        self.assertEqual([p.name for p in directory.glob("reports*.jsonl")], ["reports.jsonl"])
        self.assertEqual(build_db.read_previous(directory)["reports"], tables["reports"])


# ---------------------------------------------------------------------- sqlite
class SqliteTests(FixtureCase):
    def make(self):
        tables = self.build("R1", manual_data=manual.load())
        path = Path(self.tmp.name) / "golden.sqlite"
        build_db.write_sqlite(tables, path)
        con = sqlite3.connect(path)
        self.addCleanup(con.close)
        return tables, con

    def test_row_counts_match_tables(self):
        tables, con = self.make()
        for name, rows in tables.items():
            self.assertEqual(con.execute("SELECT COUNT(*) FROM %s" % name).fetchone()[0], len(rows), name)

    def test_row_counts_match_jsonl(self):
        tables = self.build("R1", manual_data=manual.load())
        directory = Path(self.tmp.name) / "g"
        build_db.write_jsonl(tables, directory)
        path = Path(self.tmp.name) / "golden.sqlite"
        build_db.write_sqlite(build_db.read_previous(directory), path)
        con = sqlite3.connect(path)
        self.addCleanup(con.close)
        for name in tables:
            with open(directory / (name + ".jsonl"), encoding="utf-8") as f:
                lines = sum(1 for _ in f)
            self.assertEqual(con.execute("SELECT COUNT(*) FROM %s" % name).fetchone()[0], lines, name)

    def test_query_by_program_and_month(self):
        tables, con = self.make()
        expected = sorted(r["report_key"] for r in tables["reports"]
                          if r["program"] == "tesla_l2" and r["month"] == "2024-02" and r["is_latest"])
        got = [k for (k,) in con.execute(
            "SELECT report_key FROM reports WHERE program = ? AND month = ? AND is_latest = 1 ORDER BY report_key",
            ("tesla_l2", "2024-02"))]
        self.assertEqual(got, expected)
        self.assertEqual(expected, ["T-100|v2"])

    def test_json_columns_and_status_queries(self):
        tables, con = self.make()
        status, raw, areas = con.execute(
            "SELECT status, raw, sv_contact_areas FROM reports WHERE report_key = 'TR-1|v1'").fetchone()
        self.assertEqual(json.loads(status)["lighting"], "not_collected_in_era")
        self.assertEqual(json.loads(raw)["Crash With"], "SUV")
        self.assertEqual(json.loads(areas), [])
        n = con.execute("SELECT COUNT(*) FROM reports WHERE json_extract(status, '$.lighting') = 'not_collected_in_era'").fetchone()[0]
        self.assertEqual(n, sum(1 for r in tables["reports"] if r["status"]["lighting"] == "not_collected_in_era"))

    def test_indexes_and_view(self):
        _, con = self.make()
        names = {row[1] for row in con.execute("PRAGMA index_list(reports)")}
        for column in ("program", "month", "severity", "company", "incident_key"):
            self.assertIn("idx_reports_" + column, names)
        self.assertEqual(con.execute("SELECT COUNT(*) FROM latest_reports").fetchone()[0],
                         con.execute("SELECT COUNT(*) FROM reports WHERE is_latest = 1 AND removed_in_run IS NULL AND is_placeholder = 0").fetchone()[0])

    def test_last_seen_run_is_derived_from_runs(self):
        first = self.build("R1")
        edit_csv(self.raw / "archive_ADAS.csv", lambda rows: drop_rows(rows, lambda r: r["Report ID"] != "G-300"))
        second = self.build("R2", previous=first)
        third = self.build("R3", previous=second)
        path = Path(self.tmp.name) / "seen.sqlite"
        build_db.write_sqlite(third, path)
        con = sqlite3.connect(path)
        self.addCleanup(con.close)
        seen = dict(con.execute("SELECT report_key, last_seen_run FROM reports"))
        self.assertEqual(seen["T-100|v2"], "R3")  # kept: the latest run saw it
        self.assertEqual(seen["G-300|v1"], "R1")  # removed in R2: last seen by the run before
        self.assertEqual(seen, golden_last_seen(third))
        self.assertEqual(
            dict(con.execute("SELECT report_key, first_seen_run FROM reports WHERE report_key IN ('G-300|v1', 'T-100|v2')")),
            {"G-300|v1": "R1", "T-100|v2": "R1"})
        # a row removed in the first run it could have been seen in has no last_seen_run
        self.assertEqual(build_db.last_seen_runs([{"report_key": "k", "removed_in_run": "R1"}], ["R1"]), {"k": None})

    def test_rules_version_in_runs(self):
        tables, con = self.make()
        self.assertEqual(tables["runs"][0]["rules_version"], golden.RULES_VERSION)
        self.assertEqual(con.execute("SELECT rules_version FROM runs").fetchone()[0], golden.RULES_VERSION)
        self.assertIsInstance(golden.RULES_VERSION, str)

    def test_manual_tables_keep_region_recall_units_and_date_precision(self):
        _, con = self.make()
        self.assertGreater(con.execute("SELECT COUNT(*) FROM exposure WHERE metric = 'recall_units'").fetchone()[0], 0)
        self.assertGreater(con.execute("SELECT COUNT(DISTINCT region) FROM exposure").fetchone()[0], 0)
        self.assertGreater(con.execute("SELECT COUNT(DISTINCT date_precision) FROM events").fetchone()[0], 0)
        cols = [r[1] for r in con.execute("PRAGMA table_info(labels)")]
        self.assertEqual(tuple(cols), golden.LABEL_COLUMNS)

    def test_rebuilding_replaces_the_file(self):
        tables, con = self.make()
        path = Path(self.tmp.name) / "golden.sqlite"
        build_db.write_sqlite(tables, path)
        con2 = sqlite3.connect(path)
        self.addCleanup(con2.close)
        self.assertEqual(con2.execute("SELECT COUNT(*) FROM reports").fetchone()[0], len(tables["reports"]))


# ------------------------------------------------------------------------ live
@unittest.skipUnless(LIVE_AVAILABLE, "raw files not present")
class LiveBuildTests(unittest.TestCase):
    def test_file_row_counts_match_fetch_log(self):
        if not config.FETCH_LOG.exists():
            self.skipTest("no fetch log")
        log = {e["key"]: e for e in json.loads(config.FETCH_LOG.read_text(encoding="utf-8"))}
        reports = live_tables()["reports"]
        for key, entry in log.items():
            self.assertEqual(sum(1 for r in reports if r["source_file"] == key), entry["rows"], key)

    def test_every_status_field_has_a_legal_status(self):
        for r in live_tables()["reports"]:
            self.assertEqual(set(r["status"]), set(golden.STATUS_FIELDS))
            self.assertTrue(set(r["status"].values()) <= set(golden.STATUSES))

    def test_tesla_redaction_shows_up_as_redacted_cbi(self):
        rows = [r for r in live_tables()["reports"] if r["is_latest"] and r["program"] == "tesla_l2" and r["era"] == "current"]
        redacted = sum(1 for r in rows if r["status"]["narrative"] == "redacted_cbi")
        self.assertGreater(redacted / len(rows), 0.9)


if __name__ == "__main__":
    unittest.main()
