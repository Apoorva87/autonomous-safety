import json
import unittest

from pipeline import golden, responsibility as resp

FRONT = ["front", "front_left", "front_right"]


def report(**kw):
    """A current golden report row with only the fields the responsibility rules read."""
    base = {
        "report_key": "R1|v1", "report_id": "R1", "version": 1, "incident_key": "I1", "program": "waymo_ads",
        "month": "2025-01", "is_latest": True, "is_placeholder": False, "removed_in_run": None,
        "sv_contact_areas": ["front"], "cp_contact_areas": ["rear"], "sv_movement": "proceeding_straight",
        "cp_movement": "proceeding_straight", "crash_with": "passenger_car", "speed_mph": 20,
        "roadway_type": "street", "automation_engaged": "ads", "severity": "minor", "speed_band": "16-30", "engagement_status": None,
        "narrative_redacted": False, "raw": {"Narrative": "text"},
    }
    base.update(kw)
    return base


def judge(**kw):
    return resp.classify_report(report(**kw))


class OtherPartyRuleTests(unittest.TestCase):
    def test_stopped_sv_with_contact_is_other_party_high(self):
        for movement in ("stopped", "parked"):
            r = judge(sv_movement=movement, sv_contact_areas=["front_left"])
            self.assertEqual((r["label"], r["rule"], r["confidence"]), ("other_party", "RESP-OTH-1", "high"), movement)

    def test_stopped_sv_hitting_a_fixed_object_is_not_other_party(self):
        r = judge(sv_movement="stopped", sv_contact_areas=["front"], crash_with="fixed_object")
        self.assertEqual(r["label"], "indeterminate")

    def test_stopped_sv_with_unknown_contact_is_not_enough(self):
        r = judge(sv_movement="stopped", sv_contact_areas=["unknown"])
        self.assertEqual(r["label"], "indeterminate")

    def test_rear_only_contact_while_moving_forward_is_other_party_high(self):
        for movement in ("proceeding_straight", "right_turn", "changing_lanes"):
            r = judge(sv_movement=movement, sv_contact_areas=["rear", "rear_left"])
            self.assertEqual((r["label"], r["rule"], r["confidence"]), ("other_party", "RESP-OTH-2", "high"), movement)

    def test_rear_contact_while_backing_is_not_other_party(self):
        r = judge(sv_movement="backing", sv_contact_areas=["rear"], cp_movement="stopped")
        self.assertEqual(r["label"], "indeterminate")

    def test_rear_only_contact_with_uncertain_movement_is_medium(self):
        for movement in ("unknown", "other", "parking_maneuver", None):
            r = judge(sv_movement=movement, sv_contact_areas=["rear_right"])
            self.assertEqual((r["label"], r["rule"], r["confidence"]), ("other_party", "RESP-OTH-4", "medium"), movement)

    def test_lane_departure_against_a_wrong_way_or_opposing_partner_is_a_conflict(self):
        for cp in ("wrong_way", "crossing_opposing_lane"):
            r = judge(sv_movement="lane_departure", sv_contact_areas=["front"], cp_movement=cp)
            self.assertEqual((r["label"], r["rule"]), ("indeterminate", "RESP-IND-2"), cp)
            self.assertIn("conflict", r["rationale"])
            self.assertIn(cp.replace("_", " "), r["rationale"])
            self.assertEqual(r["evidence_fields"]["cp_movement"], cp)

    def test_lane_departure_against_an_ordinary_partner_stays_subject_initiated(self):
        r = judge(sv_movement="lane_departure", sv_contact_areas=["front"], cp_movement="proceeding_straight")
        self.assertEqual(r["rule"], "RESP-SUB-1")

    def test_lane_departure_with_rear_only_contact_is_a_conflict(self):
        r = judge(sv_movement="lane_departure", sv_contact_areas=["rear"])
        self.assertEqual((r["label"], r["rule"]), ("indeterminate", "RESP-IND-2"))

    def test_cp_maneuver_with_sv_going_straight_and_side_contact_is_medium(self):
        for cp in ("changing_lanes", "left_turn", "right_turn", "entering_traffic", "backing", "wrong_way",
                   "crossing_opposing_lane", "u_turn", "merging", "passing"):
            r = judge(sv_movement="proceeding_straight", sv_contact_areas=["left"], cp_movement=cp)
            self.assertEqual((r["label"], r["rule"], r["confidence"]), ("other_party", "RESP-OTH-3", "medium"), cp)

    def test_cp_maneuver_with_front_only_contact_is_not_other_party(self):
        r = judge(sv_movement="proceeding_straight", sv_contact_areas=FRONT, cp_movement="left_turn")
        self.assertEqual(r["label"], "indeterminate")

    def test_cp_maneuver_needs_a_known_sv_contact(self):
        r = judge(sv_movement="proceeding_straight", sv_contact_areas=[], cp_movement="left_turn")
        self.assertEqual(r["label"], "indeterminate")


