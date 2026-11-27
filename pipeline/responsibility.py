"""Responsibility lens, pass 1: an inferred, rules-based label per current report.

NHTSA records no fault. Every label here is an INFERENCE from structured golden
fields ("inferred, not a finding of fault"), carries its evidence basis, the
rule that produced it and a confidence. Labels are per report (each report's own
subject vehicle), so an incident reported by two programs gets one label per
report. They live in the golden `labels` table with label_set LABEL_SET.

Labels (what the label says about the subject vehicle, SV = the program's own
vehicle, CP = the crash partner):
  other_party                 the pre-crash movement and contact areas point to another
                              party's action (struck while stopped, struck from behind ...)
  subject_vehicle_initiated   the SV's own motion started the contact (left its lane,
                              hit a fixed object while moving ...)
  indeterminate               the structured fields do not support an inference

The first matching rule wins (RULES is in evaluation order). One rule has basis
"narrative": RESP-NAR-1 reads the narrative (readable ones only) for a rider opening a door
or exiting, and turns the field rules RESP-OTH-1 and RESP-SUB-3 into indeterminate.
Retired rules are kept in RETIRED_RULES. Level-2 programs
(tesla_l2, gm_supercruise, other_l2) cannot separate the human driver from the
system in NHTSA data: their "subject_vehicle_initiated" says so through
agent_hint = "driver_or_system" and never names either.

Pure functions: classify_report, build_labels, merge_labels, build_outputs. The
JSONL writer is write_labels; the run (pipeline.run) calls them in that order.

Contact areas use golden's normalized vocabulary (schema.CONTACT_AREA_SUFFIXES):
front, front_left, front_right, left, right, rear, rear_left, rear_right, top,
bottom, unknown. "Known" contact means the list minus "unknown".
"""
import datetime
import json
import os
import re
from collections import Counter, defaultdict
from pathlib import Path

from . import golden

LABEL_SET = "responsibility_rules_v1"
RULES_VERSION = "2"
MODEL = "rules"
BASIS = "field"
DISCLAIMER = (
    "Inferred, not a finding of fault. NHTSA's Standing General Order data records no fault. Each label is a rules-based "
    "inference from the structured fields of one report (pre-crash movements, contact areas, crash partner, speed), "
    "with the evidence basis and a confidence. Level 2 driver-assist programs cannot separate the human driver from "
    "the system in NHTSA data, so their own-motion label does not say which."
)

OTHER_PARTY = "other_party"
SV_INITIATED = "subject_vehicle_initiated"
INDETERMINATE = "indeterminate"
LABELS = (OTHER_PARTY, SV_INITIATED, INDETERMINATE)
CONFIDENCES = ("high", "medium", "low")

ADS_PROGRAMS = frozenset({"waymo_ads", "zoox_ads", "gm_cruise_ads", "tesla_robotaxi", "other_ads"})
L2_PROGRAMS = frozenset({"tesla_l2", "gm_supercruise", "other_l2"})

# ------------------------------------------------------------------ vocabulary
FRONT = frozenset({"front", "front_left", "front_right"})
REAR = frozenset({"rear", "rear_left", "rear_right"})
FRONT_OR_SIDE = FRONT | {"left", "right"}
STILL = frozenset({"stopped", "parked"})
# Movements that say nothing structured about what the SV was doing.
UNCERTAIN_MOVEMENT = frozenset({None, "unknown", "other", "parking_maneuver"})
# A crash partner that is not another road user: nobody else acted.
NON_AGENT_PARTNERS = frozenset({"fixed_object", "pole_tree", "animal"})
CP_MANEUVERS = frozenset({
    "changing_lanes", "left_turn", "right_turn", "entering_traffic", "backing", "wrong_way",
    "crossing_opposing_lane", "u_turn", "merging", "passing",
})
SV_MANEUVERS = frozenset({
    "changing_lanes", "left_turn", "right_turn", "backing", "merging", "u_turn", "entering_traffic", "passing",
})
UNKNOWN_VALUES = frozenset({None, "", "unknown"})
WRONG_WAY_PARTNERS = frozenset({"wrong_way", "crossing_opposing_lane"})
# Narrative cues for a rider opening a door or exiting (word-boundary, case-insensitive): (name, pattern).
DOOR_CUES = [
    ("opened the door", re.compile(r"\bopened (?:(?:his|her|their|a|an|the) )?(?:[a-z'\-]+ ){0,3}?door\b", re.IGNORECASE)),
    ("dooring", re.compile(r"\bdooring\b", re.IGNORECASE)),
    ("exiting the vehicle", re.compile(r"\bexiting the vehicle\b", re.IGNORECASE)),
    ("exited the vehicle", re.compile(r"\bexited the vehicle\b", re.IGNORECASE)),
    ("passenger exit", re.compile(r"\bpassenger exit\b", re.IGNORECASE)),
]


