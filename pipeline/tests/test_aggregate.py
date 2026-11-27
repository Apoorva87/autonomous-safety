import copy
import datetime
import json
import tempfile
from collections import Counter
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
        "hospitalized": None, "airbag": None, "towed": None, "within_odd": "yes", "driver_operator_type": "none", "narrative_redacted": False,
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
        reports = [rec("1", "a", submitted="2025-01-31"), rec("2", "b", submitted=None), rec("3", "c", program="other_ads", submitted="2025-02-28")]
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
        self.assertEqual(set(waymo), {"program", "company", "month", "file", "reports", "crashes", "robust_crashes", "fatal", "serious_plus", "injury", "vru", "vru_field"})
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
        current = agg.current_reports(tables_of([
            rec("1", "K", crash_with="pedestrian", tags=[{"t": "vru", "basis": "field", "rule": "VRU-1"}], speed_band="6-15")]))
        out = agg.build_records(agg.program_incidents(current), agg.programs_per_incident(current))
        self.assertEqual(out["fields"], agg.RECORD_FIELDS)
        self.assertNotIn("narrative", out["fields"])
        self.assertNotIn("secret text", json.dumps(out))
        row = dict(zip(out["fields"], out["rows"][0]))
        self.assertEqual(row["id"], "1")
        self.assertIn("vru:f", row["tags"])
        self.assertEqual(row["speed_band"], "6-15")
        self.assertEqual(row["n_reports"], 1)
        self.assertEqual((row["n_programs_in_incident"], row["operator"]), (1, "none"))

    def test_records_are_one_row_per_program_and_incident_with_the_programs_own_report(self):
        reports = [
            rec("1", "K", "minor", program="waymo_ads", entity="Waymo LLC", city="Phoenix", driver_operator_type="none"),
            rec("2", "K", "serious", program="other_ads", entity="Transdev", city="Tempe", state="AZ", driver_operator_type="in_vehicle"),
            rec("3", "J", "none", program="waymo_ads", entity="Waymo LLC", driver_operator_type="remote"),
            rec("4", "J", "fatal", program="waymo_ads", entity="Waymo LLC", driver_operator_type="in_vehicle"),
        ]
        current = agg.current_reports(tables_of(reports))
        out = agg.build_records(agg.program_incidents(current), agg.programs_per_incident(current))
        rows = [dict(zip(out["fields"], r)) for r in out["rows"]]
        self.assertEqual(len(rows), 3)  # K under two programs, J under one
        by = {(r["incident_key"], r["program"]): r for r in rows}
        w, o = by[("K", "waymo_ads")], by[("K", "other_ads")]
        # each row carries its own program's report: entity, city, severity are not borrowed from the other program
        self.assertEqual((w["id"], w["entity"], w["city"], w["severity"], w["operator"]), ("1", "Waymo LLC", "Phoenix", "minor", "none"))
        self.assertEqual((o["id"], o["entity"], o["city"], o["severity"], o["operator"]), ("2", "Transdev", "Tempe", "serious", "in_vehicle"))
        self.assertEqual((w["n_programs_in_incident"], o["n_programs_in_incident"]), (2, 2))
        j = by[("J", "waymo_ads")]
        self.assertEqual((j["id"], j["severity"], j["n_reports"], j["n_programs_in_incident"]), ("4", "fatal", 2, 1))

    def test_two_entities_of_one_program_share_a_row_and_both_are_listed(self):
        reports = [
            rec("1", "K", "minor", program="other_l2", entity="Ford", kind="ADAS"),
            rec("2", "K", "none", program="other_l2", entity="GM LLC", kind="ADAS"),
            rec("3", "J", "none", program="other_l2", entity="Ford", kind="ADAS"),
        ]
        current = agg.current_reports(tables_of(reports))
        out = agg.build_records(agg.program_incidents(current), agg.programs_per_incident(current))
        rows = {r[1]: dict(zip(out["fields"], r)) for r in out["rows"]}
        self.assertEqual(rows["K"]["entities"], ["Ford", "GM LLC"])
        self.assertEqual(rows["K"]["n_reports"], 2)
        per_entity = Counter(e for r in rows.values() for e in r["entities"])
        self.assertEqual(per_entity, Counter({"Ford": 2, "GM LLC": 1}))  # what each entity filed, by incident

    def test_program_totals_in_records_equal_counts_json_per_program_and_month(self):
        reports = [
            rec("1", "K", "minor", program="waymo_ads", month="2025-01"),
            rec("2", "K", "serious", program="other_ads", month="2025-02", kind="ADAS", entity="Transdev"),
            rec("3", "J", "none", program="waymo_ads", month="2025-01"),
            rec("4", "J", "fatal", program="waymo_ads", month="2025-03"),
            rec("5", "S", "minor", program="tesla_l2", kind="ADAS", month=None),
        ]
        current = agg.current_reports(tables_of(reports))
        out = agg.build_records(agg.program_incidents(current), agg.programs_per_incident(current))
        rows = [dict(zip(out["fields"], r)) for r in out["rows"]]
        got = Counter((r["program"], r["month"]) for r in rows)
        want = Counter()
        for r in agg.build_counts(current)["rows"]:
            want[(r["program"], r["month"])] += r["crashes"]
        self.assertEqual(got, want)

    def test_record_tags_are_the_union_over_the_programs_own_reports(self):
        reports = [
            rec("1", "K", "minor", tags=[{"t": "vru", "basis": "narrative", "rule": "VRU-2"}]),
            rec("2", "K", "serious", tags=[{"t": "low_speed", "basis": "field", "rule": "LS-1"}, {"t": "vru", "basis": "field", "rule": "VRU-1"}]),
        ]
        current = agg.current_reports(tables_of(reports))
        out = agg.build_records(agg.program_incidents(current), agg.programs_per_incident(current))
        row = dict(zip(out["fields"], out["rows"][0]))
        self.assertEqual(sorted(row["tags"]), ["low_speed:f", "vru:f"])  # a field basis beats a narrative basis
        self.assertEqual(agg.build_counts(current)["rows"][0]["vru"], 1)

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

    def test_lag_is_in_whole_months_per_regime_and_not_pooled(self):
        def sub(month, lag):
            y, m = int(month[:4]), int(month[5:]) + lag
            y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
            return "%04d-%02d-28" % (y, m)
        reports = []
        # current era (post): incidents 2026-01..2026-06, data through 2026-06
        for i, (month, lag) in enumerate([("2026-01", 0), ("2026-01", 2), ("2026-02", 0), ("2026-02", 1), ("2026-03", 0),
                                          ("2026-04", 0), ("2026-05", 0), ("2026-06", 0)]):
            reports.append(rec("c%d" % i, "c%d" % i, month=month, submitted=sub(month, lag)))
        # archive era (pre): slow filer
        for i, (month, lag) in enumerate([("2024-01", 0), ("2024-01", 1), ("2024-02", 1), ("2024-03", 3)]):
            reports.append(rec("a%d" % i, "a%d" % i, month=month, submitted=sub(month, lag), era="archive"))
        reports.append(rec("x", "x", month=None, submitted=None))  # no lag: not in the distribution
        lag = agg.build_lag(agg.current_reports(tables_of(reports)))
        self.assertEqual(lag["resolution"], "month")
        self.assertEqual(lag["months"], list(range(0, 13)))
        self.assertIs(lag["pooled"], False)
        self.assertNotIn("days", lag)
        waymo = lag["programs"]["waymo_ads"]
        self.assertEqual(waymo["n_reports"], 13)
        post, pre = waymo["regimes"]["post"], waymo["regimes"]["pre"]
        self.assertEqual((post["n"], pre["n"]), (8, 4))
        for cdf in (post["cdf"], pre["cdf"]):
            self.assertEqual(len(cdf), 13)
            self.assertEqual(cdf, sorted(cdf))
            self.assertEqual(cdf[-1], 1.0)
        self.assertLess(post["cdf"][0], 1.0)
        self.assertGreater(post["cdf"][0], pre["cdf"][0])  # the regimes differ and are kept apart
        # the late-report histogram by severity group adds up to the regime's reports
        self.assertEqual(sum(sum(v) for v in waymo["hist"]["post"].values()), 8)

    def test_chain_ladder_completeness(self):
        # three incidents per month for months 0..2, all observed to month 4; lags 0, 0, 1 each month
        pairs = [(m, lag) for m in range(3) for lag in (0, 0, 1)]
        cdf = agg.chain_ladder_cdf(pairs, last=4, horizon=3)
        self.assertEqual(cdf[-1], 1.0)
        self.assertAlmostEqual(cdf[0], 2 / 3, places=4)
        self.assertEqual(cdf[1], 1.0)