class SubjectVehicleRuleTests(unittest.TestCase):
    def test_lane_departure_is_subject_vehicle_initiated_high(self):
        r = judge(sv_movement="lane_departure", sv_contact_areas=["front_right"])
        self.assertEqual((r["label"], r["rule"], r["confidence"]), ("subject_vehicle_initiated", "RESP-SUB-1", "high"))

    def test_moving_sv_hitting_fixed_object_animal_or_pole_is_high(self):
        for crash in ("fixed_object", "pole_tree", "animal"):
            r = judge(sv_movement="proceeding_straight", crash_with=crash, cp_movement=None)
            self.assertEqual((r["label"], r["rule"], r["confidence"]), ("subject_vehicle_initiated", "RESP-SUB-2", "high"), crash)

    def test_speed_alone_shows_motion(self):
        r = judge(sv_movement="unknown", crash_with="pole_tree", speed_mph=15, sv_contact_areas=["unknown"])
        self.assertEqual(r["rule"], "RESP-SUB-2")

    def test_unknown_movement_and_no_speed_is_not_moving(self):
        r = judge(sv_movement="unknown", crash_with="pole_tree", speed_mph=None, sv_contact_areas=["front"])
        self.assertEqual(r["label"], "indeterminate")

    def test_zero_speed_with_other_movement_is_not_moving(self):
        r = judge(sv_movement="other", crash_with="animal", speed_mph=0)
        self.assertEqual(r["label"], "indeterminate")

    def test_stopped_but_speed_positive_is_a_contradiction_not_motion(self):
        r = judge(sv_movement="stopped", crash_with="fixed_object", speed_mph=5)
        self.assertEqual(r["label"], "indeterminate")

    def test_front_only_contact_with_stopped_cp_while_moving_is_medium(self):
        for cp in ("stopped", "parked"):
            r = judge(sv_movement="proceeding_straight", sv_contact_areas=["front"], cp_movement=cp)
            self.assertEqual((r["label"], r["rule"], r["confidence"]), ("subject_vehicle_initiated", "RESP-SUB-3", "medium"), cp)

    def test_front_only_contact_needs_a_moving_sv(self):
        r = judge(sv_movement="unknown", speed_mph=None, sv_contact_areas=["front"], cp_movement="stopped")
        self.assertEqual(r["label"], "indeterminate")

    def test_sv_maneuver_with_front_or_side_contact_is_indeterminate_not_a_guess(self):
        # retired RESP-SUB-4 labelled these subject_vehicle_initiated (low); the audit showed it was mostly wrong
        for movement in ("changing_lanes", "left_turn", "right_turn", "backing", "merging", "u_turn",
                         "entering_traffic", "passing"):
            r = judge(sv_movement=movement, sv_contact_areas=["left", "front_left"], cp_movement="proceeding_straight")
            self.assertEqual((r["label"], r["rule"], r["confidence"]), ("indeterminate", "RESP-IND-4", "low"), movement)
            self.assertEqual(r["rationale"], "The subject vehicle was manoeuvring but the evidence does not show who "
                                             "initiated contact.")
            self.assertIsNone(r["agent_hint"])

    def test_retired_rules_are_kept_as_history(self):
        self.assertEqual([r["id"] for r in resp.RETIRED_RULES], ["RESP-SUB-4"])
        self.assertNotIn("RESP-SUB-4", resp.RULE_IDS)
        note = resp.RETIRED_RULES[0]
        self.assertEqual(set(note), {"id", "label", "confidence", "description", "retired_in", "reason"})
        self.assertIn("27 of 30", note["reason"])

    def test_sv_maneuver_with_rear_contact_is_not_subject_initiated(self):
        r = judge(sv_movement="left_turn", sv_contact_areas=["front", "rear"], cp_movement="stopped")
        self.assertNotEqual(r["label"], "subject_vehicle_initiated")


class IndeterminateTests(unittest.TestCase):
    def test_missing_fields_are_named_in_the_rationale(self):
        r = judge(sv_movement=None, sv_contact_areas=[], crash_with="unknown", cp_movement="unknown")
        self.assertEqual((r["label"], r["rule"], r["confidence"]), ("indeterminate", "RESP-IND-1", "low"))
        for name in ("sv_movement", "sv_contact_areas"):
            self.assertIn(name, r["rationale"])

    def test_unknown_values_count_as_missing(self):
        r = judge(sv_movement="unknown", sv_contact_areas=["unknown"])
        self.assertEqual(r["rule"], "RESP-IND-1")
        self.assertIn("sv_movement", r["rationale"])
        self.assertIn("sv_contact_areas", r["rationale"])

    def test_known_fields_without_a_matching_rule(self):
        r = judge(sv_movement="proceeding_straight", sv_contact_areas=FRONT, cp_movement="proceeding_straight")
        self.assertEqual((r["label"], r["rule"]), ("indeterminate", "RESP-IND-3"))

    def test_missing_lists_do_not_crash(self):
        r = judge(sv_contact_areas=None, cp_contact_areas=None)
        self.assertEqual(r["label"], "indeterminate")