def door_cue(text):
    """Name of the first door/exit cue in a narrative, or None."""
    for name, pattern in DOOR_CUES:
        if pattern.search(text or ""):
            return name
    return None

# One entry per rule, in evaluation order (the first match wins).
RULES = [
    {"id": "RESP-NAR-1", "label": INDETERMINATE, "confidence": "low",
     "description": "Narrative basis, readable narratives only: the field rules RESP-OTH-1 or RESP-SUB-3 would "
                    "apply but the narrative mentions a rider opening a door or exiting (cues: " + ", ".join(
                        n for n, _ in DOOR_CUES) + "), so the contact may be the subject vehicle's own occupant's "
                    "doing and no inference is made."},
    {"id": "RESP-OTH-1", "label": OTHER_PARTY, "confidence": "high",
     "description": "SV stopped or parked, with any known SV contact area, and the crash partner is another road "
                    "user (not a fixed object, pole, tree or animal): the other party moved into it."},
    {"id": "RESP-IND-2", "label": INDETERMINATE, "confidence": "low",
     "description": "SV lane/road departure that conflicts with the other fields, so no inference: contact only at "
                    "the rear against another road user, or a partner that was going the wrong way or crossing "
                    "into the opposing lane (the departure may have been evasive)."},
    {"id": "RESP-OTH-2", "label": OTHER_PARTY, "confidence": "high",
     "description": "SV contact only at the rear (rear, rear left, rear right), the SV movement is known and not "
                    "backing or a parking maneuver, and the crash partner is another road user: struck from behind."},
    {"id": "RESP-OTH-4", "label": OTHER_PARTY, "confidence": "medium",
     "description": "SV contact only at the rear and a road-user partner, but the SV movement is unknown, other or a "
                    "parking maneuver, so backing cannot be ruled out."},
    {"id": "RESP-SUB-1", "label": SV_INITIATED, "confidence": "high",
     "description": "SV pre-crash movement is lane or road departure."},
    {"id": "RESP-SUB-2", "label": SV_INITIATED, "confidence": "high",
     "description": "Crash with a fixed object, pole or tree, or an animal while the SV was moving "
                    "(a moving movement, or speed above zero without a stopped or parked movement)."},
    {"id": "RESP-SUB-3", "label": SV_INITIATED, "confidence": "medium",
     "description": "SV contact only at the front, the crash partner was stopped or parked, and the SV was moving."},
    {"id": "RESP-OTH-3", "label": OTHER_PARTY, "confidence": "medium",
     "description": "The crash partner was maneuvering (lane change, turn, entering traffic, backing, wrong way, "
                    "crossing the opposing lane, U-turn, merging, passing) while the SV went straight or was "
                    "stopped, and the known SV contact is not front-only."},
    {"id": "RESP-IND-1", "label": INDETERMINATE, "confidence": "low",
     "description": "SV pre-crash movement or SV contact area is missing or unknown, so no rule can apply."},
    {"id": "RESP-IND-4", "label": INDETERMINATE, "confidence": "low",
     "description": "SV was manoeuvring (lane change, turn, backing, merging, U-turn, entering traffic, passing) "
                    "and no earlier rule applies: the evidence does not show who initiated contact."},
    {"id": "RESP-IND-3", "label": INDETERMINATE, "confidence": "low",
     "description": "The fields are known but the combination matches none of the rules."},
]
RETIRED_RULES = [
    {"id": "RESP-SUB-4", "label": SV_INITIATED, "confidence": "low", "retired_in": "2",
     "description": "SV maneuver (lane change, turn, backing, merging, U-turn, entering traffic, passing) with "
                    "front or side contact and a partner going straight, stopped or parked.",
     "reason": "Disagreed with narrative cues in 27 of 30 comparable reports (usually another vehicle struck the "
               "subject vehicle during its maneuver); those reports are now indeterminate (RESP-IND-4)."},
]
RULE_IDS = tuple(r["id"] for r in RULES)
_RULE = {r["id"]: r for r in RULES}


