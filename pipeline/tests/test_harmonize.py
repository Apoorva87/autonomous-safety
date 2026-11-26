import csv
import unittest
from pathlib import Path

from pipeline import config, harmonize, schema

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def load_fixture_records():
    return harmonize.load_all(FIXTURES, allow_missing=True)


def by_id(records):
    return {r["id"]: r for r in records}


def fixture_row(filename, report_id):
    with open(FIXTURES / filename, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            if row["Report ID"] == report_id:
                return row
    raise KeyError(report_id)


class HarmonizeTests(unittest.TestCase):
    def setUp(self):
        schema.UNMAPPED.clear()
        self.records = load_fixture_records()
        self.by_id = by_id(self.records)

    def test_latest_version_wins(self):
        matches = [r for r in self.records if r["id"] == "T-100"]
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["ver"], 2)
        self.assertEqual(matches[0]["month"], "2024-02")
        self.assertEqual(matches[0]["narrative"], "Version two narrative.")

    def test_placeholder_rows_are_not_records(self):
        self.assertNotIn("P-1", self.by_id)

    def test_blank_incident_ids_not_merged(self):
        self.assertNotEqual(self.by_id["T-100"]["incident_key"], self.by_id["T-200"]["incident_key"])
        self.assertEqual(self.by_id["T-100"]["incident_key"], "solo:T-100")
        self.assertEqual(self.by_id["T-200"]["incident_key"], "solo:T-200")

    def test_shared_incident_grouped(self):
        self.assertEqual(self.by_id["G-300"]["incident_key"], "SHAREDINCIDENT1")
        self.assertEqual(self.by_id["T-400"]["incident_key"], "SHAREDINCIDENT1")

    def test_severity_mapping(self):
        minor = self.by_id["TR-1"]
        self.assertEqual(minor["severity"], "minor")
        self.assertIs(minor["hospitalized"], True)
        none = self.by_id["W-1"]
        self.assertEqual(none["severity"], "none")
        self.assertIs(none["hospitalized"], False)
        # Archive labels carry no hospitalization information: None, never imputed.
        archive_minor = self.by_id["T-100"]
        self.assertEqual(archive_minor["severity"], "minor")
        self.assertIsNone(archive_minor["hospitalized"])
        self.assertEqual(self.by_id["G-300"]["severity"], "fatal")
        self.assertEqual(self.by_id["T-400"]["severity"], "unknown")

    def test_state_trimmed(self):
        self.assertEqual(self.by_id["T-100"]["state"], "CA")

    def test_unmapped_label_recorded(self):
        row = fixture_row("current_ADS.csv", "W-1")
        row["Highest Injury Severity Alleged"] = "Catastrophic"
        schema.UNMAPPED.clear()
        record = harmonize.harmonize_row(row, "current", "ADS")
        self.assertIn(("severity", "Catastrophic"), schema.UNMAPPED)
        # No silent fallback to a real label.
        self.assertEqual(record["severity"], "unknown")

    def test_known_fixture_labels_do_not_land_in_unmapped(self):
        self.assertEqual(schema.UNMAPPED, set())

    def test_unmapped_other_categoricals(self):
        row = fixture_row("current_ADS.csv", "W-1")
        row["Roadway Type"] = "Hovercraft Pad"
        row["Weather - Clear"] = "Maybe"
        schema.UNMAPPED.clear()
        harmonize.harmonize_row(row, "current", "ADS")
        self.assertIn(("roadway_type", "Hovercraft Pad"), schema.UNMAPPED)
        self.assertIn(("Weather - Clear", "Maybe"), schema.UNMAPPED)

    def test_program_mapping(self):
        self.assertEqual(self.by_id["TR-1"]["program"], "tesla_robotaxi")
        self.assertEqual(self.by_id["TR-1"]["company"], "tesla")
        self.assertEqual(self.by_id["T-100"]["program"], "tesla_l2")
        self.assertEqual(self.by_id["G-300"]["program"], "gm_supercruise")
        self.assertEqual(self.by_id["G-300"]["company"], "gm")
        self.assertEqual(self.by_id["CR-1"]["program"], "gm_cruise_ads")
        self.assertEqual(self.by_id["GM-1"]["program"], "gm_cruise_ads")
        self.assertEqual(self.by_id["W-1"]["program"], "waymo_ads")

    def test_other_entities_and_other_file_programs(self):
        def prog(entity, kind, engaged=""):
            row = fixture_row("current_ADS.csv", "W-1")
            row["Reporting Entity"] = entity
            row["Automation System Engaged?"] = engaged
            return harmonize.harmonize_row(row, "current", kind)

        self.assertEqual(prog("Acme AV, Inc.", "ADS")["program"], "other_ads")
        self.assertEqual(prog("Acme AV, Inc.", "ADAS")["program"], "other_l2")
        self.assertEqual(prog("Acme AV, Inc.", "ADAS")["company"], "other")
        # OTHER file: the engaged value picks the program, defaulting to L2.
        self.assertEqual(prog("Acme AV, Inc.", "OTHER", "ADS")["program"], "other_ads")
        self.assertEqual(prog("Acme AV, Inc.", "OTHER", "ADAS")["program"], "other_l2")
        self.assertEqual(prog("Acme AV, Inc.", "OTHER", "Unknown, see Narrative")["program"], "other_l2")
        self.assertEqual(prog("Acme AV, Inc.", "OTHER", "")["program"], "other_l2")
        self.assertEqual(prog("Tesla, Inc.", "OTHER", "Unknown, see Narrative")["program"], "tesla_l2")
        self.assertEqual(prog("Tesla, Inc.", "OTHER", "ADS")["program"], "tesla_robotaxi")
        self.assertEqual(prog("Cruise LLC", "OTHER", "")["program"], "gm_cruise_ads")
        self.assertEqual(prog("Tesla, Inc.", "OTHER", "")["file"], "OTHER")

    def test_month_parse(self):
        self.assertEqual(harmonize.parse_month("SEP-2026"), "2026-09")
        self.assertEqual(harmonize.parse_month(" jan-2024 "), "2024-01")
        self.assertIsNone(harmonize.parse_month(""))
        self.assertIsNone(harmonize.parse_month("   "))
        self.assertIsNone(harmonize.parse_month("JAN-1900"))
        self.assertIsNone(harmonize.parse_month("garbage"))

    def test_submitted_and_lag(self):
        r = self.by_id["T-100"]  # incident FEB-2024, submitted MAR-2024
        self.assertEqual(r["submitted"], "2024-03-31")
        self.assertEqual(r["lag_days"], 31)
        # Same month as submission: lag is 0, never negative.
        self.assertEqual(self.by_id["W-1"]["lag_days"], 0)
        self.assertGreaterEqual(min(x["lag_days"] for x in self.records if x["lag_days"] is not None), 0)
        # Missing incident month: lag is None.
        self.assertIsNone(self.by_id["CR-1"]["month"])
        self.assertIsNone(self.by_id["CR-1"]["lag_days"])

    def test_record_keys_exact(self):
        expected = {
            "id", "ver", "incident_key", "file", "era", "entity", "company", "program", "month",
            "submitted", "lag_days", "make", "model", "model_year", "city", "state", "roadway_type",
            "surface", "lighting", "weather", "speed_mph", "speed_limit", "crash_with", "cp_movement",
            "sv_movement", "severity", "hospitalized", "airbag", "towed", "within_odd", "narrative",
            "narrative_redacted", "version_redacted", "unknown_fields",
        }
        for r in self.records:
            self.assertEqual(set(r), expected)

    def test_missing_in_era_is_none(self):
        current = self.by_id["TR-1"]
        self.assertIsNone(current["lighting"])
        self.assertIsNone(current["surface"])
        self.assertIsNone(current["speed_limit"])
        archive = self.by_id["T-100"]
        self.assertEqual(archive["lighting"], "daylight")
        self.assertEqual(archive["surface"], "dry")
        self.assertEqual(archive["speed_limit"], 35)
        self.assertEqual(archive["era"], "archive")
        self.assertEqual(current["era"], "current")
        self.assertEqual(current["file"], "ADS")

    def test_weather_list(self):
        self.assertEqual(self.by_id["T-100"]["weather"], ["rain"])
        self.assertEqual(self.by_id["T-200"]["weather"], ["clear"])
        self.assertEqual(self.by_id["W-1"]["weather"], ["fog", "rain"])

    def test_airbag_and_towed(self):
        self.assertIs(self.by_id["TR-1"]["airbag"], True)  # Yes Subject Vehicle, Unknown Crash Partner
        self.assertIs(self.by_id["W-1"]["airbag"], False)  # No Subject Vehicle, No Crash Partner
        self.assertIs(self.by_id["W-1"]["towed"], True)
        self.assertIs(self.by_id["T-100"]["airbag"], False)  # SV No / CP No
        self.assertIsNone(self.by_id["T-100"]["towed"])  # SV No / CP Unknown

    def test_combined_flag_decoding(self):
        self.assertIs(harmonize.combine_flags("yes", "unknown"), True)
        self.assertIs(harmonize.combine_flags("unknown", "yes"), True)
        self.assertIs(harmonize.combine_flags("no", "no"), False)
        self.assertIs(harmonize.combine_flags("no", "na"), False)
        self.assertIsNone(harmonize.combine_flags("no", "unknown"))
        self.assertIsNone(harmonize.combine_flags("na", "na"))
        self.assertIsNone(harmonize.combine_flags("blank", "blank"))

    def test_redaction_flags(self):
        self.assertTrue(self.by_id["G-300"]["narrative_redacted"])
        self.assertTrue(self.by_id["CR-1"]["narrative_redacted"])  # blank
        self.assertFalse(self.by_id["T-100"]["narrative_redacted"])
        self.assertTrue(self.by_id["T-200"]["version_redacted"])  # marker text + CBI flag
        self.assertTrue(self.by_id["CR-1"]["version_redacted"])
        self.assertFalse(self.by_id["TR-1"]["version_redacted"])
        self.assertEqual(self.by_id["CR-1"]["within_odd"], "redacted")
        self.assertEqual(self.by_id["TR-1"]["within_odd"], "yes")

    def test_narrative_redaction_rule(self):
        m = schema.REDACTION_MARKER
        rule = harmonize.is_narrative_redacted
        self.assertTrue(rule("", ""))
        self.assertTrue(rule(m, ""))
        self.assertTrue(rule(m + "\n" + m, "Y"))
        self.assertTrue(rule("Customer said: " + m, ""))
        self.assertFalse(rule("A long readable narrative about the crash. " * 5 + m, ""))
        self.assertFalse(rule("Plain narrative with [XXX] masks.", ""))
        # CBI flag lowers the coverage threshold.
        text = "x" * 150 + m * 1  # coverage of marker ~ 0.30
        self.assertFalse(rule(text, ""))
        self.assertTrue(rule(text, "Y"))

    def test_script_narrative_preserved_verbatim(self):
        n = self.by_id["T-200"]["narrative"]
        self.assertTrue(n.startswith("<script>alert('x')</script>"))
        self.assertIn("\n", n)

    def test_unknown_fields_count(self):
        # CR-1: month, severity, within_odd (redacted), narrative (blank) are unknown;
        # everything else in UNKNOWN_FIELD_KEYS is known.
        self.assertEqual(self.by_id["CR-1"]["unknown_fields"], 4)
        self.assertEqual(self.by_id["TR-1"]["unknown_fields"], 0)
        self.assertEqual(len(set(schema.UNKNOWN_FIELD_KEYS)), len(schema.UNKNOWN_FIELD_KEYS))

    def test_unknown_text_values_are_none(self):
        row = fixture_row("current_ADS.csv", "W-1")
        row["Make"] = "unknown"
        row["State"] = "UNK"
        r = harmonize.harmonize_row(row, "current", "ADS")
        self.assertIsNone(r["make"])
        self.assertIsNone(r["state"])

    def test_model_year_and_speed_ints(self):
        r = self.by_id["TR-1"]
        self.assertEqual(r["model_year"], 2023)
        self.assertEqual(r["speed_mph"], 12)

    def test_missing_files_raise_unless_allowed(self):
        with self.assertRaises(FileNotFoundError):
            harmonize.load_all(FIXTURES)


class SchemaTests(unittest.TestCase):
    def test_expected_columns_cover_all_files(self):
        self.assertEqual(set(schema.EXPECTED_COLUMNS), {f["key"] for f in config.SGO_FILES})
        for cols in schema.EXPECTED_COLUMNS.values():
            self.assertIsInstance(cols, frozenset)

    def test_mapped_columns_exist(self):
        for era, fields in schema.COLUMNS.items():
            expected = schema.EXPECTED_COLUMNS[f"{era}_ADS"]
            for field, col in fields.items():
                if col is not None:
                    self.assertIn(col, expected, (era, field))
            for col in schema.WEATHER_COLUMNS[era]:
                self.assertIn(col, expected)

    def test_expected_columns_match_live_files(self):
        for f in config.SGO_FILES:
            path = config.RAW_DIR / f"{f['key']}.csv"
            if not path.exists():
                self.skipTest("raw files not present")
            with open(path, encoding="utf-8", errors="replace", newline="") as fh:
                header = next(csv.reader(fh))
            self.assertEqual(frozenset(header), schema.EXPECTED_COLUMNS[f["key"]], f["key"])
            self.assertEqual(len(header), len(set(header)))


if __name__ == "__main__":
    unittest.main()