class LabelShapeTests(unittest.TestCase):
    def test_every_label_carries_basis_confidence_rule_rationale_and_evidence(self):
        r = judge(sv_movement="stopped", sv_contact_areas=["rear"])
        self.assertEqual(r["basis"], "field")
        self.assertIn(r["confidence"], ("high", "medium", "low"))
        self.assertTrue(r["rationale"].endswith("."))
        self.assertEqual(r["evidence_fields"]["sv_movement"], "stopped")
        self.assertEqual(r["evidence_fields"]["sv_contact_areas"], ["rear"])

    def test_rationale_reads_as_plain_words(self):
        r = judge(sv_movement="proceeding_straight", crash_with="fixed_object", speed_mph=None, cp_movement=None)
        self.assertEqual(r["rule"], "RESP-SUB-2")
        self.assertNotIn("_", r["rationale"])
        self.assertNotIn("None", r["rationale"])
        self.assertNotIn("none mph", r["rationale"])
        self.assertIn("unknown speed", r["rationale"])
        r = judge(sv_movement="stopped", sv_contact_areas=["front_left", "left"])
        self.assertIn("front left, left", r["rationale"])

    def test_agent_hint_for_ads_programs(self):
        for program in ("waymo_ads", "zoox_ads", "gm_cruise_ads", "tesla_robotaxi", "other_ads"):
            r = judge(program=program, sv_movement="lane_departure")
            self.assertEqual(r["agent_hint"], "ads", program)

    def test_agent_hint_for_level_2_programs_never_picks_a_side(self):
        for program in ("tesla_l2", "gm_supercruise", "other_l2"):
            r = judge(program=program, sv_movement="lane_departure", automation_engaged="l2")
            self.assertEqual(r["label"], "subject_vehicle_initiated")
            self.assertEqual(r["agent_hint"], "driver_or_system", program)
            text = r["rationale"].lower()
            self.assertNotIn("driver", text)
            self.assertNotIn("system", text)

    def test_agent_hint_is_null_for_other_labels(self):
        self.assertIsNone(judge(sv_movement="stopped", sv_contact_areas=["front"])["agent_hint"])
        self.assertIsNone(judge(sv_movement=None, sv_contact_areas=[])["agent_hint"])

    def test_agent_hint_is_null_for_an_unknown_program(self):
        r = judge(program="mystery", sv_movement="lane_departure")
        self.assertIsNone(r["agent_hint"])

    def test_not_engaged_report_is_noted_but_stays_unseparated(self):
        r = judge(program="tesla_l2", sv_movement="lane_departure", engagement_status="verified_not_engaged")
        self.assertEqual(r["agent_hint"], "driver_or_system")
        self.assertIn("not engaged", r["rationale"])
        self.assertEqual(r["evidence_fields"]["engagement_status"], "verified_not_engaged")

    def test_rules_table_lists_every_rule_the_classifier_can_return(self):
        ids = {rule["id"] for rule in resp.RULES}
        samples = [
            judge(sv_movement="stopped"), judge(sv_movement="lane_departure", sv_contact_areas=["rear"]),
            judge(sv_movement="proceeding_straight", sv_contact_areas=["rear"]), judge(sv_movement=None, sv_contact_areas=["rear"]),
            judge(sv_movement="lane_departure"), judge(sv_movement="proceeding_straight", crash_with="animal"),
            judge(sv_movement="proceeding_straight", cp_movement="stopped"),
            judge(sv_movement="proceeding_straight", sv_contact_areas=["left"], cp_movement="left_turn"),
            judge(sv_movement="left_turn", sv_contact_areas=["left"]),
            judge(sv_movement=None, sv_contact_areas=[]),
            judge(sv_movement="stopped", narrative_redacted=False, raw={"Narrative": "The rider opened the door."}),
            judge(sv_movement="proceeding_straight", sv_contact_areas=FRONT),
        ]
        self.assertEqual({s["rule"] for s in samples}, ids)
        for rule in resp.RULES:
            self.assertEqual(set(rule), {"id", "label", "confidence", "description"})

    def test_first_match_wins_in_rule_order(self):
        order = [rule["id"] for rule in resp.RULES]
        self.assertEqual(order, sorted(set(order), key=order.index))  # unique
        self.assertLess(order.index("RESP-OTH-1"), order.index("RESP-SUB-1"))


def with_story(text, **kw):
    r = report(**kw)
    r["raw"] = {"Narrative": text}
    return resp.classify_report(r)


