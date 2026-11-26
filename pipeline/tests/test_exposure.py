import datetime
import math
import unittest

from pipeline import exposure

TODAY = datetime.date(2026, 11, 26)


def row(period, period_type, metric, value, kind="reported", program="waymo_ads", region="us", source_id="s1", note="note"):
    return {
        "company": program.split("_")[0], "program": program, "region": region, "period": period,
        "period_type": period_type, "metric": metric, "value": value, "kind": kind,
        "source_id": source_id, "source_ids": source_id.split(";"), "method_note": note,
    }


def cum(date, value, kind="reported", source_id="s1", **kw):
    return row(date, "cumulative_to", "cum_miles", value, kind=kind, source_id=source_id, **kw)


def normalize(rows, today=TODAY):
    out, warnings = exposure.normalize(rows, today)
    return {(r["program"], r["region"], r["metric"], r["period"]): r for r in out}, warnings


class FlowTests(unittest.TestCase):
    def test_quarters_sum_to_year_with_weakest_kind(self):
        rows = [
            row("2023-Q1", "quarter", "miles", 100, "reported", source_id="a"),
            row("2023-Q2", "quarter", "miles", 110, "reported", source_id="b"),
            row("2023-Q3", "quarter", "miles", 120, "derived", source_id="c"),
            row("2023-Q4", "quarter", "miles", 130, "reported", source_id="d"),
        ]
        out, _ = normalize(rows)
        year = out[("waymo_ads", "us", "miles", "2023")]
        self.assertEqual(year["value"], 460)
        self.assertEqual(year["kind"], "derived")
        self.assertEqual(year["source_ids"], ["a", "b", "c", "d"])
        self.assertIn("quarters", year["method"])

    def test_estimate_quarter_makes_year_estimate(self):
        rows = [row("2023-Q%d" % q, "quarter", "miles", 100, "estimate" if q == 2 else "reported") for q in (1, 2, 3, 4)]
        out, _ = normalize(rows)
        self.assertEqual(out[("waymo_ads", "us", "miles", "2023")]["kind"], "estimate")

    def test_missing_quarters_are_extrapolated_and_marked_estimate(self):
        rows = [row("2023-Q1", "quarter", "miles", 100), row("2023-Q2", "quarter", "miles", 200), row("2023-Q3", "quarter", "miles", 300)]
        out, _ = normalize(rows)
        year = out[("waymo_ads", "us", "miles", "2023")]
        self.assertEqual(year["value"], 800)  # mean of 3 present quarters x 4
        self.assertEqual(year["kind"], "estimate")
        self.assertIn("Q4", year["method"])
        self.assertIn("extrapolat", year["method"].lower())

    def test_year_row_passes_through_and_beats_quarters(self):
        rows = [row("2022", "year", "miles", 2900144, "derived", region="ca", source_id="ca_dmv", note="CA DMV")]
        out, _ = normalize(rows)
        r = out[("waymo_ads", "ca", "miles", "2022")]
        self.assertEqual((r["value"], r["kind"], r["source_ids"], r["method"]), (2900144, "derived", ["ca_dmv"], "CA DMV"))

    def test_cum_miles_delta_between_year_end_disclosures(self):
        rows = [cum("2024-12-31", 100_000_000, "derived", "d24"), cum("2025-12-31", 250_000_000, "reported", "d25")]
        out, _ = normalize(rows)
        year = out[("waymo_ads", "us", "miles", "2025")]
        self.assertEqual(year["value"], 150_000_000)
        self.assertEqual(year["kind"], "derived")
        self.assertEqual(sorted(year["source_ids"]), ["d24", "d25"])
        self.assertNotIn(("waymo_ads", "us", "miles", "2024"), out)  # nothing before the first disclosure

    def test_months_interpolate_linearly_by_day_and_sum_to_the_year(self):
        rows = [cum("2024-12-31", 0), cum("2025-12-31", 365_000)]
        out, _ = normalize(rows)
        jan = out[("waymo_ads", "us", "miles", "2025-01")]
        feb = out[("waymo_ads", "us", "miles", "2025-02")]
        self.assertAlmostEqual(jan["value"], 31_000)
        self.assertAlmostEqual(feb["value"], 28_000)
        self.assertEqual(jan["kind"], "estimate")
        self.assertIn("interpolat", jan["method"])
        months = sum(out[("waymo_ads", "us", "miles", "2025-%02d" % m)]["value"] for m in range(1, 13))
        self.assertAlmostEqual(months, out[("waymo_ads", "us", "miles", "2025")]["value"])

    def test_interpolation_names_the_gap_and_long_gaps_are_low_confidence(self):
        short = [cum("2025-01-01", 0), cum("2025-04-01", 900)]
        out, _ = normalize(short)
        method = out[("waymo_ads", "us", "miles", "2025-02")]["method"]
        self.assertIn("gap of 90 days", method)
        self.assertNotIn("low confidence", method)
        long_gap = [cum("2023-02-22", 0), cum("2024-12-31", 6780)]
        gap = (datetime.date(2024, 12, 31) - datetime.date(2023, 2, 22)).days
        out, _ = normalize(long_gap)
        row_ = out[("waymo_ads", "us", "miles", "2024-06")]
        self.assertIn("interpolated across a gap of %d days, low confidence" % gap, row_["method"])
        self.assertEqual(row_["kind"], "estimate")  # emitted, not dropped, and still an estimate
        edge = [cum("2025-01-01", 0), cum("2026-06-25", 5400)]  # exactly 540 days
        out, _ = normalize(edge)
        self.assertNotIn("low confidence", out[("waymo_ads", "us", "miles", "2025-06")]["method"])

    def test_month_between_two_month_end_disclosures_is_derived(self):
        rows = [cum("2025-01-31", 1000, source_id="j"), cum("2025-02-28", 1800, source_id="f"), cum("2025-04-30", 3000, source_id="a")]
        out, _ = normalize(rows)
        feb = out[("waymo_ads", "us", "miles", "2025-02")]
        self.assertEqual(feb["value"], 800)
        self.assertEqual(feb["kind"], "derived")
        self.assertEqual(sorted(feb["source_ids"]), ["f", "j"])
        mar = out[("waymo_ads", "us", "miles", "2025-03")]
        self.assertEqual(mar["kind"], "estimate")  # boundary on 02-28 is a disclosure, 03-31 is interpolated
        self.assertNotIn(("waymo_ads", "us", "miles", "2025-01"), out)  # starts before the first disclosure

    def test_partial_year_has_no_annual_row_but_has_months(self):
        rows = [cum("2024-06-30", 0), cum("2024-12-31", 1840)]
        out, _ = normalize(rows)
        self.assertNotIn(("waymo_ads", "us", "miles", "2024"), out)
        self.assertIn(("waymo_ads", "us", "miles", "2024-07"), out)
        self.assertNotIn(("waymo_ads", "us", "miles", "2024-06"), out)

    def test_estimate_kind_propagates_through_cum_miles(self):
        rows = [cum("2024-12-31", 0, "estimate", "e1"), cum("2025-12-31", 1000, "reported", "r1")]
        out, _ = normalize(rows)
        self.assertEqual(out[("waymo_ads", "us", "miles", "2025")]["kind"], "estimate")

    def test_decreasing_cumulative_miles_warns_and_gives_no_rows_for_that_segment(self):
        rows = [cum("2024-12-31", 500), cum("2025-12-31", 400)]
        out, warnings = normalize(rows)
        self.assertEqual([k for k in out if k[2] == "miles"], [])
        self.assertTrue(any("decreas" in w for w in warnings))

    NOTE = "adjacent disclosure segments differ by >3\u00d7; disclosures are rounded milestones, so the monthly split is unreliable"

    def spiky(self):
        # daily rates: 100/105 d = 0.95, 200/40 d = 5.0, 100/220 d = 0.45
        return [cum("2024-12-31", 100), cum("2025-04-15", 200), cum("2025-05-25", 400), cum("2025-12-31", 500)]

    def test_adjacent_segments_over_3x_flag_the_months_of_the_short_segment(self):
        out, warnings = normalize(self.spiky())
        for month in ("2025-04", "2025-05"):
            self.assertIn(self.NOTE, out[("waymo_ads", "us", "miles", month)]["method"], month)
        for month in ("2025-02", "2025-03", "2025-07", "2025-12"):
            self.assertNotIn(self.NOTE, out[("waymo_ads", "us", "miles", month)]["method"], month)
        flagged = [w for w in warnings if "differ" in w]
        self.assertEqual(len(flagged), 1)
        for needle in ("waymo_ads", "2025-04", "2025-05", "3"):
            self.assertIn(needle, flagged[0])
        self.assertNotIn("2025-07", flagged[0])

    def test_the_flag_changes_no_value_and_leaves_annual_rows_alone(self):
        flagged, _ = normalize(self.spiky())
        calm, _ = normalize([cum("2024-12-31", 100), cum("2025-04-15", 200), cum("2025-05-25", 300), cum("2025-12-31", 400)])
        year = flagged[("waymo_ads", "us", "miles", "2025")]
        self.assertEqual(year["value"], 400)
        self.assertNotIn("3\u00d7", year["method"])
        self.assertEqual(flagged[("waymo_ads", "us", "miles", "2025-04")]["value"],
                         round(100 * 15 / 105 + 200 * 15 / 40))

    def test_segments_within_3x_are_not_flagged(self):
        rows = [cum("2025-01-01", 0), cum("2025-04-11", 100), cum("2025-06-30", 280), cum("2025-12-27", 640)]
        out, warnings = normalize(rows)  # 1, 2.25 and 2 miles a day
        self.assertFalse([w for w in warnings if "differ" in w])
        self.assertTrue(all(self.NOTE not in r["method"] for r in out.values()))

    def test_a_drop_in_rate_is_flagged_too(self):
        rows = [cum("2024-12-31", 0), cum("2025-02-01", 320), cum("2025-02-21", 340), cum("2025-12-31", 640)]
        out, warnings = normalize(rows)  # 10/day, 1/day, 0.31/day
        self.assertIn(self.NOTE, out[("waymo_ads", "us", "miles", "2025-02")]["method"])
        self.assertTrue([w for w in warnings if "differ" in w])

    def test_even_growth_has_no_flag(self):
        rows = [cum("2024-12-31", 0), cum("2025-04-01", 900), cum("2025-08-01", 2100), cum("2025-12-31", 3600)]
        out, warnings = normalize(rows)  # 10, 9.8, 10.6 per day
        self.assertFalse([w for w in warnings if "differ" in w])
        self.assertTrue(all(self.NOTE not in r["method"] for r in out.values()))

    def test_zero_growth_segment_is_skipped_not_divided(self):
        rows = [cum("2024-12-31", 100), cum("2025-04-01", 100), cum("2025-12-31", 900)]
        out, warnings = normalize(rows)
        self.assertFalse([w for w in warnings if "differ" in w])

    def test_zero_or_missing_exposure_makes_no_row(self):
        rows = [
            cum("2024-12-31", 100), cum("2025-12-31", 100),  # zero delta
            row("2025", "year", "miles", 0, program="zoox_ads"),
            row("2025-06-30", "cumulative_to", "active_vehicles", 0, program="zoox_ads"),
            row("2025-06-30", "cumulative_to", "subscribers", None, program="zoox_ads"),
        ]
        out, _ = normalize(rows)
        self.assertEqual(out, {})
        for r in out.values():
            self.assertTrue(math.isfinite(r["value"]) and r["value"] > 0)