class RegimeExportTests(unittest.TestCase):
    def records_of(self, reports):
        current = agg.crash_reports(tables_of(reports))
        out = agg.build_records(agg.program_incidents(current), agg.programs_per_incident(current))
        return {r[0]: dict(zip(out["fields"], r)) for r in out["rows"]}

    def test_records_carry_the_robust_class_as_a_union_over_the_programs_reports(self):
        reports = [
            rec("1", "K", airbag=None), rec("2", "K", towed=True),              # same Waymo incident: robust via report 2
            rec("3", "J"),                                                      # minor contact: not robust
            rec("4", "T", program="tesla_l2", towed=True, kind="ADAS"),         # L2 tow-only: not robust
            rec("5", "U", program="tesla_l2", airbag=True, kind="ADAS"),
        ]
        rows = self.records_of(reports)
        self.assertEqual({k: v["robust"] for k, v in rows.items()}, {"1": True, "3": False, "4": False, "5": True})

    def test_counts_have_robust_crashes(self):
        reports = [rec("1", "K", severity="minor"), rec("2", "J"), rec("3", "L", crash_with="pedestrian")]
        rows = agg.build_counts(agg.crash_reports(tables_of(reports)))["rows"]
        self.assertEqual(sum(r["robust_crashes"] for r in rows), 2)
        self.assertEqual(sum(r["crashes"] for r in rows), 3)

    def test_records_carry_hour_and_light(self):
        reports = [
            rec("1", "a", incident_time="02:15", month="2025-07"),
            rec("2", "b", incident_time="12:00", lighting="dark_lighted", era="archive", month="2024-07"),
            rec("3", "c", incident_time=None),
        ]
        rows = self.records_of(reports)
        self.assertEqual((rows["1"]["hour"], rows["1"]["light_condition"], rows["1"]["light_condition_basis"]), (2, "night", "derived from time"))
        self.assertEqual((rows["2"]["light_condition"], rows["2"]["light_condition_basis"], rows["2"]["light_from_time"]), ("night", "recorded", "day"))
        self.assertEqual((rows["3"]["hour"], rows["3"]["light_condition"], rows["3"]["light_condition_basis"]), (None, "unknown", None))

    def test_tesla_hours_are_local_after_converting_from_utc(self):
        reports = [rec("1", "a", entity="Tesla, Inc.", program="tesla_l2", kind="ADAS", incident_time="22:30", state="CA", month="2025-07"),
                   rec("2", "b", entity="Waymo LLC", incident_time="22:30", state="CA", month="2025-07")]
        rows = self.records_of(reports)
        self.assertEqual((rows["1"]["hour"], rows["1"]["time_basis"], rows["1"]["light_from_time"]), (15, "utc", "day"))
        self.assertEqual((rows["2"]["hour"], rows["2"]["time_basis"]), (22, "filed"))

    def test_verified_not_engaged_reports_are_not_program_crashes(self):
        reports = [
            rec("1", "K"), rec("2", "J", engagement_status="verified_not_engaged"),
            rec("3", "L", engagement_status="alleged_engaged"),
            rec("4", "M", engagement_status="verified_not_engaged", program="tesla_l2", kind="ADAS"),
        ]
        tables = tables_of(reports, incidents=[{"incident_key": k} for k in "KJLM"])
        self.assertEqual({r["report_id"] for r in agg.crash_reports(tables)}, {"1", "3"})
        self.assertEqual(len(agg.current_reports(tables)), 4)
        summary = agg.not_engaged_summary(agg.current_reports(tables))
        self.assertEqual(summary["total"], 2)
        self.assertEqual(summary["by_program"], {"tesla_l2": 1, "waymo_ads": 1})
        self.assertEqual(summary["report_ids"], ["2", "4"])
        outputs, _ = agg.build_all(tables, fetch_log=[], run_id="r", run_at=RUN_AT, today=TODAY)
        self.assertEqual(len(outputs["records.json"]["rows"]), 2)
        self.assertEqual(outputs["meta.json"]["not_engaged"]["total"], 2)
        self.assertEqual(sum(r["crashes"] for r in outputs["counts.json"]["rows"]), 2)
        self.assertEqual(validate.check_outputs(outputs, tables), [])
        self.assertIn("robust_definition", outputs["meta.json"])
        self.assertIn("light_rule", outputs["meta.json"])


