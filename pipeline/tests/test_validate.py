import copy
import datetime
import shutil
import tempfile
import unittest
from pathlib import Path

import support
from pipeline import config, manual, schema, validate

TODAY = datetime.date(2026, 11, 26)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.raw = support.make_raw_dir(Path(self.tmp.name) / "raw")

    def check(self, **kw):
        kw.setdefault("expected_entities", support.EXPECTED_ENTITIES)
        kw.setdefault("manual_dir", config.MANUAL_DIR)
        kw.setdefault("today", TODAY)
        return validate.check(self.raw, **kw)

    def assertNoErrors(self, errors):
        self.assertEqual(errors, [])

    def has(self, messages, *needles):
        return any(all(n in m for n in needles) for m in messages)


class CleanRunTests(Base):
    def test_fixture_is_clean_and_lag_note_is_a_warning(self):
        errors, warnings = self.check()
        self.assertNoErrors(errors)
        self.assertTrue(self.has(warnings, "month"), warnings)  # month-resolution lag note

    def test_live_data_has_no_errors(self):
        if not all((config.RAW_DIR / (s["key"] + ".csv")).exists() for s in config.SGO_FILES):
            self.skipTest("no live raw files")
        errors, _ = validate.check(config.RAW_DIR, expected_entities=validate.load_expected_entities(), today=TODAY)
        self.assertNoErrors(errors)


class HeaderTests(Base):
    def test_extra_column_is_named(self):
        def add(rows, fields):
            for r in rows:
                r["Surprise Column"] = "x"
            return fields + ["Surprise Column"]
        support.edit_csv(self.raw / "current_ADS.csv", add)
        errors, _ = self.check()
        self.assertTrue(self.has(errors, "current_ADS", "extra", "Surprise Column"), errors)

    def test_missing_column_is_named(self):
        def drop(rows, fields):
            for r in rows:
                del r["Narrative"]
            return [f for f in fields if f != "Narrative"]
        support.edit_csv(self.raw / "archive_ADAS.csv", drop)
        errors, _ = self.check()
        self.assertTrue(self.has(errors, "archive_ADAS", "missing", "Narrative"), errors)

    def test_renamed_column_reports_both_sides(self):
        def rename(rows, fields):
            for r in rows:
                r["Crash With Renamed"] = r.pop("Crash With")
            return [("Crash With Renamed" if f == "Crash With" else f) for f in fields]
        support.edit_csv(self.raw / "current_ADS.csv", rename)
        errors, _ = self.check()
        self.assertTrue(self.has(errors, "missing", "Crash With"), errors)
        self.assertTrue(self.has(errors, "extra", "Crash With Renamed"), errors)

    def test_missing_file_is_an_error(self):
        (self.raw / "current_OTHER.csv").unlink()
        errors, _ = self.check()
        self.assertTrue(self.has(errors, "current_OTHER", "missing"), errors)


class LabelTests(Base):
    def test_new_label_is_an_error_naming_it(self):
        def relabel(rows, fields):
            rows[0]["Highest Injury Severity Alleged"] = "Mildly Ouchy"
        support.edit_csv(self.raw / "current_ADS.csv", relabel)
        errors, _ = self.check()
        self.assertTrue(self.has(errors, "severity", "Mildly Ouchy"), errors)

    def test_unmapped_set_is_reported_per_field_and_value(self):
        errors = validate.check_unmapped({("crash_with", "Hovercraft"), ("roadway_type", "Sky Bridge")})
        self.assertEqual(len(errors), 2)
        self.assertTrue(self.has(errors, "crash_with", "Hovercraft"))
        self.assertTrue(self.has(errors, "roadway_type", "Sky Bridge"))
        self.assertEqual(validate.check_unmapped(set()), [])