class DoorGuardTests(unittest.TestCase):
    def test_cues_cover_the_door_and_exit_phrases(self):
        for phrase in ("A rider opened the door as an SUV passed.", "The passenger opened his car door.",
                       "A passenger opened the rear driver side door.", "She opened a vehicle door.",
                       "Opened their passenger door into traffic.", "This was a dooring event.",
                       "A cyclist hit the door while exiting the vehicle.", "The rider exited the vehicle.",
                       "During passenger exit the door contacted a car.", "OPENED THE DOOR"):
            self.assertTrue(resp.door_cue(phrase), phrase)

    def test_cues_need_word_boundaries_and_the_right_words(self):
        for phrase in ("The AV opened the gate.", "The door was damaged.", "The unopened doorway was clear.",
                       "Standing doorman exited the vehiclelot.", "", None):
            self.assertIsNone(resp.door_cue(phrase), phrase)

    def test_door_story_overrides_stopped_sv_contact(self):
        r = with_story("The rider opened the door into a passing SUV.", sv_movement="stopped", sv_contact_areas=["left"])
        self.assertEqual((r["label"], r["rule"], r["basis"], r["confidence"]), ("indeterminate", "RESP-NAR-1", "narrative", "low"))
        self.assertIn("RESP-OTH-1", r["rationale"])
        self.assertIn("door", r["rationale"])
        self.assertEqual(r["evidence_fields"]["narrative_cue"], "opened the door")
        self.assertEqual(r["evidence_fields"]["field_rule"], "RESP-OTH-1")
        self.assertIsNone(r["agent_hint"])
        self.assertNotIn("passing SUV", json.dumps(r))  # cue name only, never narrative text

    def test_door_story_overrides_a_moving_sv_with_a_stopped_partner(self):
        r = with_story("A passenger in the SUV opened the rear door.", sv_movement="proceeding_straight",
                       sv_contact_areas=["front_right"], cp_movement="parked")
        self.assertEqual((r["rule"], r["evidence_fields"]["field_rule"]), ("RESP-NAR-1", "RESP-SUB-3"))

    def test_door_story_does_not_touch_other_rules(self):
        r = with_story("The rider opened the door.", sv_movement="proceeding_straight", sv_contact_areas=["rear"])
        self.assertEqual((r["rule"], r["basis"]), ("RESP-OTH-2", "field"))
        r = with_story("The rider opened the door.", sv_movement="lane_departure", sv_contact_areas=["front"])
        self.assertEqual(r["rule"], "RESP-SUB-1")

    def test_redacted_or_empty_narratives_never_trigger_the_guard(self):
        r = with_story("The rider opened the door.", sv_movement="stopped", narrative_redacted=True)
        self.assertEqual(r["rule"], "RESP-OTH-1")
        r = with_story("", sv_movement="stopped")
        self.assertEqual(r["rule"], "RESP-OTH-1")

    def test_label_rows_carry_the_narrative_basis(self):
        rep = report(sv_movement="stopped", raw={"Narrative": "The rider opened the door."})
        row = resp.build_labels([rep], "r1")[0]
        self.assertEqual((row["basis"], row["rule"], row["label"]), ("narrative", "RESP-NAR-1", "indeterminate"))

    def test_rule_description_lists_the_cues(self):
        rule = next(r for r in resp.RULES if r["id"] == "RESP-NAR-1")
        for name in ("opened the door", "dooring", "exiting the vehicle", "exited the vehicle", "passenger exit"):
            self.assertIn(name, rule["description"])


class BuildLabelsTests(unittest.TestCase):
    def test_only_current_reports_are_labelled_sorted_by_report_key(self):
        reports = [
            report(report_key="B|v1", report_id="B"),
            report(report_key="A|v2", report_id="A", version=2),
            report(report_key="A|v1", report_id="A", is_latest=False),
            report(report_key="P|v1", report_id="P", is_placeholder=True),
            report(report_key="X|v1", report_id="X", removed_in_run="r0"),
        ]
        rows = resp.build_labels(reports, "20261126T101010Z")
        self.assertEqual([r["report_key"] for r in rows], ["A|v2", "B|v1"])

    def test_row_matches_the_labels_table_spec(self):
        row = resp.build_labels([report(sv_movement="stopped")], "20261126T101010Z")[0]
        for column in golden.LABEL_COLUMNS:
            self.assertIn(column, row)
        self.assertEqual(row["label_set"], resp.LABEL_SET)
        self.assertEqual(row["label_set"], "responsibility_rules_v1")
        self.assertEqual(row["model"], "rules")
        self.assertEqual(row["run_at"], "2026-11-26T10:10:10Z")
        for extra in ("rule", "confidence", "basis", "agent_hint"):
            self.assertIn(extra, row)

    def test_run_id_that_is_not_a_stamp_is_used_as_it_is(self):
        row = resp.build_labels([report()], "r1")[0]
        self.assertEqual(row["run_at"], "r1")

    def test_same_run_id_gives_identical_rows(self):
        reports = [report(report_key="B|v1"), report(report_key="A|v1", sv_movement="stopped")]
        a = resp.build_labels(reports, "r1")
        b = resp.build_labels(list(reversed(reports)), "r1")
        self.assertEqual(a, b)

    def test_unchanged_label_keeps_its_earlier_run_at(self):
        reports = [report()]
        first = resp.build_labels(reports, "r1")
        again = resp.build_labels(reports, "r2", previous=first)
        self.assertEqual(again, first)
        changed = resp.build_labels([report(sv_movement="stopped")], "r3", previous=first)
        self.assertEqual(changed[0]["run_at"], "r3")

    def test_previous_rows_of_other_label_sets_are_ignored(self):
        foreign = {"report_key": "R1|v1", "label_set": "llm_v1", "label": "x", "run_at": "r0"}
        rows = resp.build_labels([report()], "r2", previous=[foreign])
        self.assertEqual(rows[0]["run_at"], "r2")