class RevisionTests(unittest.TestCase):
    def test_revision_shares_and_unknown_fields_first_vs_latest(self):
        unknown = {"sv_movement": "reported_unknown", "crash_with": "reported_unknown", "cp_movement": "reported_unknown",
                   "sv_contact_areas": "reported_unknown", "roadway_type": "reported_unknown", "speed_mph": "reported_unknown",
                   "severity": "reported_unknown"}
        known = {k: "provided" for k in unknown}
        reports = [
            # T1: a stub first version, filled in by v2 two months later
            rec("T1", "a", program="tesla_l2", month="2024-05", status=unknown, is_latest=False, submitted="2024-05-31"),
            rec("T1", "a", program="tesla_l2", month="2024-05", status=known, report_key="T1|v2", version=2, submitted="2024-07-31"),
            # T2: never revised, everything unknown
            rec("T2", "b", program="tesla_l2", month="2024-05", status=unknown, submitted="2024-05-31"),
            # T3: never revised, known
            rec("T3", "c", program="tesla_l2", month="2024-05", status=known, submitted="2024-05-31"),
            # placeholders and removed rows are ignored
            rec("P", "p", program="tesla_l2", month="2024-05", is_placeholder=True, status=known),
            rec("R", "r", program="tesla_l2", month="2024-05", removed_in_run="r0", is_latest=False, status=known),
        ]
        out = agg.build_revisions(tables_of(reports))
        self.assertEqual(out["fields"][:3], ["sv_movement", "crash_with", "cp_movement"])
        rows = [r for r in out["rows"] if r["program"] == "tesla_l2"]
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual((row["month"], row["reports"], row["revised"], row["versions"]), ("2024-05", 3, 1, 4))
        i = out["fields"].index("sv_movement")
        self.assertEqual(row["first_unknown_revised"][i], 1)
        self.assertEqual(row["latest_unknown_revised"][i], 0)
        self.assertEqual(row["unknown_single"][i], 1)
        self.assertEqual(row["unknown_latest"][i], 1)
        self.assertEqual(row["all_unknown_latest"], 1)
        self.assertEqual(row["all_unknown_first_revised"], 1)
        self.assertEqual(row["gap_months"], {"2": 1})
        self.assertEqual(out["total_reports"], 3)


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
        # records are one row per (program, incident): at least the unique incidents, exactly the program-level crashes
        self.assertGreaterEqual(len(outputs["records.json"]["rows"]), unique)
        self.assertEqual(len(outputs["records.json"]["rows"]), sum(r["crashes"] for r in outputs["counts.json"]["rows"]))
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