class CountDropTests(Base):
    def test_row_count_drop_against_previous_fetch_log(self):
        previous = [{"key": "current_ADS", "rows": 6}, {"key": "archive_ADAS", "rows": 6}]
        errors, _ = self.check(previous_fetch_log=previous)
        self.assertTrue(self.has(errors, "current_ADS", "5", "6"), errors)  # 5 rows now, 6 before
        self.assertFalse(self.has(errors, "archive_ADAS"), errors)

    def test_row_count_drop_against_previous_meta_files(self):
        meta = {"fetch_log": {"current_ADS": {"rows": 9}}}
        errors, _ = self.check(previous_meta=meta)
        self.assertTrue(self.has(errors, "current_ADS", "9"), errors)

    def test_more_rows_than_before_is_fine(self):
        errors, _ = self.check(previous_fetch_log=[{"key": "current_ADS", "rows": 1}], previous_meta={"counts_total": {"reports": 1}})
        self.assertNoErrors(errors)

    def test_unique_reports_drop_against_previous_meta(self):
        errors, _ = self.check(previous_meta={"counts_total": {"reports": 500, "incidents": 400}})
        self.assertTrue(self.has(errors, "unique reports", "500"), errors)

    def test_old_preview_meta_shape_is_understood(self):
        errors, _ = self.check(previous_meta={"total_reports": 500, "files": [{"key": "current_ADS", "rows": 5}]})
        self.assertTrue(self.has(errors, "unique reports", "500"), errors)
        self.assertFalse(self.has(errors, "current_ADS"), errors)


class EntityTests(Base):
    def test_missing_expected_entity_is_an_error(self):
        errors, _ = self.check(expected_entities=support.EXPECTED_ENTITIES + ["Zoox, Inc."])
        self.assertTrue(self.has(errors, "Zoox, Inc.", "disappeared"), errors)

    def test_new_entity_is_a_warning_only(self):
        errors, warnings = self.check(previous_meta={"entities": ["Tesla, Inc.", "General Motors, LLC", "Waymo LLC", "Cruise LLC"]})
        self.assertNoErrors(errors)
        self.assertTrue(self.has(warnings, "new reporting entity", "Nuro Test, Inc."), warnings)
        self.assertFalse(self.has(warnings, "new reporting entity", "Waymo LLC"), warnings)

    def test_no_new_entity_warning_without_a_previous_entity_list(self):
        _, warnings = self.check(previous_meta={"counts_total": {"reports": 1}})
        self.assertFalse(self.has(warnings, "new reporting entity"), warnings)


class ParseTests(Base):
    def test_unparseable_dates_over_half_a_percent_fail(self):
        def mangle(rows, fields):
            rows[0]["Incident Date"] = "2026/09/xx"
        support.edit_csv(self.raw / "current_ADS.csv", mangle)
        errors, _ = self.check()
        self.assertTrue(self.has(errors, "parse", "%"), errors)

    def test_blank_dates_and_sentinel_years_are_not_parse_failures(self):
        def blank(rows, fields):
            rows[0]["Incident Date"] = ""
            rows[1]["Incident Date"] = "JAN-1900"
        support.edit_csv(self.raw / "current_ADS.csv", blank)
        errors, _ = self.check()
        self.assertFalse(self.has(errors, "parse"), errors)

    def test_rate_function(self):
        rows = [{"Report Type": "5-Day", "Incident Date": "JAN-2025", "Report Submission Date": "FEB-2025"}] * 199
        rows.append({"Report Type": "5-Day", "Incident Date": "nonsense", "Report Submission Date": "FEB-2025"})
        failed, total = validate.parse_failures(rows)
        self.assertEqual((failed, total), (1, 200))


class DuplicateTests(Base):
    def test_duplicate_report_id_and_version_across_files(self):
        import csv
        with open(self.raw / "current_ADS.csv", encoding="utf-8", newline="") as f:
            first = next(csv.DictReader(f))
        support.edit_csv(self.raw / "archive_ADAS.csv", lambda rows, fields: rows.append(dict(rows[0], **{"Report ID": first["Report ID"], "Report Version": first["Report Version"]})))
        errors, _ = self.check()
        self.assertTrue(self.has(errors, "duplicate", first["Report ID"], "current_ADS", "archive_ADAS"), errors)


class ManualTests(Base):
    def test_unresolved_source_id_is_an_error(self):
        manual_dir = Path(self.tmp.name) / "manual"
        shutil.copytree(config.MANUAL_DIR, manual_dir)
        support.edit_csv(manual_dir / "events.csv", lambda rows, fields: rows[0].update({"source_id": "no_such_source"}))
        errors, _ = self.check(manual_dir=manual_dir)
        self.assertTrue(self.has(errors, "manual", "no_such_source"), errors)