class MergeLabelsTests(unittest.TestCase):
    FOREIGN = (b'{"label":"avoidable","label_set":"llm_v1","model":"x","report_key":"A|v1","rationale":"r",'
               b'"run_at":"2026-01-01T00:00:00Z"}\n')

    def rows(self, run_id="r1"):
        return resp.build_labels([report(report_key="A|v1"), report(report_key="B|v1")], run_id)

    def test_foreign_rows_survive_byte_for_byte(self):
        odd = b'{ "report_key" : "Z|v9", "label_set":"llm_v1" ,"label":"y"}\n'  # non-canonical spacing on purpose
        merged = resp.merge_labels(self.FOREIGN + odd, self.rows())
        self.assertIn(self.FOREIGN, merged)
        self.assertIn(odd, merged)

    def test_own_rows_are_replaced_not_appended(self):
        first = resp.merge_labels(self.FOREIGN, self.rows("r1"))
        second = resp.merge_labels(first, self.rows("r2"))
        lines = [json.loads(l) for l in second.splitlines()]
        own = [l for l in lines if l["label_set"] == resp.LABEL_SET]
        self.assertEqual(len(own), 2)
        self.assertEqual({l["run_at"] for l in own}, {"r2"})
        self.assertEqual(sum(1 for l in lines if l["label_set"] == "llm_v1"), 1)

    def test_stale_own_rows_are_dropped(self):
        first = resp.merge_labels(b"", self.rows())
        second = resp.merge_labels(first, resp.build_labels([report(report_key="A|v1")], "r1"))
        self.assertEqual(len(second.splitlines()), 1)

    def test_output_is_sorted_and_rerun_is_byte_identical(self):
        a = resp.merge_labels(self.FOREIGN, self.rows())
        b = resp.merge_labels(a, self.rows())
        self.assertEqual(a, b)
        keys = [(json.loads(l)["report_key"], json.loads(l)["label_set"]) for l in a.splitlines()]
        self.assertEqual(keys, sorted(keys))

    def test_empty_and_blank_input(self):
        self.assertEqual(resp.merge_labels(b"", []), b"")
        self.assertEqual(resp.merge_labels(b"\n\n", []), b"")


def labelled(reports, run_id="r1"):
    return resp.build_labels(reports, run_id)