class StockTests(unittest.TestCase):
    def test_mean_of_observations_in_period(self):
        rows = [
            row("2025-03-31", "cumulative_to", "active_vehicles", 100, "reported", source_id="a"),
            row("2025-09-30", "cumulative_to", "active_vehicles", 300, "estimate", source_id="b"),
        ]
        out, _ = normalize(rows)
        year = out[("waymo_ads", "us", "active_vehicles", "2025")]
        self.assertEqual(year["value"], 200)
        self.assertEqual(year["kind"], "estimate")
        self.assertEqual(year["source_ids"], ["a", "b"])
        self.assertIn("mean", year["method"].lower())
        self.assertEqual(out[("waymo_ads", "us", "active_vehicles", "2025-03")]["value"], 100)
        self.assertEqual(out[("waymo_ads", "us", "active_vehicles", "2025-03")]["kind"], "reported")

    def test_mean_of_several_observations_is_derived_a_single_one_keeps_its_kind(self):
        rows = [
            row("2025-03-31", "cumulative_to", "subscribers", 100, "reported", source_id="a"),
            row("2025-09-30", "cumulative_to", "subscribers", 300, "reported", source_id="b"),
            row("2024-06-30", "cumulative_to", "subscribers", 50, "reported", source_id="c"),
        ]
        out, _ = normalize(rows)
        self.assertEqual(out[("waymo_ads", "us", "subscribers", "2025")]["kind"], "derived")
        self.assertEqual(out[("waymo_ads", "us", "subscribers", "2024")]["kind"], "reported")
        self.assertEqual(out[("waymo_ads", "us", "subscribers", "2025-03")]["kind"], "reported")

    def test_carry_forward_at_most_twelve_months(self):
        rows = [row("2025-03-31", "cumulative_to", "subscribers", 500, "reported", source_id="a")]
        out, _ = normalize(rows)
        carried = out[("waymo_ads", "us", "subscribers", "2025-12")]
        self.assertEqual(carried["value"], 500)
        self.assertEqual(carried["kind"], "estimate")
        self.assertIn("carried forward from 2025-03-31", carried["method"])
        self.assertIn(("waymo_ads", "us", "subscribers", "2026-03"), out)  # exactly 12 months after the observation
        self.assertNotIn(("waymo_ads", "us", "subscribers", "2026-04"), out)
        self.assertNotIn(("waymo_ads", "us", "subscribers", "2024-12"), out)  # never before the first disclosure
        self.assertNotIn(("waymo_ads", "us", "subscribers", "2026"), out)  # a period that outlives the carry limit
        self.assertEqual(out[("waymo_ads", "us", "subscribers", "2025")]["kind"], "reported")  # in-period observation

    def test_recall_units_never_become_a_fleet_size(self):
        rows = [row("2025-05-12", "cumulative_to", "recall_units", 1212, source_id="rcl")]
        out, _ = normalize(rows)
        self.assertEqual({k[2] for k in out}, {"recall_units"})
        self.assertEqual(out[("waymo_ads", "us", "recall_units", "2025-05")]["value"], 1212)
        self.assertIn("recall", out[("waymo_ads", "us", "recall_units", "2025-05")]["method"].lower())

    def test_regions_are_separate_series(self):
        rows = [
            row("2025", "year", "miles", 10, region="ca"),
            row("2025-06-30", "cumulative_to", "active_vehicles", 7, region="us"),
            row("2025-06-30", "cumulative_to", "active_vehicles", 9, region="global"),
        ]
        out, _ = normalize(rows)
        self.assertEqual(out[("waymo_ads", "ca", "miles", "2025")]["value"], 10)
        self.assertEqual(out[("waymo_ads", "us", "active_vehicles", "2025")]["value"], 7)
        self.assertEqual(out[("waymo_ads", "global", "active_vehicles", "2025")]["value"], 9)
        self.assertNotIn(("waymo_ads", "us", "miles", "2025"), out)

    def test_nothing_after_today(self):
        rows = [row("2026-03-18", "cumulative_to", "active_vehicles", 5)]
        out, _ = normalize(rows, today=datetime.date(2026, 5, 10))
        self.assertIn(("waymo_ads", "us", "active_vehicles", "2026-05"), out)
        self.assertNotIn(("waymo_ads", "us", "active_vehicles", "2026-06"), out)

    def test_every_row_is_traceable(self):
        rows = [cum("2024-12-31", 0, source_id="x"), cum("2025-12-31", 10, source_id="y"),
                row("2025-06-30", "cumulative_to", "subscribers", 3, source_id="z")]
        out, _ = normalize(rows)
        for r in out.values():
            self.assertTrue(r["source_ids"])
            self.assertTrue(r["method"])
            self.assertIn(r["kind"], ("reported", "derived", "estimate"))
            self.assertEqual(set(r), {"program", "period", "region", "metric", "value", "kind", "source_ids", "method"})


if __name__ == "__main__":
    unittest.main()
