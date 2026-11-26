import copy
import datetime
import json
import tempfile
import unittest
from pathlib import Path

import support
from pipeline import aggregate as agg
from pipeline import classify, golden, manual, validate

TODAY = datetime.date(2026, 11, 26)
EMPTY_MANUAL = {name: [] for name in manual.FILES}
RUN_AT = "2026-11-26T22:00:00Z"


def rec(report_id, key, severity="none", program="waymo_ads", month="2025-01", **kw):
    """A golden `reports` row with the fields the aggregates read."""
    base = {
        "report_key": "%s|v1" % report_id, "report_id": report_id, "version": 1, "kind": "ADS", "source_file": "current_ADS",
        "is_latest": True, "is_placeholder": False, "removed_in_run": None, "row_hash": "h-" + report_id,
        "incident_key": key, "era": "current", "entity": "E", "company": program.split("_")[0], "program": program,
        "month": month, "lag_days": 30, "make": None, "model": None, "model_year": None, "city": None, "state": "CA",
        "roadway_type": "street", "surface": None, "lighting": None, "weather": [], "speed_mph": 10, "speed_limit": None,
        "speed_band": "6-15", "crash_with": "suv", "cp_movement": None, "sv_movement": "stopped", "severity": severity,
        "hospitalized": None, "airbag": None, "towed": None, "within_odd": "yes", "narrative_redacted": False,
        "version_redacted": False, "tags": [], "unknown_fields": 0,
        "raw": {"Narrative": "secret text"},
    }
    base.update(kw)
    return base


def tables_of(reports, **extra):
    tables = {name: [] for name in golden.TABLES}
    tables["reports"] = reports
    tables.update(extra)
    return tables


def counts_rows(reports):
    return agg.build_counts(agg.current_reports(tables_of(reports)))["rows"]