class OutputTests(unittest.TestCase):
    def setUp(self):
        self.reports = [
            report(report_key="A|v1", report_id="A", incident_key="I1", month="2025-02", sv_movement="stopped"),
            report(report_key="B|v1", report_id="B", incident_key="I1", program="tesla_l2", month="2025-03",
                   sv_movement="lane_departure", automation_engaged="l2"),
            report(report_key="C|v1", report_id="C", incident_key="I2", program="tesla_l2", month="2025-03",
                   sv_movement=None, sv_contact_areas=[]),
            report(report_key="D|v1", report_id="D", incident_key="I3", month="2025-04",
                   sv_movement="proceeding_straight", sv_contact_areas=["left"], cp_movement="left_turn"),
        ]
        self.labels = labelled(self.reports)
        self.out = resp.build_outputs(self.reports, self.labels, "r1")

    def test_three_files(self):
        self.assertEqual(set(self.out), {"responsibility.json", "responsibility_rules.json", "responsibility_audit.json"})
        self.assertEqual(set(self.out), set(resp.OUTPUT_FILES))

    def test_responsibility_json_is_columnar_and_sorted(self):
        data = self.out["responsibility.json"]
        self.assertEqual(data["label_set"], "responsibility_rules_v1")
        self.assertEqual(data["generated_for_run"], "r1")
        self.assertEqual(data["rules_version"], resp.RULES_VERSION)
        self.assertIn("not a finding of fault", data["disclaimer"])
        self.assertEqual(data["fields"], [
            "report_id", "report_key", "incident_key", "program", "month", "label", "confidence", "basis", "rule",
            "agent_hint", "severity", "sv_movement", "cp_movement", "crash_with", "sv_contact_areas", "speed_band",
            "automation_engaged", "evidence", "own_kind", "crash_rep", "crash_label", "crash_own_kind"])
        self.assertEqual([r[1] for r in data["rows"]], ["A|v1", "B|v1", "C|v1", "D|v1"])
        self.assertEqual(data["rows"][0][:10], ["A", "A|v1", "I1", "waymo_ads", "2025-02", "other_party", "high", "field",
                                                "RESP-OTH-1", None])
        self.assertEqual(data["rows"][1][9], "driver_or_system")

    def test_every_row_carries_the_display_fields_of_its_own_report(self):
        data = self.out["responsibility.json"]
        rows = {r[0]: dict(zip(data["fields"], r)) for r in data["rows"]}
        # B and A share incident I1 but each row describes its own report
        self.assertEqual(rows["A"]["sv_movement"], "stopped")
        self.assertEqual(rows["B"]["sv_movement"], "lane_departure")
        self.assertEqual(rows["A"]["severity"], "minor")
        self.assertEqual(rows["A"]["crash_with"], "passenger_car")
        self.assertEqual(rows["A"]["cp_movement"], "proceeding_straight")
        self.assertEqual(rows["A"]["sv_contact_areas"], ["front"])
        self.assertEqual(rows["A"]["speed_band"], "16-30")
        self.assertEqual(rows["B"]["automation_engaged"], "l2")
        self.assertEqual(rows["C"]["sv_contact_areas"], [])
        self.assertIsNone(rows["C"]["sv_movement"])

    def test_evidence_is_sorted_field_value_pairs_without_narrative_text(self):
        data = self.out["responsibility.json"]
        rows = {r[0]: dict(zip(data["fields"], r)) for r in data["rows"]}
        sets = data["evidence_sets"]
        self.assertEqual(sets[rows["A"]["evidence"]], ["crash_with=passenger_car", "sv_contact_areas=front", "sv_movement=stopped"])
        self.assertEqual(sets[rows["B"]["evidence"]], ["sv_movement=lane_departure"])
        self.assertEqual(len({tuple(s) for s in sets}), len(sets))  # each distinct set once
        at = data["fields"].index("evidence")
        for r in data["rows"]:
            self.assertTrue(all("=" in p for p in sets[r[at]]))

    def test_output_is_deterministic(self):
        again = resp.build_outputs(self.reports, labelled(self.reports), "r1")
        self.assertEqual(json.dumps(again["responsibility.json"], sort_keys=True), json.dumps(self.out["responsibility.json"], sort_keys=True))

    def test_summary_counts_program_label_confidence(self):
        counts = self.out["responsibility.json"]["summary"]["counts"]
        self.assertEqual(counts["waymo_ads"]["other_party"], {"high": 1, "medium": 1})
        self.assertEqual(counts["tesla_l2"]["subject_vehicle_initiated"], {"high": 1})
        self.assertEqual(counts["tesla_l2"]["indeterminate"], {"low": 1})

    def test_no_narrative_text_in_the_site_file(self):
        text = json.dumps(self.out["responsibility.json"])
        self.assertNotIn("Narrative", text)
        self.assertNotIn("narrative", text.lower().replace("narrative_", ""))

    def test_labels_of_other_sets_and_stale_keys_are_ignored(self):
        foreign = {"report_key": "A|v1", "label_set": "llm_v1", "label": "avoidable", "confidence": "high"}
        stale = dict(self.labels[0], report_key="GONE|v1")
        out = resp.build_outputs(self.reports, self.labels + [foreign, stale], "r1")
        self.assertEqual(len(out["responsibility.json"]["rows"]), 4)

    def test_own_motion_is_split_into_sub_kinds(self):
        self.assertEqual(resp.own_kind("fixed_object"), "fixed_object")
        self.assertEqual(resp.own_kind("pole_tree"), "fixed_object")
        self.assertEqual(resp.own_kind("animal"), "animal")
        self.assertEqual(resp.own_kind("passenger_car"), "road_user")
        self.assertEqual(resp.own_kind("cyclist"), "road_user")
        self.assertEqual(resp.own_kind("other"), "other")
        self.assertEqual(resp.own_kind(None), "other")
        data = self.out["responsibility.json"]
        rows = {r[0]: dict(zip(data["fields"], r)) for r in data["rows"]}
        self.assertEqual(rows["B"]["own_kind"], "road_user")  # lane departure into a passenger car
        self.assertIsNone(rows["A"]["own_kind"])  # not own motion

    def test_crash_level_roll_up_one_row_per_program_and_incident(self):
        reports = [
            # two GM Cruise reports of one incident: one labelled, one cannot tell -> the crash takes the label
            report(report_key="E|v1", report_id="E", incident_key="J", program="gm_cruise_ads", sv_movement="stopped", severity="none"),
            report(report_key="F|v1", report_id="F", incident_key="J", program="gm_cruise_ads", sv_movement=None, sv_contact_areas=[]),
            # conflicting determinate labels -> cannot tell at crash level, counted as a conflict
            report(report_key="G|v1", report_id="G", incident_key="K", program="gm_cruise_ads", sv_movement="stopped"),
            report(report_key="H|v1", report_id="H", incident_key="K", program="gm_cruise_ads", sv_movement="lane_departure"),
            # own motion into a fixed object
            report(report_key="I|v1", report_id="I", incident_key="L", program="waymo_ads", crash_with="fixed_object",
                   sv_movement="proceeding_straight"),
        ]
        out = resp.build_outputs(reports, labelled(reports), "r1")["responsibility.json"]
        rows = {r[0]: dict(zip(out["fields"], r)) for r in out["rows"]}
        reps = [k for k, v in rows.items() if v["crash_rep"]]
        self.assertEqual(sorted(reps), ["F", "G", "I"])  # highest severity, then lowest report id
        self.assertEqual({rows[k]["crash_label"] for k in "EF"}, {"other_party"})
        self.assertEqual({rows[k]["crash_label"] for k in "GH"}, {"indeterminate"})
        self.assertEqual(rows["I"]["crash_label"], "subject_vehicle_initiated")
        self.assertEqual(rows["I"]["crash_own_kind"], "fixed_object")
        summary = out["summary"]
        self.assertEqual(summary["crash_counts"]["gm_cruise_ads"], {"other_party": 1, "indeterminate": 1})
        self.assertEqual(summary["crash_conflicts"], {"gm_cruise_ads": 1})
        self.assertEqual(summary["crash_own_kinds"]["waymo_ads"], {"fixed_object": 1})

    def test_rules_file_lists_rules_and_labels(self):
        data = self.out["responsibility_rules.json"]
        self.assertEqual(data["rules"], resp.RULES)
        self.assertEqual(data["retired_rules"], resp.RETIRED_RULES)
        self.assertEqual(data["label_set"], resp.LABEL_SET)
        self.assertEqual([l["label"] for l in data["labels"]], list(resp.LABELS))
        self.assertIn("driver_or_system", data["agent_hints"])
        self.assertIn("not a finding of fault", data["disclaimer"])

    def test_everything_is_json_serializable_without_nan(self):
        json.dumps(self.out, allow_nan=False)