# -------------------------------------------------------------------- helpers
def _contacts(report):
    """The known SV contact areas as a set (empty when none, missing or only 'unknown')."""
    return {a for a in (report.get("sv_contact_areas") or []) if a != "unknown"}


def _road_partner(report):
    """The crash partner is another road user, or not known (a fixed object or animal is not)."""
    return report.get("crash_with") not in NON_AGENT_PARTNERS


def _sv_moving(report):
    """The SV was moving: a moving movement, or speed above zero when the movement is not stopped or parked."""
    movement = report.get("sv_movement")
    if movement in STILL:
        return False
    if movement not in UNCERTAIN_MOVEMENT:
        return True
    speed = report.get("speed_mph")
    return isinstance(speed, (int, float)) and speed > 0


def _missing(report):
    """Names of the key fields that carry no usable value."""
    names = []
    if report.get("sv_movement") in UNKNOWN_VALUES or report.get("sv_movement") == "other":
        names.append("sv_movement")
    if not _contacts(report):
        names.append("sv_contact_areas")
    if report.get("crash_with") in UNKNOWN_VALUES or report.get("crash_with") == "other":
        names.append("crash_with")
    if _road_partner(report) and report.get("cp_movement") in UNKNOWN_VALUES | {"other"}:
        names.append("cp_movement")
    return names


def _evidence(report, *fields):
    out = {}
    for field in fields:
        value = report.get(field)
        out[field] = sorted(value) if isinstance(value, (list, set, tuple)) else value
    return out


def _fmt(value):
    """A value as plain words for a rationale (front_left -> front left)."""
    if isinstance(value, (list, set, tuple)):
        return ", ".join(v.replace("_", " ") for v in sorted(value)) or "none"
    return "none" if value in (None, "") else str(value).replace("_", " ")


def _agent_hint(report, label):
    if label != SV_INITIATED:
        return None
    program = report.get("program")
    if program in ADS_PROGRAMS:
        return "ads"
    if program in L2_PROGRAMS:
        return "driver_or_system"
    return None


# ------------------------------------------------------------------- the rules
def _rule_oth_1(r):
    if r.get("sv_movement") in STILL and _contacts(r) and _road_partner(r):
        return (
            ("sv_movement", "sv_contact_areas", "crash_with"),
            "The subject vehicle was %s and was contacted at %s, which points to the other party moving into it."
            % (_fmt(r["sv_movement"]), _fmt(_contacts(r))),
        )


def _rear_only(r):
    contacts = _contacts(r)
    return bool(contacts) and contacts <= REAR and _road_partner(r)


def _rule_ind_2(r):
    if r.get("sv_movement") != "lane_departure":
        return None
    if _rear_only(r):
        return (
            ("sv_movement", "sv_contact_areas", "crash_with"),
            "The subject vehicle left its lane or road but was contacted only at the rear, so the fields conflict "
            "and no inference is made.",
        )
    if r.get("cp_movement") in WRONG_WAY_PARTNERS:
        return (
            ("sv_movement", "cp_movement"),
            "The subject vehicle left its lane or road while the crash partner was %s, so the fields conflict (the "
            "departure may have been evasive) and no inference is made." % _fmt(r["cp_movement"]),
        )