class CountTests(unittest.TestCase):
    def test_incident_in_records_has_the_higher_severity_and_n_reports(self):
        reports = [
            rec("1", "K", "minor"),
            rec("2", "K", "serious", program="gm_cruise_ads"),
            rec("3", "J", "unknown"),
            rec("4", "J", "none"),
            rec("5", "solo", "fatal", month=None),
        ]
        crashes = agg.unique_crashes(agg.current_reports(tables_of(reports)))
        self.assertEqual(len(crashes), 3)
        by_key = {r["incident_key"]: (r, n) for r, n in crashes}
        self.assertEqual(by_key["K"][0]["severity"], "serious")
        self.assertEqual(by_key["K"][0]["program"], "gm_cruise_ads")  # representative report
        self.assertEqual(by_key["K"][1], 2)
        self.assertEqual(by_key["J"][0]["severity"], "none")  # a known severity beats unknown

    def test_two_reports_of_one_incident_in_one_program_are_one_crash_with_the_higher_severity(self):
        rows = counts_rows([rec("1", "K", "minor"), rec("2", "K", "serious")])
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["reports"], r["crashes"], r["serious_plus"], r["injury"], r["fatal"]), (2, 1, 1, 1, 0))

    def test_cross_program_incident_counts_once_under_each_program(self):
        reports = [
            rec("1", "K", "minor", program="waymo_ads", month="2025-01"),
            rec("2", "K", "serious", program="other_ads", month="2025-02", kind="ADAS"),
            rec("3", "J", "none", program="waymo_ads", month="2025-01"),
        ]
        by_program = {}
        for r in counts_rows(reports):
            by_program.setdefault(r["program"], []).append(r)
        waymo, other = by_program["waymo_ads"], by_program["other_ads"]
        self.assertEqual((sum(r["crashes"] for r in waymo), sum(r["crashes"] for r in other)), (2, 1))
        # reports land in each report's own program, month and file
        self.assertEqual([(r["month"], r["file"], r["reports"]) for r in other], [("2025-02", "ADAS", 1)])
        self.assertEqual([(r["month"], r["file"], r["reports"]) for r in waymo], [("2025-01", "ADS", 2)])
        # severity per program is the max of that program's OWN reports of the incident
        self.assertEqual((waymo[0]["serious_plus"], waymo[0]["injury"]), (0, 1))  # minor, not the other program's serious
        self.assertEqual((other[0]["serious_plus"], other[0]["injury"]), (1, 1))
        # the grand total is the unique incidents, kept separately; crashes are not additive across programs
        counts = agg.build_counts(agg.current_reports(tables_of(reports)))
        self.assertEqual(counts["unique_incidents"], 2)
        self.assertEqual(sum(r["crashes"] for r in counts["rows"]), 3)
        self.assertTrue(any("must not be summed" in n for n in counts["notes"]))

    def test_per_program_severity_is_the_max_of_the_programs_own_reports(self):
        reports = [
            rec("1", "K", "minor", program="waymo_ads", month="2025-01"),
            rec("2", "K", "fatal", program="waymo_ads", month="2025-03"),
            rec("3", "K", "none", program="other_ads", month="2025-01"),
        ]
        rows = {r["program"]: r for r in counts_rows(reports)}
        self.assertEqual(rows["waymo_ads"]["fatal"], 1)  # the fatal report sits in 2025-03
        self.assertEqual(rows["waymo_ads"]["month"], "2025-03")
        self.assertEqual(rows["other_ads"]["fatal"], 0)
        self.assertEqual(sum(r["reports"] for r in counts_rows(reports) if r["program"] == "waymo_ads"), 2)

    def test_lag_reports_match_counts_reports_per_program(self):
        reports = [rec("1", "a", lag_days=3), rec("2", "b", lag_days=None), rec("3", "c", program="other_ads", lag_days=9)]
        current = agg.current_reports(tables_of(reports))
        lag = agg.build_lag(current)["programs"]
        for program, entry in lag.items():
            self.assertEqual(entry["n_reports"], sum(r["reports"] for r in agg.build_counts(current)["rows"] if r["program"] == program))
        self.assertEqual(lag["waymo_ads"]["n"], 1)

    def test_counts_row_fields_and_severity_buckets(self):
        reports = [
            rec("1", "a", "fatal", tags=[{"t": "vru", "basis": "field", "rule": "VRU-1"}]),
            rec("2", "b", "serious"),
            rec("3", "c", "moderate"),
            rec("4", "d", "minor"),
            rec("5", "e", "none"),
            rec("6", "f", "unknown"),
            rec("7", "g", "none", kind="ADAS", program="tesla_l2", company="tesla"),
        ]
        rows = {(r["program"], r["file"]): r for r in counts_rows(reports)}
        waymo = rows[("waymo_ads", "ADS")]
        self.assertEqual(set(waymo), {"program", "company", "month", "file", "reports", "crashes", "fatal", "serious_plus", "injury", "vru", "vru_field"})
        self.assertEqual(
            (waymo["month"], waymo["company"], waymo["reports"], waymo["crashes"], waymo["fatal"], waymo["serious_plus"], waymo["injury"], waymo["vru"]),
            ("2025-01", "waymo", 6, 6, 1, 2, 4, 1),
        )
        self.assertEqual(rows[("tesla_l2", "ADAS")]["crashes"], 1)

    def test_placeholders_removed_and_superseded_rows_are_not_counted(self):
        reports = [
            rec("1", "a"),
            rec("2", "b", is_placeholder=True),
            rec("3", "c", removed_in_run="r2"),
            rec("4", "d", is_latest=False),
        ]
        rows = counts_rows(reports)
        self.assertEqual(sum(r["crashes"] for r in rows), 1)
        self.assertEqual(sum(r["reports"] for r in rows), 1)

    def test_old_nested_counts_shape_is_kept_for_the_site(self):
        reports = [rec("1", "K", "minor"), rec("2", "K", "serious"), rec("3", "J", "none"), rec("4", "S", "fatal", month=None)]
        counts = agg.build_counts(agg.current_reports(tables_of(reports)))
        self.assertEqual(counts["counts"]["waymo_ads"]["2025-01"], {"serious": 1, "none": 1})
        self.assertEqual(counts["counts"]["waymo_ads"]["undated"], {"fatal": 1})
        self.assertEqual(counts["programs"], ["waymo_ads"])
        self.assertEqual(counts["months"], ["2025-01"])
        self.assertIn("severities", counts)
        total = sum(n for p in counts["counts"].values() for m in p.values() for n in m.values())
        self.assertEqual(total, sum(r["crashes"] for r in counts["rows"]))

    def test_only_sgo_severity_never_a_death_count(self):
        counts = agg.build_counts(agg.current_reports(tables_of([rec("1", "a", "fatal")])))
        self.assertNotIn("fatalities", json.dumps(counts))


