import csv
import tempfile
import unittest
from pathlib import Path

from pipeline import manual

SOURCE = {
    "source_id": "src_a",
    "publisher": "Example Co",
    "title": "Example disclosure",
    "url": "https://example.com/a",
    "published": "2025-01-15",
    "accessed": "2026-11-26",
    "date_range": "2024",
    "source_type": "primary",
    "methodology": "Company-stated total.",
    "caveats": "None stated.",
    "locator": "Paragraph 2",
}
EXPOSURE = {
    "company": "waymo",
    "program": "waymo_ads",
    "region": "us",
    "period": "2024-12-31",
    "period_type": "cumulative_to",
    "metric": "cum_miles",
    "value": "50000000",
    "kind": "reported",
    "source_id": "src_a",
    "method_note": "",
}
COMPANY_REPORTED = {
    "company": "tesla",
    "program": "tesla_l2",
    "region": "global",
    "period": "2024-Q3",
    "period_type": "quarter",
    "metric": "miles_per_crash_autopilot",
    "value": "7080000",
    "unit": "miles per crash",
    "window": "5s",
    "source_id": "src_a",
    "method_note": "",
}
INVESTIGATION = {
    "investigation_id": "PE25012",
    "company": "tesla",
    "opened": "2025-10-07",
    "closed": "",
    "status": "open",
    "type": "PE",
    "subject": "Example subject",
    "vehicles_covered": "2882566",
    "url": "https://static.nhtsa.gov/odi/inv/2025/INOA-PE25012-12345.pdf",
    "source_id": "src_a",
}
EVENT = {
    "date": "2025-06-16",
    "company": "all",
    "program": "",
    "type": "regulatory",
    "label": "Third Amended SGO takes effect",
    "source_id": "src_a",
}
CADENCE = {
    "company": "waymo",
    "program": "waymo_ads",
    "metric": "cum_miles",
    "expected_every_days": "120",
    "last_period": "2024-12-31",
}


def write_table(path, columns, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=columns)
        w.writeheader()
        for row in rows:
            w.writerow(row)


class ManualFixture:
    """Writes a minimal valid set of manual tables into a temp dir."""

    def __init__(self):
        self.tables = {
            "sources": [dict(SOURCE)],
            "exposure": [dict(EXPOSURE)],
            "company_reported": [dict(COMPANY_REPORTED)],
            "investigations": [dict(INVESTIGATION)],
            "events": [dict(EVENT)],
            "cadence": [dict(CADENCE)],
        }
        self.columns = {name: list(manual.COLUMNS[name]) for name in self.tables}

    def write(self, directory):
        for name, rows in self.tables.items():
            write_table(Path(directory) / manual.FILES[name], self.columns[name], rows)


class ManualLoadTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.fx = ManualFixture()

    def tearDown(self):
        self._tmp.cleanup()

    def load(self):
        self.fx.write(self.dir)
        return manual.load(self.dir)

    def assertRaisesManual(self, *needles):
        with self.assertRaises(manual.ManualDataError) as ctx:
            self.load()
        msg = str(ctx.exception)
        for needle in needles:
            self.assertIn(needle, msg)
        return msg

    # ---------------------------------------------------------------- valid
    def test_valid_fixture_loads(self):
        data = self.load()
        self.assertEqual(
            set(data),
            {"sources", "exposure", "company_reported", "investigations", "events", "cadence"},
        )
        self.assertEqual(data["sources"][0]["source_id"], "src_a")
        exp = data["exposure"][0]
        self.assertEqual(exp["value"], 50000000)
        self.assertIsInstance(exp["value"], int)
        self.assertEqual(exp["source_ids"], ["src_a"])
        self.assertEqual(data["company_reported"][0]["value"], 7080000)
        self.assertEqual(data["investigations"][0]["vehicles_covered"], 2882566)
        self.assertEqual(data["cadence"][0]["expected_every_days"], 120)

    def test_decimal_value_parses_as_float(self):
        self.fx.tables["company_reported"][0]["value"] = "88.5"
        data = self.load()
        self.assertEqual(data["company_reported"][0]["value"], 88.5)

    # ------------------------------------------------------------- exposure
    def test_exposure_unknown_source_id_raises(self):
        self.fx.tables["exposure"][0]["source_id"] = "nope"
        self.assertRaisesManual("exposure.csv", "nope")

    def test_exposure_bad_kind_raises(self):
        self.fx.tables["exposure"][0]["kind"] = "guess"
        self.assertRaisesManual("exposure.csv", "guess")

    def test_exposure_non_numeric_value_raises(self):
        for bad in ("50,000,000", "", "about 5M", "nan", "inf"):
            with self.subTest(value=bad):
                self.fx.tables["exposure"][0]["value"] = bad
                self.assertRaisesManual("exposure.csv", "value")

    def test_exposure_negative_value_raises(self):
        self.fx.tables["exposure"][0]["value"] = "-5"
        self.assertRaisesManual("exposure.csv", "value")

    def test_exposure_duplicate_key_raises(self):
        dup = dict(EXPOSURE, value="50000001")
        self.fx.tables["exposure"].append(dup)
        self.assertRaisesManual("exposure.csv", "duplicate")

    def test_exposure_same_key_other_region_or_kind_is_not_duplicate(self):
        self.fx.tables["exposure"].append(dict(EXPOSURE, region="ca"))
        self.fx.tables["exposure"].append(
            dict(EXPOSURE, kind="estimate", method_note="Assumes 30 mph average.")
        )
        data = self.load()
        self.assertEqual(len(data["exposure"]), 3)

    def test_exposure_bad_metric_raises(self):
        self.fx.tables["exposure"][0]["metric"] = "deliveries"
        self.assertRaisesManual("exposure.csv", "deliveries")

    def test_exposure_period_must_match_period_type(self):
        cases = [
            ("year", "2024", True),
            ("year", "2024-12", False),
            ("quarter", "2024-Q4", True),
            ("quarter", "2024-Q5", False),
            ("month", "2024-02", True),
            ("month", "2024-13", False),
            ("cumulative_to", "2024-02-29", True),
            ("cumulative_to", "2023-02-29", False),
            ("decade", "2020", False),
        ]
        for ptype, period, ok in cases:
            with self.subTest(period_type=ptype, period=period):
                self.fx.tables["exposure"][0].update(period_type=ptype, period=period)
                if ok:
                    self.load()
                else:
                    self.assertRaisesManual("exposure.csv", "period")

    def test_exposure_program_must_belong_to_company(self):
        self.fx.tables["exposure"][0]["program"] = "tesla_l2"
        self.assertRaisesManual("exposure.csv", "tesla_l2")

    def test_exposure_unknown_company_raises(self):
        self.fx.tables["exposure"][0]["company"] = "acme"
        self.assertRaisesManual("exposure.csv", "acme")

    def test_exposure_bad_region_raises(self):
        self.fx.tables["exposure"][0]["region"] = "California"
        self.assertRaisesManual("exposure.csv", "region")

    def test_exposure_city_region_ok(self):
        self.fx.tables["exposure"][0]["region"] = "city:san_francisco"
        self.load()

    def test_derived_and_estimate_rows_need_method_note(self):
        for kind in ("derived", "estimate"):
            with self.subTest(kind=kind):
                self.fx.tables["exposure"][0].update(kind=kind, method_note="")
                self.assertRaisesManual("exposure.csv", "method_note")

    def test_reported_row_cites_exactly_one_source(self):
        self.fx.tables["sources"].append(dict(SOURCE, source_id="src_b"))
        self.fx.tables["exposure"][0]["source_id"] = "src_a;src_b"
        self.assertRaisesManual("exposure.csv", "one source")

    def test_derived_row_may_cite_several_sources(self):
        self.fx.tables["sources"].append(dict(SOURCE, source_id="src_b"))
        self.fx.tables["exposure"][0].update(
            kind="derived", source_id="src_a;src_b", method_note="b minus a."
        )
        data = self.load()
        self.assertEqual(data["exposure"][0]["source_ids"], ["src_a", "src_b"])

    def test_derived_row_with_one_unknown_source_raises(self):
        self.fx.tables["exposure"][0].update(
            kind="derived", source_id="src_a;src_zz", method_note="b minus a."
        )
        self.assertRaisesManual("exposure.csv", "src_zz")

    # ----------------------------------------------------- company_reported
    def test_company_reported_unknown_source_id_raises(self):
        self.fx.tables["company_reported"][0]["source_id"] = "nope"
        self.assertRaisesManual("company_reported.csv", "nope")

    def test_company_reported_non_numeric_value_raises(self):
        self.fx.tables["company_reported"][0]["value"] = "7.08M"
        self.assertRaisesManual("company_reported.csv", "value")

    def test_company_reported_duplicate_raises(self):
        self.fx.tables["company_reported"].append(dict(COMPANY_REPORTED, value="1"))
        self.assertRaisesManual("company_reported.csv", "duplicate")

    def test_company_reported_needs_unit(self):
        self.fx.tables["company_reported"][0]["unit"] = ""
        self.assertRaisesManual("company_reported.csv", "unit")

    def test_company_reported_bad_period_raises(self):
        self.fx.tables["company_reported"][0]["period"] = "Q3 2024"
        self.assertRaisesManual("company_reported.csv", "period")

    # -------------------------------------------------------------- sources
    def test_duplicate_source_id_raises(self):
        self.fx.tables["sources"].append(dict(SOURCE))
        self.assertRaisesManual("sources.csv", "duplicate")

    def test_bad_source_type_raises(self):
        self.fx.tables["sources"][0]["source_type"] = "blog"
        self.assertRaisesManual("sources.csv", "source_type")

    def test_source_needs_http_url_and_locator(self):
        self.fx.tables["sources"][0]["url"] = "example.com"
        self.assertRaisesManual("sources.csv", "url")
        self.fx.tables["sources"][0]["url"] = "https://example.com"
        self.fx.tables["sources"][0]["locator"] = ""
        self.assertRaisesManual("sources.csv", "locator")

    def test_source_published_may_be_partial_date(self):
        for published in ("2025", "2025-03", "2025-03-04"):
            with self.subTest(published=published):
                self.fx.tables["sources"][0]["published"] = published
                self.load()
        self.fx.tables["sources"][0]["published"] = "March 2025"
        self.assertRaisesManual("sources.csv", "published")

    # ------------------------------------------------------- investigations
    def test_investigation_bad_type_raises(self):
        self.fx.tables["investigations"][0]["type"] = "XX"
        self.assertRaisesManual("investigations.csv", "XX")

    def test_investigation_unknown_source_raises(self):
        self.fx.tables["investigations"][0]["source_id"] = "nope"
        self.assertRaisesManual("investigations.csv", "nope")

    def test_investigation_status_and_closed_date_agree(self):
        self.fx.tables["investigations"][0].update(status="closed", closed="")
        self.assertRaisesManual("investigations.csv", "closed")
        self.fx.tables["investigations"][0].update(status="open", closed="2025-12-01")
        self.assertRaisesManual("investigations.csv", "closed")

    def test_investigation_duplicate_id_raises(self):
        self.fx.tables["investigations"].append(dict(INVESTIGATION))
        self.assertRaisesManual("investigations.csv", "duplicate")

    def test_investigation_vehicles_covered_may_be_blank(self):
        self.fx.tables["investigations"][0]["vehicles_covered"] = ""
        data = self.load()
        self.assertIsNone(data["investigations"][0]["vehicles_covered"])

    # --------------------------------------------------------------- events
    def test_event_bad_type_raises(self):
        self.fx.tables["events"][0]["type"] = "rumor"
        self.assertRaisesManual("events.csv", "rumor")

    def test_event_bad_date_raises(self):
        self.fx.tables["events"][0]["date"] = "2025-06"
        self.assertRaisesManual("events.csv", "date")

    def test_event_unknown_source_raises(self):
        self.fx.tables["events"][0]["source_id"] = "nope"
        self.assertRaisesManual("events.csv", "nope")

    # -------------------------------------------------------------- cadence
    def test_cadence_days_must_be_positive_int(self):
        for bad in ("0", "-1", "30.5", ""):
            with self.subTest(days=bad):
                self.fx.tables["cadence"][0]["expected_every_days"] = bad
                self.assertRaisesManual("disclosure_cadence.csv", "expected_every_days")

    def test_cadence_last_period_must_be_a_period(self):
        self.fx.tables["cadence"][0]["last_period"] = "recently"
        self.assertRaisesManual("disclosure_cadence.csv", "last_period")

    # --------------------------------------------------------------- shape
    def test_missing_column_raises(self):
        self.fx.columns["exposure"].remove("kind")
        for row in self.fx.tables["exposure"]:
            row.pop("kind")
        self.assertRaisesManual("exposure.csv", "kind")

    def test_extra_column_raises(self):
        self.fx.columns["events"].append("notes")
        self.fx.tables["events"][0]["notes"] = "x"
        self.assertRaisesManual("events.csv", "notes")

    def test_missing_file_raises(self):
        self.fx.write(self.dir)
        (self.dir / manual.FILES["events"]).unlink()
        with self.assertRaises(manual.ManualDataError) as ctx:
            manual.load(self.dir)
        self.assertIn("events.csv", str(ctx.exception))

    def test_whitespace_is_trimmed(self):
        self.fx.tables["exposure"][0]["company"] = " waymo "
        self.fx.tables["exposure"][0]["value"] = " 42 "
        data = self.load()
        self.assertEqual(data["exposure"][0]["company"], "waymo")
        self.assertEqual(data["exposure"][0]["value"], 42)


if __name__ == "__main__":
    unittest.main()
