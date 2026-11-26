import json
import unittest

from pipeline import classify


def rec(**overrides):
    """A Record with every classified field empty, then overrides applied."""
    base = {
        "roadway_type": None,
        "sv_movement": None,
        "cp_movement": None,
        "crash_with": None,
        "lighting": None,
        "weather": [],
        "surface": None,
        "speed_mph": None,
        "narrative": None,
        "narrative_redacted": False,
    }
    base.update(overrides)
    return base


def tags(record):
    return {(t["t"], t["basis"], t["rule"]) for t in classify.tag(record)}


def tag_names(record):
    return [t["t"] for t in classify.tag(record)]


class RuleTableTests(unittest.TestCase):
    def test_rules_are_published_shape(self):
        self.assertTrue(classify.RULES)
        for rule in classify.RULES:
            self.assertEqual(set(rule), {"id", "t", "basis", "description"})
            self.assertIn(rule["basis"], ("field", "narrative"))
            self.assertTrue(rule["description"])
        json.dumps(classify.RULES)  # must be serializable for the Data tab

    def test_rule_ids_are_unique_and_implemented(self):
        ids = [r["id"] for r in classify.RULES]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(set(ids), set(classify._MATCHERS))

    def test_all_six_tags_have_a_field_rule(self):
        field_tags = {r["t"] for r in classify.RULES if r["basis"] == "field"}
        self.assertEqual(
            field_tags,
            {"intersection_signal", "visibility_glare", "roadway_departure",
             "stationary_hazard", "low_speed", "vru"},
        )

    def test_narrative_rules_publish_their_keywords(self):
        for rule in classify.RULES:
            if rule["basis"] == "narrative":
                for kw in classify.NARRATIVE_KEYWORDS[rule["id"]]:
                    self.assertIn(kw, rule["description"])


class IntersectionTests(unittest.TestCase):
    def test_roadway_type_intersection(self):
        self.assertEqual(
            tags(rec(roadway_type="intersection")),
            {("intersection_signal", "field", "INT-1")},
        )

    def test_narrative_ran_red_light(self):
        r = rec(narrative="The other car ran a red light and struck the SV.")
        self.assertEqual(tags(r), {("intersection_signal", "narrative", "INT-2")})

    def test_stop_sign_and_signal(self):
        for text in ("Failed to stop at the stop sign.", "The traffic signal was green."):
            self.assertIn(("intersection_signal", "narrative", "INT-2"), tags(rec(narrative=text)))

    def test_turn_signal_is_not_a_traffic_signal(self):
        self.assertEqual(tags(rec(narrative="The SV used its turn signal.")), set())

    def test_word_boundaries_and_case(self):
        self.assertEqual(tags(rec(narrative="RED LIGHT ahead")),
                         {("intersection_signal", "narrative", "INT-2")})
        self.assertEqual(tags(rec(narrative="A tired light-duty truck")), set())


class VisibilityTests(unittest.TestCase):
    def test_lighting(self):
        for lighting in ("dark_unlit", "dark_unknown", "dawn_dusk"):
            self.assertEqual(tags(rec(lighting=lighting)),
                             {("visibility_glare", "field", "VIS-1")}, lighting)

    def test_dark_lighted_and_daylight_do_not_count(self):
        for lighting in ("dark_lighted", "daylight", "unknown", "other"):
            self.assertEqual(tags(rec(lighting=lighting)), set(), lighting)

    def test_weather(self):
        for w in ("fog", "rain", "snow", "dust_storm"):
            self.assertEqual(tags(rec(weather=["clear", w])),
                             {("visibility_glare", "field", "VIS-2")}, w)

    def test_benign_weather(self):
        self.assertEqual(tags(rec(weather=["clear", "cloudy", "partly_cloudy", "unknown"])), set())

    def test_narrative_glare(self):
        for text in ("Sun glare blinded the safety driver.", "low visibility", "The sun was low."):
            self.assertIn(("visibility_glare", "narrative", "VIS-3"), tags(rec(narrative=text)), text)


class DepartureTests(unittest.TestCase):
    def test_lane_departure(self):
        self.assertEqual(tags(rec(sv_movement="lane_departure")),
                         {("roadway_departure", "field", "DEP-1")})

    def test_fixed_object_at_speed(self):
        r = rec(crash_with="fixed_object", speed_mph=25)
        self.assertIn(("roadway_departure", "field", "DEP-2"), tags(r))
        r = rec(crash_with="pole_tree", speed_mph=40)
        self.assertIn(("roadway_departure", "field", "DEP-2"), tags(r))

    def test_fixed_object_below_threshold_or_unknown_speed(self):
        self.assertNotIn("roadway_departure", tag_names(rec(crash_with="fixed_object", speed_mph=24)))
        self.assertNotIn("roadway_departure", tag_names(rec(crash_with="fixed_object")))


