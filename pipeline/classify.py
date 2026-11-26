"""Transparent failure-pattern tagging (spec section 8).

tag(record) returns 0..n tags, at most one per tag name `t`:
    {"t": <tag>, "basis": "field" | "narrative", "rule": <rule id>}

Every tag records its basis. "field" means a structured SGO column decided it;
"narrative" means a keyword match in the free-text narrative. The distinction
matters because some reporters (notably Tesla) redact nearly every narrative
while others (Waymo) do not, so narrative-basis tags are not comparable across
companies. A redacted narrative produces no narrative-basis tags at all.

RULES is the published rule table (id, t, basis, description) shown on the Data
tab. The descriptions embed the keyword lists below, so the page cannot drift
from the code. The matching functions live in _MATCHERS, keyed by rule ID.

Dedupe: if several rules give the same tag, a field-basis rule wins over a
narrative-basis rule; among rules of the same basis the first in RULES order
wins. One entry per tag is recorded.
"""
import re

# ----------------------------------------------------------- keyword lists
# Matched case-insensitively with word boundaries (\bkeyword\b). Multi-word
# entries must appear as written, with single spaces. Plurals are listed
# explicitly. "signal" alone is deliberately absent: it would match "turn signal".
INT_KEYWORDS = (
    "red light", "traffic light", "traffic signal", "stop light", "stoplight",
    "stop sign", "signalized", "ran a light", "ran the light", "run a light",
    "run the light",
)
VIS_KEYWORDS = (
    "glare", "sun", "sunlight", "blinded", "blinding", "low visibility", "poor visibility",
)
HAZ_KEYWORDS = (
    "debris", "stalled", "emergency vehicle", "emergency vehicles", "cone", "cones",
)
VRU_KEYWORDS = (
    "pedestrian", "pedestrians", "cyclist", "cyclists", "bicyclist", "bicyclists",
)

# Field-rule parameters.
DEPARTURE_FIXED_OBJECT_MIN_MPH = 25
LOW_SPEED_MAX_MPH = 5
VIS_LIGHTING = ("dark_unlit", "dark_unknown", "dawn_dusk")
VIS_WEATHER = ("fog", "rain", "snow", "dust_storm")
FIXED_OBJECTS = ("fixed_object", "pole_tree")
HAZARD_CRASH_WITH = ("fixed_object", "pole_tree", "first_responder_vehicle")
NOT_MOVING = ("stopped", "parked", "unknown", None)
VRU_CRASH_WITH = ("pedestrian", "cyclist", "scooter_skateboard", "non_motorist_other")


def _compile(words):
    return re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")\b", re.IGNORECASE)


NARRATIVE_KEYWORDS = {
    "INT-2": INT_KEYWORDS,
    "VIS-3": VIS_KEYWORDS,
    "HAZ-3": HAZ_KEYWORDS,
    "VRU-3": VRU_KEYWORDS,
}
_NARRATIVE_RE = {rule_id: _compile(words) for rule_id, words in NARRATIVE_KEYWORDS.items()}


def _kw(rule_id):
    return ", ".join('"%s"' % w for w in NARRATIVE_KEYWORDS[rule_id])


