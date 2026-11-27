import unittest

from pipeline import derive


def r(**kw):
    base = {"program": "waymo_ads", "severity": "none", "airbag": False, "towed": False, "crash_with": "suv",
            "cp_movement": "proceeding_straight", "lighting": None, "incident_time": None, "month": "2025-07", "state": "CA"}
    base.update(kw)
    return base


class RobustClassTests(unittest.TestCase):
    def test_minor_ads_contact_is_not_robust(self):
        self.assertFalse(derive.is_robust(r()))
        self.assertEqual(derive.robust_criteria(r()), [])

    def test_each_ads_criterion_counts(self):
        self.assertEqual(derive.robust_criteria(r(severity="minor")), ["injury"])
        self.assertEqual(derive.robust_criteria(r(severity="fatal")), ["fatality"])
        self.assertEqual(derive.robust_criteria(r(airbag=True)), ["airbag"])
        self.assertEqual(derive.robust_criteria(r(towed=True)), ["towed"])
        self.assertEqual(derive.robust_criteria(r(crash_with="cyclist")), ["vru"])
        self.assertEqual(derive.robust_criteria(r(crash_with="other", cp_movement="nm_crossing")), ["vru"])
        self.assertEqual(derive.robust_criteria(r(severity="serious", airbag=True, towed=True)), ["injury", "airbag", "towed"])

    def test_tow_away_alone_is_not_robust_for_level_2(self):
        self.assertFalse(derive.is_robust(r(program="tesla_l2", towed=True)))
        self.assertTrue(derive.is_robust(r(program="tesla_l2", airbag=True)))
        self.assertTrue(derive.is_robust(r(program="gm_supercruise", severity="moderate")))
        self.assertTrue(derive.is_robust(r(program="other_l2", crash_with="pedestrian")))

    def test_unknown_fields_do_not_count(self):
        self.assertFalse(derive.is_robust(r(severity="unknown", airbag=None, towed=None, crash_with="unknown")))

    def test_motorcycle_is_not_a_vru(self):
        self.assertFalse(derive.is_robust(r(crash_with="motorcycle")))

    def test_the_group_can_be_passed_explicitly(self):
        self.assertTrue(derive.is_robust(r(program="x", towed=True), derive.ADS_GROUP))
        self.assertFalse(derive.is_robust(r(program="x", towed=True), derive.L2_GROUP))

    def test_definition_is_published_with_its_uncertainty(self):
        d = derive.ROBUST_DEFINITION
        self.assertTrue(d["ads"] and d["l2"] and d["why"])
        self.assertGreaterEqual(len(d["uncertainty"]), 3)