class RecordsTests(unittest.TestCase):
    def test_records_json_has_no_narrative_and_is_columnar(self):
        crashes = agg.unique_crashes(agg.current_reports(tables_of([
            rec("1", "K", crash_with="pedestrian", tags=[{"t": "vru", "basis": "field", "rule": "VRU-1"}], speed_band="6-15")])))
        out = agg.build_records(crashes)
        self.assertEqual(out["fields"], agg.RECORD_FIELDS)
        self.assertNotIn("narrative", out["fields"])
        self.assertNotIn("secret text", json.dumps(out))
        row = dict(zip(out["fields"], out["rows"][0]))
        self.assertEqual(row["id"], "1")
        self.assertIn("vru:f", row["tags"])
        self.assertEqual(row["speed_band"], "6-15")
        self.assertEqual(row["n_reports"], 1)

    def test_narratives_only_for_non_redacted_reports(self):
        reports = [
            rec("1", "a", raw={"Narrative": "plain text"}),
            rec("2", "b", narrative_redacted=True, raw={"Narrative": "[REDACTED, MAY CONTAIN CONFIDENTIAL BUSINESS INFORMATION]"}),
            rec("3", "c", is_placeholder=True, raw={"Narrative": ""}),
        ]
        self.assertEqual(agg.build_narratives(agg.current_reports(tables_of(reports))), {"1": "plain text"})


class TransparencyAndLagTests(unittest.TestCase):
    def test_transparency_shares(self):
        reports = [
            rec("1", "a", program="tesla_l2", narrative_redacted=True, version_redacted=True, crash_with="unknown",
                within_odd="redacted", era="archive", lighting="daylight"),
            rec("2", "b", program="tesla_l2", narrative_redacted=False, version_redacted=True, era="current"),
        ]
        t = agg.build_transparency(reports)
        cells = t["cells"]["tesla_l2"]
        self.assertEqual(cells["narrative"]["redacted"], 0.5)
        self.assertEqual(cells["version"]["redacted"], 1.0)
        self.assertEqual(cells["crash_with"]["unknown"], 0.5)
        self.assertEqual(cells["within_odd"]["redacted"], 0.5)
        self.assertEqual(cells["lighting"]["n"], 1)  # archive-only field
        self.assertEqual(cells["lighting"]["provided"], 1.0)
        for field in t["fields"]:
            c = cells[field]
            self.assertAlmostEqual(c["provided"] + c["unknown"] + c["redacted"], 1.0)

    def test_lag_cdf_per_program(self):
        reports = [rec(str(i), str(i), lag_days=d) for i, d in enumerate([0, 0, 31, 61, 400])]
        reports.append(rec("x", "x", lag_days=None))  # no lag: not in the distribution
        reports.append(rec("t", "t", program="tesla_l2", lag_days=30))
        lag = agg.build_lag(agg.current_reports(tables_of(reports)))
        self.assertEqual(lag["days"], list(range(0, 366, 15)))
        self.assertEqual(lag["resolution"], "month")
        waymo = lag["programs"]["waymo_ads"]
        self.assertEqual(waymo["n"], 5)
        self.assertEqual(len(waymo["cdf"]), len(lag["days"]))
        self.assertEqual(waymo["cdf"][0], 0.4)
        self.assertEqual(waymo["cdf"][lag["days"].index(30)], 0.4)
        self.assertEqual(waymo["cdf"][lag["days"].index(45)], 0.6)
        self.assertEqual(waymo["cdf"][-1], 0.8)  # the 400-day report is beyond the grid
        self.assertEqual(waymo["cdf"], sorted(waymo["cdf"]))