# ------------------------------------------------------------------- rules
RULES = [
    {
        "id": "INT-1", "t": "intersection_signal", "basis": "field",
        "description": "Roadway type is Intersection.",
    },
    {
        "id": "INT-2", "t": "intersection_signal", "basis": "narrative",
        "description": "Narrative mentions any of: %s. Plain \"signal\" is not matched, "
                       "so a turn signal does not count." % _kw("INT-2"),
    },
    {
        "id": "VIS-1", "t": "visibility_glare", "basis": "field",
        "description": "Lighting is dark and unlit, dark with unknown lighting, or dawn/dusk. "
                       "Dark with street lighting (dark_lighted) does not count, because "
                       "lit roads are not reduced visibility in the way unlit ones are.",
    },
    {
        "id": "VIS-2", "t": "visibility_glare", "basis": "field",
        "description": "Weather includes fog, rain, snow or dust storm.",
    },
    {
        "id": "VIS-3", "t": "visibility_glare", "basis": "narrative",
        "description": "Narrative mentions any of: %s." % _kw("VIS-3"),
    },
    {
        "id": "DEP-1", "t": "roadway_departure", "basis": "field",
        "description": "Subject vehicle movement is Lane / Road Departure.",
    },
    {
        "id": "DEP-2", "t": "roadway_departure", "basis": "field",
        "description": "Crash was with a fixed object or pole/tree and the subject vehicle "
                       "speed was at least %d mph. Unknown speed does not qualify."
                       % DEPARTURE_FIXED_OBJECT_MIN_MPH,
    },
    {
        "id": "HAZ-1", "t": "stationary_hazard", "basis": "field",
        "description": "Subject vehicle was moving (movement is anything except stopped, "
                       "parked, unknown or blank) and the crash partner was stopped or parked.",
    },
    {
        "id": "HAZ-2", "t": "stationary_hazard", "basis": "field",
        "description": "Crash was with a fixed object, pole/tree or first-responder vehicle.",
    },
    {
        "id": "HAZ-3", "t": "stationary_hazard", "basis": "narrative",
        "description": "Narrative mentions any of: %s." % _kw("HAZ-3"),
    },
    {
        "id": "LOW-1", "t": "low_speed", "basis": "field",
        "description": "Subject vehicle speed was at most %d mph (0 counts; unknown does not)."
                       % LOW_SPEED_MAX_MPH,
    },
    {
        "id": "LOW-2", "t": "low_speed", "basis": "field",
        "description": "Subject vehicle movement was stopped or parked (it was struck).",
    },
    {
        "id": "VRU-1", "t": "vru", "basis": "field",
        "description": "Crash was with a pedestrian, cyclist, scooter/skateboard or other "
                       "non-motorist.",
    },
    {
        "id": "VRU-2", "t": "vru", "basis": "field",
        "description": "Crash partner movement is a non-motorist movement (nm_*).",
    },
    {
        "id": "VRU-3", "t": "vru", "basis": "narrative",
        "description": "Narrative mentions any of: %s." % _kw("VRU-3"),
    },
]


def _narrative_hit(rule_id):
    def match(record):
        if record.get("narrative_redacted"):
            return False
        text = record.get("narrative")
        return bool(text) and _NARRATIVE_RE[rule_id].search(text) is not None
    return match


def _dep2(r):
    speed = r.get("speed_mph")
    return (r.get("crash_with") in FIXED_OBJECTS and speed is not None
            and speed >= DEPARTURE_FIXED_OBJECT_MIN_MPH)


def _low1(r):
    speed = r.get("speed_mph")
    return speed is not None and speed <= LOW_SPEED_MAX_MPH


_MATCHERS = {
    "INT-1": lambda r: r.get("roadway_type") == "intersection",
    "INT-2": _narrative_hit("INT-2"),
    "VIS-1": lambda r: r.get("lighting") in VIS_LIGHTING,
    "VIS-2": lambda r: any(w in VIS_WEATHER for w in (r.get("weather") or ())),
    "VIS-3": _narrative_hit("VIS-3"),
    "DEP-1": lambda r: r.get("sv_movement") == "lane_departure",
    "DEP-2": _dep2,
    "HAZ-1": lambda r: (r.get("sv_movement") not in NOT_MOVING
                        and r.get("cp_movement") in ("stopped", "parked")),
    "HAZ-2": lambda r: r.get("crash_with") in HAZARD_CRASH_WITH,
    "HAZ-3": _narrative_hit("HAZ-3"),
    "LOW-1": _low1,
    "LOW-2": lambda r: r.get("sv_movement") in ("stopped", "parked"),
    "VRU-1": lambda r: r.get("crash_with") in VRU_CRASH_WITH,
    "VRU-2": lambda r: (r.get("cp_movement") or "").startswith("nm_"),
    "VRU-3": _narrative_hit("VRU-3"),
}


def tag(record):
    """Tags for one Record: one entry per tag name, field basis preferred."""
    chosen = {}  # t -> rule dict; insertion order follows RULES
    for rule in RULES:
        if not _MATCHERS[rule["id"]](record):
            continue
        current = chosen.get(rule["t"])
        if current is None or (current["basis"] == "narrative" and rule["basis"] == "field"):
            chosen[rule["t"]] = rule
    return [{"t": t, "basis": r["basis"], "rule": r["id"]} for t, r in chosen.items()]


def speed_band(record):
    """Subject-vehicle speed band; unknown when the speed is not reported."""
    speed = record.get("speed_mph")
    if speed is None:
        return "unknown"
    if speed <= 0:
        return "0"
    if speed <= 5:
        return "1-5"
    if speed <= 15:
        return "6-15"
    if speed <= 30:
        return "16-30"
    if speed <= 50:
        return "31-50"
    return "51+"