class LightTests(unittest.TestCase):
    def test_hour_and_minutes(self):
        self.assertEqual(derive.hour_of("09:05"), 9)
        self.assertEqual(derive.hour_of("23:59"), 23)
        self.assertIsNone(derive.hour_of(None))
        self.assertIsNone(derive.hour_of("25:00"))
        self.assertIsNone(derive.hour_of("bad"))

    def test_noon_is_day_and_three_am_is_night_every_month(self):
        for m in range(1, 13):
            month = "2025-%02d" % m
            self.assertEqual(derive.light_from_time("12:30", month, "CA"), "day", month)
            self.assertEqual(derive.light_from_time("03:00", month, "CA"), "night", month)

    def test_summer_evening_is_twilight_and_winter_evening_is_night(self):
        self.assertEqual(derive.light_from_time("20:30", "2025-07", "CA"), "twilight")
        self.assertEqual(derive.light_from_time("19:00", "2025-12", "CA"), "night")
        self.assertEqual(derive.light_from_time("18:00", "2025-07", "CA"), "day")

    def test_arizona_has_no_daylight_saving_time(self):
        # 21:15 in July: within an hour after the DST sunset elsewhere, but more than an hour after Arizona's.
        self.assertEqual(derive.light_from_time("21:15", "2025-07", "CA"), "twilight")
        self.assertEqual(derive.light_from_time("21:15", "2025-07", "AZ"), "night")

    def test_unknown_without_time_or_month(self):
        self.assertEqual(derive.light_from_time(None, "2025-07"), "unknown")
        self.assertEqual(derive.light_from_time("12:00", None), "unknown")

    def test_recorded_lighting_wins_and_says_so(self):
        self.assertEqual(derive.light_condition(r(lighting="dark_lighted", incident_time="12:00")), ("night", "recorded"))
        self.assertEqual(derive.light_condition(r(lighting="dawn_dusk")), ("twilight", "recorded"))
        self.assertEqual(derive.light_condition(r(lighting="unknown", incident_time="12:00")), ("day", "derived from time"))
        self.assertEqual(derive.light_condition(r(lighting=None, incident_time="02:10")), ("night", "derived from time"))
        self.assertEqual(derive.light_condition(r()), ("unknown", None))

    def test_sun_table_is_plausible(self):
        table = derive.sun_table_clock()
        self.assertEqual(len(table), 12)
        self.assertLess(table["06"]["sunrise"], table["12"]["sunrise"])
        self.assertGreater(table["06"]["sunset"], table["12"]["sunset"])
        self.assertIn("approximate", derive.LIGHT_RULE.lower())

    def test_night_clock_window(self):
        self.assertTrue(derive.night_clock(21))
        self.assertTrue(derive.night_clock(5))
        self.assertFalse(derive.night_clock(6))
        self.assertFalse(derive.night_clock(20))
        self.assertIsNone(derive.night_clock(None))


class LocalTimeTests(unittest.TestCase):
    def test_other_reporters_are_used_as_filed(self):
        self.assertEqual(derive.local_time({"entity": "Waymo LLC", "incident_time": "22:10", "state": "CA", "month": "2025-07"}),
                         ("22:10", "as filed"))
        self.assertEqual(derive.local_time({"entity": "Waymo LLC", "incident_time": None}), (None, "as filed"))

    def test_tesla_times_are_converted_from_utc_by_state_and_dst(self):
        t = lambda state, month, time="22:00": derive.local_time(  # noqa: E731
            {"entity": "Tesla, Inc.", "incident_time": time, "state": state, "month": month})
        self.assertEqual(t("CA", "2025-07"), ("15:00", "converted from UTC"))   # PDT = UTC-7
        self.assertEqual(t("CA", "2025-12"), ("14:00", "converted from UTC"))   # PST = UTC-8
        self.assertEqual(t("FL", "2025-07"), ("18:00", "converted from UTC"))   # EDT = UTC-4
        self.assertEqual(t("AZ", "2025-07"), ("15:00", "converted from UTC"))   # no DST: UTC-7
        self.assertEqual(t("TX", "2025-01", "03:30"), ("21:30", "converted from UTC"))  # wraps to the previous evening
        self.assertEqual(t(None, "2025-07"), (None, "converted from UTC"))

    def test_light_uses_the_local_time(self):
        rep = {"entity": "Tesla, Inc.", "incident_time": "22:00", "state": "CA", "month": "2025-07"}
        self.assertEqual(derive.light_from_report(rep), "day")  # 15:00 local, not 22:00
        self.assertIn("UTC", derive.TIME_RULE)


class LagMonthsTests(unittest.TestCase):
    def test_whole_months(self):
        self.assertEqual(derive.lag_months({"month": "2025-07", "submitted": "2025-07-31"}), 0)
        self.assertEqual(derive.lag_months({"month": "2025-07", "submitted": "2025-09-30"}), 2)
        self.assertEqual(derive.lag_months({"month": "2025-12", "submitted": "2026-01-31"}), 1)
        self.assertEqual(derive.lag_months({"month": "2025-07", "submitted": "2025-06-30"}), 0)
        self.assertIsNone(derive.lag_months({"month": None, "submitted": "2025-06-30"}))


if __name__ == "__main__":
    unittest.main()