class FixtureBuildTests(unittest.TestCase):
    """Real rows from the fixture CSVs, through golden.build and the aggregates."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.raw = support.make_raw_dir(Path(cls.tmp.name) / "raw")
        cls.tables = golden.build(cls.raw, EMPTY_MANUAL, "r1", fetch_log=support.fetch_log_for(cls.raw))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_latest_version_wins_everywhere_including_counts(self):
        rows = counts_rows(self.tables["reports"])
        months = {r["month"] for r in rows if r["program"] == "tesla_l2"}
        self.assertIn("2024-02", months)  # T-100 v2 moved the incident from JAN to FEB-2024
        self.assertNotIn("2024-01", months)

    def test_totals_reconcile_with_the_incidents_table(self):
        outputs, _ = agg.build_all(self.tables, fetch_log=support.fetch_log_for(self.raw), run_id="r1", run_at=RUN_AT, today=TODAY)
        unique = outputs["meta.json"]["counts_total"]["unique_incidents"]
        self.assertEqual(unique, len(self.tables["incidents"]))
        self.assertEqual(unique, len(outputs["records.json"]["rows"]))
        self.assertEqual(sum(r["reports"] for r in outputs["counts.json"]["rows"]), outputs["meta.json"]["counts_total"]["reports"])
        self.assertGreaterEqual(sum(r["crashes"] for r in outputs["counts.json"]["rows"]), unique)  # multi-program incidents overlap
        self.assertEqual(validate.check_outputs(outputs, self.tables), [])

    def test_blank_or_whitespace_incident_ids_are_separate_incidents(self):
        raw = support.make_raw_dir(Path(self.tmp.name) / "raw_blank")

        def blank(rows, fields):
            for row in rows:
                if row["Report ID"] in ("TR-1", "W-1", "AV-1"):
                    row["Same Incident ID"] = "   " if row["Report ID"] == "TR-1" else ""
        support.edit_csv(raw / "current_ADS.csv", blank)
        tables = golden.build(raw, EMPTY_MANUAL, "r1", fetch_log=support.fetch_log_for(raw))
        crashes = agg.unique_crashes(agg.current_reports(tables))
        keys = {r["incident_key"] for r, _ in crashes}
        self.assertEqual(len(crashes), len(agg.current_reports(tables)) - 1)  # only the SHAREDINCIDENT1 pair merges
        self.assertTrue({"solo:TR-1", "solo:W-1", "solo:AV-1"} <= keys)
        self.assertTrue(all(n == 1 for r, n in crashes if r["incident_key"].startswith("solo:")))

    def test_hostile_text_survives_untouched_and_state_is_trimmed(self):
        raw = support.make_raw_dir(Path(self.tmp.name) / "raw_hostile")
        hostile = '<script>alert("x")</script>\nline 2 with "quotes", commas & <b>tags</b>'

        def plant(rows, fields):
            for row in rows:
                if row["Report ID"] == "W-1":
                    row["Narrative"] = hostile
                    row["State"] = "CA "
        support.edit_csv(raw / "current_ADS.csv", plant)
        tables = golden.build(raw, EMPTY_MANUAL, "r1", fetch_log=support.fetch_log_for(raw))
        outputs, _ = agg.build_all(tables, fetch_log=support.fetch_log_for(raw), run_id="r1", run_at=RUN_AT, today=TODAY)
        self.assertEqual(outputs["narratives.json"]["W-1"], hostile)
        record = dict(zip(outputs["records.json"]["fields"], next(r for r in outputs["records.json"]["rows"] if r[0] == "W-1")))
        self.assertEqual(record["state"], "CA")
        # still plain data: it round-trips through JSON unchanged
        self.assertEqual(json.loads(json.dumps(outputs["narratives.json"]))["W-1"], hostile)

    def test_all_outputs_are_present(self):
        outputs, warnings = agg.build_all(self.tables, fetch_log=support.fetch_log_for(self.raw), run_id="r1", run_at=RUN_AT, today=TODAY)
        self.assertEqual(set(outputs), set(agg.OUTPUT_FILES))
        for name in ("records.json", "narratives.json", "counts.json", "lag.json", "exposure.json", "company_reported.json",
                     "sources.json", "investigations.json", "events.json", "rules.json", "transparency.json", "meta.json",
                     "changelog.json"):
            self.assertIn(name, outputs)
        self.assertEqual(outputs["rules.json"]["rules"], classify.RULES)
        meta = outputs["meta.json"]
        self.assertEqual(meta["nhtsa_last_modified"], "2026-11-16")  # the site reads this as one date
        self.assertEqual(set(meta["nhtsa_last_modified_by_file"]), {s["key"] for s in support.config.SGO_FILES})
        self.assertEqual(meta["rules_version"], golden.RULES_VERSION)
        self.assertEqual(meta["run_at"], RUN_AT)
        self.assertIs(meta["offline"], False)
        self.assertEqual(meta["placeholders_skipped"], meta["placeholder_rows_skipped"])
        self.assertEqual(meta["total_reports"], meta["counts_total"]["reports"])
        self.assertEqual(meta["total_incidents"], meta["counts_total"]["incidents"])
        self.assertIsInstance(warnings, list)

    def test_offline_flag_and_note_in_meta(self):
        outputs, _ = agg.build_all(self.tables, fetch_log=support.fetch_log_for(self.raw), run_id="r1", run_at=RUN_AT, today=TODAY, offline=True)
        meta = outputs["meta.json"]
        self.assertIs(meta["offline"], True)
        self.assertIn("not re-verified", meta["offline_note"])

    def test_write_all_sorts_keys_and_refuses_nan(self):
        out_dir = Path(self.tmp.name) / "sorted"
        agg.write_all({"a.json": {"b": 1, "a": 2}}, out_dir)
        self.assertEqual((out_dir / "a.json").read_text(), '{"a":2,"b":1}\n')
        with self.assertRaises(ValueError):
            agg.write_all({"bad.json": {"x": float("nan")}}, out_dir)
        self.assertFalse((out_dir / "bad.json").exists())
        self.assertEqual([p.name for p in out_dir.iterdir()], ["a.json"])  # no temp file left behind

    def test_write_all_is_atomic_and_complete(self):
        outputs, _ = agg.build_all(self.tables, fetch_log=support.fetch_log_for(self.raw), run_id="r1", run_at=RUN_AT, today=TODAY)
        out_dir = Path(self.tmp.name) / "out"
        agg.write_all(outputs, out_dir)
        self.assertEqual(sorted(p.name for p in out_dir.iterdir()), sorted(outputs))
        self.assertEqual(json.loads((out_dir / "counts.json").read_text(encoding="utf-8")), outputs["counts.json"])


class ChangelogTests(unittest.TestCase):
    def test_new_revised_and_removed_reports(self):
        before = [rec("A", "a"), rec("B", "b"), rec("C", "c"), rec("P", "p", is_placeholder=True)]
        after = [
            rec("A", "a"),                                              # unchanged
            rec("B", "b", row_hash="changed"),                          # revised in place
            dict(rec("C", "c"), is_latest=False),                       # v1 superseded ...
            rec("C", "c", report_key="C|v2", version=2, row_hash="c2"), # ... by v2: revised
            rec("D", "d"),                                              # new
            rec("P2", "p2", is_placeholder=True),                       # placeholders are not reports
        ]
        removed = rec("E", "e", removed_in_run="r2")
        entry = agg.changelog_entry(tables_of(before + [rec("E", "e")]), tables_of(after + [removed]), "r2", RUN_AT)
        self.assertEqual(entry, {"run_id": "r2", "run_at": RUN_AT, "new_reports": 1, "revised_reports": 2, "removed_reports": 1})

    def test_changelog_prepends_and_same_run_is_a_no_op(self):
        entry = {"run_id": "r2", "run_at": RUN_AT, "new_reports": 3, "revised_reports": 0, "removed_reports": 0}
        old = {"entries": [{"run_id": "r1", "run_at": "2026-10-01T00:00:00Z", "new_reports": 9, "revised_reports": 1, "removed_reports": 0}]}
        merged = agg.merge_changelog(old, entry)
        self.assertEqual([e["run_id"] for e in merged["entries"]], ["r2", "r1"])
        again = agg.merge_changelog(merged, dict(entry, new_reports=0))
        self.assertEqual(again, merged)  # rebuilding the same run changes nothing
        self.assertEqual(agg.merge_changelog(None, entry)["entries"], [entry])


class ExposureOutputTests(unittest.TestCase):
    def test_exposure_json_rows_and_labels(self):
        rows = [{
            "company": "waymo", "program": "waymo_ads", "region": "us", "period": "2025-06-30", "period_type": "cumulative_to",
            "metric": "active_vehicles", "value": 100, "kind": "estimate", "source_id": "s1", "source_ids": ["s1"], "method_note": "n",
        }]
        outputs, _ = agg.build_all(tables_of([], exposure=rows), fetch_log=[], run_id="r", run_at=RUN_AT, today=TODAY)
        out = outputs["exposure.json"]
        self.assertTrue(out["rows"])
        self.assertEqual({r["metric"] for r in out["rows"]}, {"active_vehicles"})
        self.assertIn("recall_units", out["metrics"])


if __name__ == "__main__":
    unittest.main()