class CadenceTests(Base):
    def test_stale_disclosure_is_a_warning_only(self):
        errors, warnings = self.check(today=datetime.date(2030, 1, 1))
        self.assertNoErrors(errors)
        self.assertTrue(self.has(warnings, "stale", "tesla_l2", "cum_miles"), warnings)

    def test_cadence_status(self):
        rows = [
            {"company": "t", "program": "p", "metric": "a", "expected_every_days": 92, "last_period": "2026-10-22"},
            {"company": "t", "program": "p", "metric": "b", "expected_every_days": 92, "last_period": "2026-Q1"},
            {"company": "t", "program": "p", "metric": "c", "expected_every_days": 365, "last_period": "2024"},
        ]
        status = {r["metric"]: r for r in validate.cadence_status(rows, TODAY)}
        self.assertFalse(status["a"]["stale"])
        self.assertEqual(status["a"]["age_days"], 35)
        self.assertTrue(status["b"]["stale"])
        self.assertEqual(status["b"]["last_date"], "2026-03-31")
        self.assertTrue(status["c"]["stale"])
        self.assertEqual(status["c"]["last_date"], "2024-12-31")


class SwingTests(unittest.TestCase):
    @staticmethod
    def records(company, per_month, start=(2025, 1)):
        out, y, m = [], start[0], start[1]
        for n in per_month:
            out.extend({"company": company, "month": "%04d-%02d" % (y, m)} for _ in range(n))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        return out

    def test_big_month_over_month_swing_warns(self):
        recs = self.records("tesla", [100, 100, 100, 100, 40, 100, 100, 100, 100])  # drop of 60% in month 5
        warnings = validate.check_swings(recs)
        self.assertTrue(any("tesla" in w and "2025-05" in w for w in warnings), warnings)

    def test_steady_company_does_not_warn(self):
        self.assertEqual(validate.check_swings(self.records("tesla", [100, 110, 90, 105, 95, 100, 100, 100, 100])), [])

    def test_small_counts_and_immature_latest_months_do_not_warn(self):
        self.assertEqual(validate.check_swings(self.records("waymo", [3, 9, 2, 8, 1, 7, 2, 8, 1])), [])
        # the newest two months are still filling up (reporting lag): a drop there is expected
        self.assertEqual(validate.check_swings(self.records("tesla", [100] * 7 + [30, 10])), [])


class OutputCheckTests(unittest.TestCase):
    REPORTS = [
        {"program": "waymo_ads", "incident_key": "K"}, {"program": "waymo_ads", "incident_key": "J"},
        {"program": "other_ads", "incident_key": "K"},
    ]

    def good_rows(self):
        return [{"program": "waymo_ads", "crashes": 2, "reports": 2}, {"program": "other_ads", "crashes": 1, "reports": 1}]

    def test_counts_reconcile_per_program_and_globally(self):
        # K is one incident under two programs: 3 program crashes, 2 unique incidents
        self.assertEqual(validate.check_counts(self.good_rows(), self.REPORTS, unique_incidents=2), [])

    def test_planted_mismatches_are_caught(self):
        rows = self.good_rows()
        rows[0]["crashes"] = 3
        errors = validate.check_counts(rows, self.REPORTS, 2)
        self.assertEqual(len(errors), 1)
        self.assertIn("waymo_ads", errors[0])
        rows = self.good_rows()
        rows[1]["reports"] = 2
        errors = validate.check_counts(rows, self.REPORTS, 2)
        self.assertTrue(len(errors) == 1 and "other_ads" in errors[0] and "reports" in errors[0], errors)
        errors = validate.check_counts(self.good_rows(), self.REPORTS, unique_incidents=3)  # summing across programs
        self.assertEqual(len(errors), 1)
        self.assertIn("unique incidents", errors[0])
        rows = self.good_rows() + [{"program": "ghost", "crashes": 1, "reports": 1}]
        self.assertEqual(len(validate.check_counts(rows, self.REPORTS, 2)), 2)

    def test_exposure_rows_must_cite_known_sources(self):
        outputs = {"exposure.json": {"rows": [{"source_ids": ["a", "zzz"]}, {"source_ids": []}]}, "sources.json": {"rows": [{"source_id": "a"}]}}
        errors = validate.check_exposure_sources(outputs)
        self.assertEqual(len(errors), 2)
        self.assertTrue(any("zzz" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