NARR = {
    "other": "The Waymo AV was stopped at a red light when a vehicle struck the Waymo AV from behind.",
    "other2": "A passenger car rear-ended the Waymo AV.",
    "sv": "The Waymo AV made contact with a parked vehicle while pulling over.",
    "both": "The Waymo AV hit a cone. Later the Waymo AV was struck by a passenger car.",
    "none": "The vehicle was involved in a collision.",
}


def with_text(text, **kw):
    r = report(**kw)
    r["raw"] = {"Narrative": text}
    return r


class CueTests(unittest.TestCase):
    def cue(self, text):
        return resp.narrative_cue(text)

    def test_other_party_cues(self):
        for phrase in ("A van struck the Waymo AV from behind.", "The AV was rear-ended by a car.",
                       "The Waymo AV was struck by a truck.", "A car collided with the rear of the Waymo AV.",
                       "A scooter hit the Waymo AV.", "The Waymo AV was stationary when a car arrived.",
                       "The AV was struck while stationary."):
            self.assertEqual(self.cue(phrase)[0], "other", phrase)

    def test_subject_vehicle_cues(self):
        for phrase in ("The Waymo AV hit a bollard.", "The Zoox vehicle made contact with a curb.",
                       "The Cruise AV struck a pole.", "The AV collided with a fence.",
                       "The vehicle contacted a parked car.", "It contacted a stationary vehicle.",
                       "The ADS made contact with a low-hanging chain."):
            self.assertEqual(self.cue(phrase)[0], "subject_vehicle", phrase)

    def test_the_av_must_start_the_clause_to_be_the_actor(self):
        kind, _ = self.cue("A pickup in the lane to the right of the AV made contact with the AV.")
        self.assertEqual(kind, "other")  # the pickup acted; the AV only appears after "of"

    def test_rear_ended_depends_on_who_did_it(self):
        self.assertEqual(self.cue("The AV rear-ended a stopped car.")[0], "subject_vehicle")
        self.assertEqual(self.cue("A truck rear-ended the AV.")[0], "other")
        self.assertEqual(self.cue("The Waymo AV was rear-ended.")[0], "other")
        self.assertEqual(self.cue("The driver said they rear-ended another vehicle.")[0], "none")

    def test_a_part_of_the_av_being_contacted_is_an_other_party_cue(self):
        self.assertEqual(self.cue("A passenger car made contact with the left side of the Waymo AV.")[0], "other")
        self.assertEqual(self.cue("A van made contact with the rear driver's side bumper of the AV.")[0], "other")
        self.assertEqual(self.cue("The Waymo AV was contacted by a scooter.")[0], "other")

    def test_a_part_of_the_av_making_contact_is_a_subject_vehicle_cue(self):
        self.assertEqual(self.cue("The Waymo AV's front bumper made contact with a traffic cone.")[0], "subject_vehicle")
        self.assertEqual(self.cue("The front of the AV made contact with the rear of the van.")[0], "none")

    def test_the_rear_of_something_else_is_not_an_other_party_cue(self):
        self.assertEqual(self.cue("The front of the AV made contact with the rear of the van.")[0], "none")

    def test_stopped_then_moved_is_not_a_stationary_cue(self):
        self.assertEqual(self.cue("The ADS was stopped and proceeded straight on the street.")[0], "none")

    def test_both_and_none(self):
        self.assertEqual(self.cue(NARR["both"])[0], "both")
        self.assertEqual(self.cue(NARR["none"])[0], "none")
        self.assertEqual(self.cue("")[0], "none")

    def test_the_cue_names_what_matched(self):
        kind, matched = self.cue("A van struck the Waymo AV from behind.")
        self.assertIn("struck from behind", matched)