class StationaryHazardTests(unittest.TestCase):
    def test_moving_sv_hits_stopped_or_parked_partner(self):
        for cp in ("stopped", "parked"):
            r = rec(sv_movement="proceeding_straight", cp_movement=cp)
            self.assertIn(("stationary_hazard", "field", "HAZ-1"), tags(r), cp)

    def test_sv_not_moving_does_not_trigger_haz1(self):
        for sv in ("stopped", "parked", "unknown", None):
            r = rec(sv_movement=sv, cp_movement="stopped")
            self.assertNotIn("stationary_hazard", tag_names(r), sv)

    def test_crash_with_fixed_things(self):
        for cw in ("fixed_object", "pole_tree", "first_responder_vehicle"):
            self.assertIn(("stationary_hazard", "field", "HAZ-2"), tags(rec(crash_with=cw)), cw)

    def test_narrative(self):
        for text in ("Debris in the lane.", "A stalled vehicle.", "an emergency vehicle", "hit a cone"):
            self.assertIn(("stationary_hazard", "narrative", "HAZ-3"), tags(rec(narrative=text)), text)


class LowSpeedTests(unittest.TestCase):
    def test_speed_3(self):
        self.assertEqual(tags(rec(speed_mph=3)), {("low_speed", "field", "LOW-1")})

    def test_boundaries(self):
        self.assertIn("low_speed", tag_names(rec(speed_mph=0)))
        self.assertIn("low_speed", tag_names(rec(speed_mph=5)))
        self.assertNotIn("low_speed", tag_names(rec(speed_mph=6)))
        self.assertNotIn("low_speed", tag_names(rec(speed_mph=None)))

    def test_sv_stopped_or_parked(self):
        for sv in ("stopped", "parked"):
            self.assertEqual(tags(rec(sv_movement=sv)), {("low_speed", "field", "LOW-2")}, sv)

    def test_unknown_speed_unknown_movement(self):
        self.assertEqual(tags(rec(sv_movement="unknown")), set())


class VruTests(unittest.TestCase):
    def test_crash_with(self):
        for cw in ("pedestrian", "cyclist", "scooter_skateboard", "non_motorist_other"):
            self.assertEqual(tags(rec(crash_with=cw)), {("vru", "field", "VRU-1")}, cw)

    def test_cp_movement_nm(self):
        self.assertEqual(tags(rec(cp_movement="nm_crossing_roadway")), {("vru", "field", "VRU-2")})
        self.assertEqual(tags(rec(cp_movement="nm_on_sidewalk")), {("vru", "field", "VRU-2")})

    def test_not_vru(self):
        self.assertNotIn("vru", tag_names(rec(crash_with="passenger_car", cp_movement="stopped")))
        self.assertNotIn("vru", tag_names(rec(crash_with="motorcycle")))

    def test_narrative(self):
        for text in ("A pedestrian stepped out.", "bicyclist fell", "two cyclists"):
            self.assertEqual(tags(rec(narrative=text)), {("vru", "narrative", "VRU-3")}, text)


class NarrativeRedactionTests(unittest.TestCase):
    def test_redacted_narrative_gives_no_narrative_tags(self):
        r = rec(narrative="ran a red light, pedestrian, glare, debris", narrative_redacted=True)
        self.assertEqual(tags(r), set())

    def test_redacted_narrative_keeps_field_tags(self):
        r = rec(narrative="[REDACTED] pedestrian", narrative_redacted=True,
                roadway_type="intersection")
        self.assertEqual(tags(r), {("intersection_signal", "field", "INT-1")})

    def test_missing_narrative(self):
        self.assertEqual(tags(rec(narrative=None)), set())


class DedupeTests(unittest.TestCase):
    def test_one_entry_per_tag(self):
        r = rec(roadway_type="intersection", narrative="red light")
        out = classify.tag(r)
        self.assertEqual([(t["t"], t["basis"], t["rule"]) for t in out],
                         [("intersection_signal", "field", "INT-1")])

    def test_field_preferred_over_narrative_regardless_of_order(self):
        # Narrative hit exists; field hit exists in a later rule ID of the same tag.
        r = rec(crash_with="pedestrian", narrative="a pedestrian")
        self.assertEqual(tags(r), {("vru", "field", "VRU-1")})

    def test_first_field_rule_by_rules_order_wins(self):
        r = rec(crash_with="pedestrian", cp_movement="nm_on_sidewalk")
        self.assertEqual(tags(r), {("vru", "field", "VRU-1")})
        r = rec(speed_mph=2, sv_movement="stopped")
        self.assertEqual(tags(r), {("low_speed", "field", "LOW-1")})

    def test_multiple_tags(self):
        r = rec(roadway_type="intersection", crash_with="pedestrian", speed_mph=4)
        self.assertEqual(sorted(tag_names(r)), ["intersection_signal", "low_speed", "vru"])

    def test_empty_record(self):
        self.assertEqual(classify.tag(rec()), [])

    def test_only_known_tags(self):
        known = {"intersection_signal", "visibility_glare", "roadway_departure",
                 "stationary_hazard", "low_speed", "vru"}
        for r in classify.RULES:
            self.assertIn(r["t"], known)


class SpeedBandTests(unittest.TestCase):
    def test_bands(self):
        cases = {0: "0", 1: "1-5", 5: "1-5", 6: "6-15", 15: "6-15", 16: "16-30", 30: "16-30",
                 31: "31-50", 50: "31-50", 51: "51+", 90: "51+", None: "unknown"}
        for mph, band in cases.items():
            self.assertEqual(classify.speed_band(rec(speed_mph=mph)), band, mph)


if __name__ == "__main__":
    unittest.main()