def _rule_oth_2(r):
    if _rear_only(r) and r.get("sv_movement") not in UNCERTAIN_MOVEMENT and r.get("sv_movement") != "backing":
        return (
            ("sv_movement", "sv_contact_areas", "crash_with"),
            "The subject vehicle was contacted only at %s while %s, which points to being struck from behind."
            % (_fmt(_contacts(r)), _fmt(r["sv_movement"])),
        )


def _rule_oth_4(r):
    if _rear_only(r) and r.get("sv_movement") != "backing":
        return (
            ("sv_movement", "sv_contact_areas", "crash_with"),
            "The subject vehicle was contacted only at %s, which points to being struck from behind, but its "
            "movement (%s) cannot rule out backing." % (_fmt(_contacts(r)), _fmt(r.get("sv_movement"))),
        )


def _rule_sub_1(r):
    if r.get("sv_movement") == "lane_departure":
        return (
            ("sv_movement",),
            "The subject vehicle's pre-crash movement was a lane or road departure, which is its own motion.",
        )


def _rule_sub_2(r):
    if r.get("crash_with") in NON_AGENT_PARTNERS and _sv_moving(r):
        return (
            ("crash_with", "sv_movement", "speed_mph"),
            "The subject vehicle was moving (%s) when it hit %s, and nobody else was involved in the motion."
            % (_fmt(r.get("sv_movement")) + (", unknown speed" if r.get("speed_mph") is None
                                              else ", %s mph" % r["speed_mph"]), _fmt(r["crash_with"])),
        )


def _rule_sub_3(r):
    contacts = _contacts(r)
    if contacts and contacts <= FRONT and r.get("cp_movement") in STILL and _sv_moving(r):
        return (
            ("sv_contact_areas", "cp_movement", "sv_movement", "speed_mph"),
            "The subject vehicle was moving and contacted only with its front a partner that was %s."
            % _fmt(r["cp_movement"]),
        )


def _rule_oth_3(r):
    contacts = _contacts(r)
    if (r.get("cp_movement") in CP_MANEUVERS and r.get("sv_movement") in ("proceeding_straight", "stopped")
            and contacts and not contacts <= FRONT):
        return (
            ("cp_movement", "sv_movement", "sv_contact_areas"),
            "The crash partner was maneuvering (%s) while the subject vehicle was %s and contacted at %s."
            % (_fmt(r["cp_movement"]), _fmt(r["sv_movement"]), _fmt(contacts)),
        )


def _rule_ind_4(r):
    if r.get("sv_movement") in SV_MANEUVERS:
        return (
            ("sv_movement", "sv_contact_areas", "cp_movement"),
            "The subject vehicle was manoeuvring but the evidence does not show who initiated contact.",
        )


def _rule_ind_1(r):
    missing = _missing(r)
    if "sv_movement" in missing or "sv_contact_areas" in missing:
        return (
            ("sv_movement", "sv_contact_areas", "crash_with", "cp_movement"),
            "Not enough structured data to infer: %s is missing or unknown." % ", ".join(missing),
        )


def _rule_ind_3(r):
    return (
        ("sv_movement", "sv_contact_areas", "crash_with", "cp_movement"),
        "The recorded combination (sv_movement=%s, sv_contact_areas=%s, crash_with=%s, cp_movement=%s) matches no "
        "rule." % (_fmt(r.get("sv_movement")), _fmt(_contacts(r)), _fmt(r.get("crash_with")), _fmt(r.get("cp_movement"))),
    )


_TESTS = {
    "RESP-OTH-1": _rule_oth_1, "RESP-IND-2": _rule_ind_2, "RESP-OTH-2": _rule_oth_2, "RESP-OTH-4": _rule_oth_4,
    "RESP-SUB-1": _rule_sub_1, "RESP-SUB-2": _rule_sub_2, "RESP-SUB-3": _rule_sub_3, "RESP-OTH-3": _rule_oth_3,
    "RESP-IND-1": _rule_ind_1, "RESP-IND-4": _rule_ind_4, "RESP-IND-3": _rule_ind_3,
}
GUARDED_RULES = ("RESP-OTH-1", "RESP-SUB-3")
GUARD_RULE = "RESP-NAR-1"
assert [i for i in RULE_IDS if i != GUARD_RULE] == list(_TESTS)