class AuditTests(unittest.TestCase):
    def audit(self, reports):
        labels = labelled(reports)
        return resp.build_outputs(reports, labels, "r1")["responsibility_audit.json"]

    def test_confusion_table_by_program_counts_only_readable_narratives(self):
        reports = [
            with_text(NARR["other"], report_key="A|v1", report_id="A", sv_movement="stopped"),
            with_text(NARR["sv"], report_key="B|v1", report_id="B", sv_movement="lane_departure"),
            with_text(NARR["sv"], report_key="C|v1", report_id="C", sv_movement="stopped"),  # disagrees
            with_text(NARR["other2"], report_key="D|v1", report_id="D", sv_movement=None, sv_contact_areas=[]),
            with_text(NARR["other"], report_key="E|v1", report_id="E", sv_movement="stopped", narrative_redacted=True),
        ]
        audit = self.audit(reports)
        w = audit["comparison"]["waymo_ads"]
        self.assertEqual(w["readable_narratives"], 4)
        self.assertEqual(w["confusion"]["other_party"], {"other": 1, "subject_vehicle": 1})
        self.assertEqual(w["confusion"]["subject_vehicle_initiated"], {"subject_vehicle": 1})
        self.assertEqual(w["confusion"]["indeterminate"], {"other": 1})
        self.assertEqual((w["agree"], w["disagree"]), (2, 1))
        self.assertEqual(w["agreement_rate"], 0.6667)

    def test_agreement_rate_is_null_without_comparable_reports(self):
        audit = self.audit([with_text(NARR["none"], sv_movement="stopped")])
        self.assertIsNone(audit["comparison"]["waymo_ads"]["agreement_rate"])

    def test_disagreement_examples_are_capped_deterministic_and_text_free(self):
        reports = [with_text(NARR["sv"], report_key="K%02d|v1" % i, report_id="K%02d" % i, sv_movement="stopped")
                   for i in range(30)]
        audit = self.audit(reports)
        examples = audit["disagreement_examples"]
        self.assertEqual(len(examples), 15)
        self.assertEqual(examples, self.audit(list(reversed(reports)))["disagreement_examples"])
        first = examples[0]
        self.assertEqual(set(first), {"report_id", "report_key", "program", "rule", "label", "cue", "reason"})
        self.assertEqual(first["rule"], "RESP-OTH-1")
        self.assertNotIn("parked vehicle", json.dumps(audit))  # cue names, never narrative text

    def test_says_it_is_rough(self):
        audit = self.audit([report()])
        self.assertIn("not ground truth", audit["disclaimer"])
        self.assertIn("not a finding of fault", audit["disclaimer"])

    def test_distribution_by_program_and_confidence(self):
        audit = self.audit([report(report_key="A|v1", sv_movement="stopped"),
                            report(report_key="B|v1", program="tesla_l2", sv_movement=None, sv_contact_areas=[])])
        self.assertEqual(audit["distribution"]["by_program"]["waymo_ads"], {"other_party": 1})
        self.assertEqual(audit["distribution"]["by_confidence"]["tesla_l2"], {"low": 1})

    def test_indeterminate_reasons_name_missing_fields(self):
        reports = [report(report_key="A|v1", program="tesla_l2", sv_movement="unknown", sv_contact_areas=["front"]),
                   report(report_key="B|v1", program="tesla_l2", sv_movement=None, sv_contact_areas=[])]
        why = self.audit(reports)["indeterminate_reasons"]["tesla_l2"]
        self.assertEqual(why["total"], 2)
        self.assertEqual(why["by_rule"], {"RESP-IND-1": 2})
        self.assertEqual(why["missing_fields"]["sv_movement"], 2)
        self.assertEqual(why["missing_fields"]["sv_contact_areas"], 1)


if __name__ == "__main__":
    unittest.main()