def _readable_narrative(report):
    text = (report.get("raw") or {}).get("Narrative") or ""
    return text if text.strip() and not report.get("narrative_redacted") else ""


def classify_report(report):
    """The inferred label of one report: first matching rule wins.

    Returns {label, rule, confidence, basis, evidence_fields, rationale, agent_hint}.
    """
    for rule_id in _TESTS:
        hit = _TESTS[rule_id](report)
        if hit is None:
            continue
        fields, rationale = hit
        evidence = _evidence(report, *fields)
        cue = door_cue(_readable_narrative(report)) if rule_id in GUARDED_RULES else None
        if cue:  # narrative guard: a rider's door or exit may explain the contact
            rule = _RULE[GUARD_RULE]
            evidence.update(field_rule=rule_id, narrative_cue=cue)
            return {
                "label": INDETERMINATE, "rule": GUARD_RULE, "confidence": rule["confidence"], "basis": "narrative",
                "evidence_fields": evidence, "agent_hint": None,
                "rationale": "The fields would give %s, but the narrative mentions a rider opening a door or "
                             "exiting (%s), so the contact may be the subject vehicle's own occupant's doing and "
                             "no inference is made." % (rule_id, cue),
            }
        rule = _RULE[rule_id]
        if report.get("program") in L2_PROGRAMS and report.get("engagement_status") == "verified_not_engaged":
            evidence["engagement_status"] = "verified_not_engaged"
            if rule["label"] == SV_INITIATED:
                rationale = rationale[:-1] + "; the report states the automation was verified not engaged."
        return {
            "label": rule["label"], "rule": rule_id, "confidence": rule["confidence"], "basis": BASIS,
            "evidence_fields": evidence, "rationale": rationale, "agent_hint": _agent_hint(report, rule["label"]),
        }
    raise AssertionError("RESP-IND-3 matches every report")  # pragma: no cover


# ---------------------------------------------------------------------- labels
def run_at(run_id):
    """The label timestamp for a run id: its UTC stamp as ISO text, or the id itself when it is not a stamp."""
    try:
        parsed = datetime.datetime.strptime(run_id, "%Y%m%dT%H%M%SZ")
    except (TypeError, ValueError):
        return run_id
    return parsed.strftime("%Y-%m-%dT%H:%M:%SZ")


def is_current(report):
    return bool(report["is_latest"]) and not report["is_placeholder"] and report["removed_in_run"] is None


def build_labels(reports, run_id, previous=()):
    """One label row per current report, sorted by report_key.

    previous  earlier label rows; a report whose label is unchanged keeps its earlier
              run_at, so an unchanged refresh rewrites no label row (like the reports table).
    """
    before = {r["report_key"]: r for r in previous if r.get("label_set") == LABEL_SET}
    stamp = run_at(run_id)
    rows = []
    for report in sorted((r for r in reports if is_current(r)), key=lambda r: r["report_key"]):
        result = classify_report(report)
        row = {
            "report_key": report["report_key"], "label_set": LABEL_SET, "label": result["label"],
            "rationale": result["rationale"], "evidence_fields": result["evidence_fields"], "model": MODEL,
            "prompt_version": RULES_VERSION, "run_at": stamp, "rule": result["rule"],
            "confidence": result["confidence"], "basis": result["basis"], "agent_hint": result["agent_hint"],
        }
        old = before.get(row["report_key"])
        if old is not None and {k: v for k, v in old.items() if k != "run_at"} == {k: v for k, v in row.items() if k != "run_at"}:
            row["run_at"] = old["run_at"]
        rows.append(row)
    return rows


def _label_sort_key(row):
    return tuple("" if row.get(k) is None else str(row[k]) for k in golden.TABLE_SORT_KEYS["labels"])


def merge_labels(existing, rows):
    """The new labels.jsonl bytes: `rows` replace every row of LABEL_SET, all other rows stay as they are.

    This is the only function that changes label rows. Foreign rows keep their
    exact bytes (not even re-serialized); the result is sorted like the labels
    table, so the same inputs always give the same bytes.
    """
    kept = []
    for line in existing.splitlines(keepends=True):
        if not line.strip():
            continue
        row = json.loads(line)
        if row.get("label_set") != LABEL_SET:
            kept.append((_label_sort_key(row), line if line.endswith(b"\n") else line + b"\n"))
    kept.extend((_label_sort_key(r), golden.dumps_row(r).encode("utf-8") + b"\n") for r in rows)
    return b"".join(line for _, line in sorted(kept, key=lambda pair: pair[0]))


def labels_path(golden_dir):
    return Path(golden_dir) / "labels.jsonl"


def read_existing(golden_dir):
    path = labels_path(golden_dir)
    return path.read_bytes() if path.exists() else b""


def write_labels(golden_dir, payload):
    """Atomically replace labels.jsonl with the bytes merge_labels returned."""
    path = labels_path(golden_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name("." + path.name + ".tmp")
    try:
        temp.write_bytes(payload)
        os.replace(temp, path)
    except BaseException:
        if temp.exists():
            temp.unlink()
        raise


def parse_labels(payload):
    return [json.loads(line) for line in payload.splitlines() if line.strip()]


# --------------------------------------------------------------- site exports
OUTPUT_FILES = ("responsibility.json", "responsibility_rules.json", "responsibility_audit.json")
FIELDS = ["report_id", "report_key", "incident_key", "program", "month", "label", "confidence", "basis", "rule",
          "agent_hint",
          # Display fields of the report itself (not of the incident's primary report), so every row can be drawn alone.
          "severity", "sv_movement", "cp_movement", "crash_with", "sv_contact_areas", "speed_band",
          "automation_engaged", "evidence"]


def _evidence_pairs(evidence):
    """The label's evidence fields as sorted 'field=value' strings (lists joined by ';'); no narrative text."""
    pairs = []
    for field in sorted(evidence or {}):
        value = evidence[field]
        if isinstance(value, (list, tuple, set)):
            value = ";".join(str(v) for v in sorted(value))
        pairs.append("%s=%s" % (field, "" if value is None else value))
    return pairs
LABEL_MEANINGS = {
    OTHER_PARTY: "The structured fields point to another party's action (for example struck from behind).",
    SV_INITIATED: "The structured fields point to the subject vehicle's own motion starting the contact.",
    INDETERMINATE: "The structured fields do not support an inference.",
}
AGENT_HINTS = {
    "ads": "Subject vehicle is an automated driving system program: its own motion is the system's.",
    "driver_or_system": "Level 2 driver assistance: NHTSA data cannot separate the human driver from the system.",
}


def _current_labels(reports, labels):
    """[(report, label row)] for current reports with a LABEL_SET label, sorted by report_key."""
    by_key = {l["report_key"]: l for l in labels if l.get("label_set") == LABEL_SET}
    out = [(r, by_key[r["report_key"]]) for r in reports if is_current(r) and r["report_key"] in by_key]
    return sorted(out, key=lambda pair: pair[0]["report_key"])


def build_responsibility(pairs, run_id):
    # Evidence is dictionary-encoded: each row's "evidence" is an index into "evidence_sets" (about 2,000 distinct
    # sets for 9,000 rows), listed in order of first use so the file is deterministic.
    evidence_sets, index = [], {}
    rows = []
    for r, l in pairs:
        pairs_ = _evidence_pairs(l.get("evidence_fields"))
        key = tuple(pairs_)
        if key not in index:
            index[key] = len(evidence_sets)
            evidence_sets.append(pairs_)
        rows.append([
            r["report_id"], r["report_key"], r["incident_key"], r["program"], r["month"], l["label"], l["confidence"],
            l["basis"], l["rule"], l["agent_hint"],
            r.get("severity"), r.get("sv_movement"), r.get("cp_movement"), r.get("crash_with"),
            list(r.get("sv_contact_areas") or []), r.get("speed_band"), r.get("automation_engaged"), index[key],
        ])
    counts = {}
    for r, l in pairs:
        slot = counts.setdefault(r["program"], {}).setdefault(l["label"], {})
        slot[l["confidence"]] = slot.get(l["confidence"], 0) + 1
    return {
        "label_set": LABEL_SET, "rules_version": RULES_VERSION, "generated_for_run": run_id, "disclaimer": DISCLAIMER,
        "fields": list(FIELDS), "evidence_sets": evidence_sets, "rows": rows, "summary": {"counts": counts},
    }


def build_rules():
    return {
        "label_set": LABEL_SET, "rules_version": RULES_VERSION, "disclaimer": DISCLAIMER,
        "labels": [{"label": label, "meaning": LABEL_MEANINGS[label]} for label in LABELS],
        "agent_hints": AGENT_HINTS, "rules": RULES, "retired_rules": RETIRED_RULES,
    }


# ------------------------------------------------------------------ the audit
AUDIT_DISCLAIMER = (
    "A rough keyword audit of readable narratives against the pass 1 labels, not ground truth: the cues are simple "
    "phrases, a narrative can contain both kinds, and most narratives are redacted or absent. " + DISCLAIMER
)
_AV = r"(?:(?:the |an? )?(?:[a-z0-9\-]+ )?(?:av|ads|autonomous vehicle|robotaxi)|(?:the )?zoox vehicle|(?:the )?subject vehicle|(?:the )?sv|waymo|zoox|cruise)"
# The AV is the actor only at the start of a clause ("... of the AV made contact" is not).
_CLAUSE = r"(?:^|[.;:,]\s+|\b(?:and|when|as|then|but|while|that|until|before|after|which)\s+)"
_FLAGS = re.IGNORECASE
_SV_VERBS = r"(?:then |subsequently |slowly |also )?(?:hit|struck|collided with|made contact with|contacted|ran into|clipped|scraped|drove into|rear[- ]?ended)"
# (cue name, pattern); a narrative that matches any other-party cue has an "other" cue.
OTHER_CUES = [
    ("struck from behind", re.compile(r"\b(?:struck|hit|collided|rear-ended|crashed)\b[^.]{0,50}\bfrom behind\b", _FLAGS)),
    ("rear-ended", re.compile(r"\b(?:was|were|been|being|got) rear[- ]?ended\b|\brear[- ]?ended (?:by|the " + _AV + r")\b", _FLAGS)),
    ("was struck/hit/contacted by", re.compile(r"\bwas (?:struck|hit|contacted|sideswiped) by\b", _FLAGS)),
    ("contacted a part of the AV", re.compile(
        r"\b(?:collided with|struck|hit|made contact with|contacted|sideswiped) the (?:[a-z'\-]+ ){0,5}?of " + _AV + r"\b", _FLAGS)),
    ("hit/struck/contacted the AV", re.compile(r"\b(?:hit|struck|collided with|made contact with|contacted|sideswiped) the " + _AV + r"\b", _FLAGS)),
    ("while stationary", re.compile(
        r"\bwhile stationary\b|\b" + _AV + r" (?:was|remained) stationary\b", _FLAGS)),
]
SV_CUES = [
    ("AV hit/struck/contacted", re.compile(_CLAUSE + _AV + r"(?:'s (?:[a-z\-]+ ){0,4}?| )" + _SV_VERBS + r"\b", _FLAGS)),
    ("contacted a parked/stationary/stopped", re.compile(r"\bcontacted an? (?:parked|stationary|stopped)\b", _FLAGS)),
]
AUDIT_EXAMPLES = 15


def narrative_cue(text):
    """(kind, matched cue names) for a narrative: kind is other, subject_vehicle, both or none."""
    text = text or ""
    other = [name for name, pattern in OTHER_CUES if pattern.search(text)]
    sv = [name for name, pattern in SV_CUES if pattern.search(text)]
    kind = "both" if other and sv else "other" if other else "subject_vehicle" if sv else "none"
    return kind, "; ".join(other + sv)


def _expected_cue(label):
    return {OTHER_PARTY: "other", SV_INITIATED: "subject_vehicle"}.get(label)


def _round_robin(groups, limit):
    """Up to `limit` items, one from each group in turn (groups sorted by key, items in given order)."""
    queues = [list(items) for _, items in sorted(groups.items())]
    out = []
    while queues and len(out) < limit:
        for queue in list(queues):
            out.append(queue.pop(0))
            if not queue:
                queues.remove(queue)
            if len(out) == limit:
                break
    return out


def build_audit(pairs, run_id):
    comparison, disagreements = {}, defaultdict(list)
    by_program, by_confidence, reasons = {}, {}, {}
    for report, label in pairs:
        program = report["program"]
        by_program.setdefault(program, Counter())[label["label"]] += 1
        by_confidence.setdefault(program, Counter())[label["confidence"]] += 1
        if label["label"] == INDETERMINATE:
            slot = reasons.setdefault(program, {"total": 0, "by_rule": Counter(), "missing_fields": Counter()})
            slot["total"] += 1
            slot["by_rule"][label["rule"]] += 1
            for name in _missing(report):
                slot["missing_fields"][name] += 1
        text = (report.get("raw") or {}).get("Narrative") or ""
        if report.get("narrative_redacted") or not text.strip():
            continue
        cue, matched = narrative_cue(text)
        slot = comparison.setdefault(program, {
            "readable_narratives": 0, "confusion": {}, "agree": 0, "disagree": 0, "agreement_rate": None})
        slot["readable_narratives"] += 1
        cell = slot["confusion"].setdefault(label["label"], {})
        cell[cue] = cell.get(cue, 0) + 1
        expected = _expected_cue(label["label"])
        if expected and cue in ("other", "subject_vehicle"):
            if cue == expected:
                slot["agree"] += 1
            else:
                slot["disagree"] += 1
                disagreements[(program, label["rule"])].append({
                    "report_id": report["report_id"], "report_key": report["report_key"], "program": program,
                    "rule": label["rule"], "label": label["label"], "cue": cue,
                    "reason": "%s gives %s but the narrative cue (%s) points to %s."
                              % (label["rule"], label["label"], matched, cue.replace("_", " ")),
                })
    for slot in comparison.values():
        total = slot["agree"] + slot["disagree"]
        slot["agreement_rate"] = round(slot["agree"] / total, 4) if total else None
    for items in disagreements.values():
        items.sort(key=lambda e: e["report_key"])
    return {
        "label_set": LABEL_SET, "rules_version": RULES_VERSION, "generated_for_run": run_id,
        "disclaimer": AUDIT_DISCLAIMER,
        "cues": {"other_party": [n for n, _ in OTHER_CUES], "subject_vehicle": [n for n, _ in SV_CUES]},
        "comparison": comparison,
        "disagreement_examples": _round_robin(disagreements, AUDIT_EXAMPLES),
        "distribution": {
            "by_program": {p: dict(sorted(c.items())) for p, c in sorted(by_program.items())},
            "by_confidence": {p: dict(sorted(c.items())) for p, c in sorted(by_confidence.items())},
        },
        "indeterminate_reasons": {
            p: {"total": s["total"], "by_rule": dict(sorted(s["by_rule"].items())),
                "missing_fields": dict(sorted(s["missing_fields"].items()))}
            for p, s in sorted(reasons.items())
        },
    }


def build_outputs(reports, labels, run_id):
    """{file name: JSON-able object} for the three responsibility site files."""
    pairs = _current_labels(reports, labels)
    return {
        "responsibility.json": build_responsibility(pairs, run_id),
        "responsibility_rules.json": build_rules(),
        "responsibility_audit.json": build_audit(pairs, run_id),
    }
