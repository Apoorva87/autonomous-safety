"""Derived per-report classes that the 2025-06-16 reporting-rule change makes necessary.

Pure functions, standard library only. aggregate.py applies them to the golden rows.

1. Threshold-robust severity class (`robust`).
   NHTSA's Third Amended Standing General Order (effective 2025-06-16) changed which crashes must be
   reported. Under the earlier orders an ADS crash was reportable at almost any contact, and a Level 2
   crash when it involved a fatality, a hospital-treated injury, a vulnerable road user (VRU), an air bag
   deployment or a tow-away. After the change the data show that minor ADS crashes without injury, air bag
   or tow-away largely stopped arriving (Waymo: no-injury, no-airbag, not-towed crashes per mile fell to a
   third while the rest stayed flat), and that tow-away-only Level 2 reports nearly vanished (Tesla:
   tow-only reports fell from about 20% to 1-4% of reports, air bag reports rose to 97-99%).
   A crash is "robust" when it meets a criterion that is reportable under BOTH regimes for its kind group:

     ADS programs: any injury (minor, moderate, serious) or a fatality, OR an air bag deployed (any
                   vehicle), OR any vehicle towed, OR a VRU crash partner (structured fields).
     Level 2:      any injury or a fatality, OR an air bag deployed, OR a VRU crash partner.
                   Tow-away alone does not count, because it appears not to be a stand-alone Level 2
                   criterion after the change.

   Uncertainty (also in ROBUST_DEFINITION, published in meta.json and on the Data & sources tab):
   - the definition rests on the pattern in the data, not on a re-reading of the order's legal text;
   - "any injury" includes injuries without hospital treatment, which an ADS crash had to report before
     the change and still reports (the current file has "Minor W/O Hospitalization" ADS reports); for
     Level 2 the archive labels do not say whether an injury was hospital-treated;
   - a field that is unknown counts as "not met", so the class is a lower bound. Air bag is unknown in
     about 15% of archive-era reports (mostly Level 2) and towed is unknown in about 92% of current-era
     Level 2 reports (towed is not used for Level 2) and in a few percent of ADS reports;
   - Tesla Level 2 severity is unknown in about 94% of reports, so its robust class is close to
     "air bag deployed".

2. Hour and light condition.
   `hour` is the local hour (0-23) of the golden incident_time. Tesla, Inc. files its times in UTC (see TIME_RULE),
   so its times are converted to the local time of the report's state first. `light_from_time` is an approximate light
   condition from the clock time and the month: day, twilight or night. It uses one US-wide table of
   approximate sunrise and sunset times (latitude 37 N, the 15th of each month, solar noon 20 minutes
   after the time-zone meridian, daylight saving time March to October except Arizona and Hawaii), and a
   +-60 minute "twilight" band around sunrise and sunset to absorb latitude, longitude-within-zone and
   day-of-month differences. It is an approximation, never a measurement.
   `light_condition` is the recorded Lighting field where the report has one (archive era, through
   2025-06-15: basis "recorded"), else light_from_time (basis "derived from time"), else "unknown".
"""
import math

ADS_GROUP = "ads"
L2_GROUP = "l2"
PROGRAM_GROUP = {
    "waymo_ads": ADS_GROUP, "gm_cruise_ads": ADS_GROUP, "zoox_ads": ADS_GROUP, "tesla_robotaxi": ADS_GROUP,
    "other_ads": ADS_GROUP, "tesla_l2": L2_GROUP, "gm_supercruise": L2_GROUP, "other_l2": L2_GROUP,
}

INJURY = ("minor", "moderate", "serious")
VRU_PARTNERS = ("pedestrian", "cyclist", "scooter_skateboard", "non_motorist_other")
CRITERIA = ("fatality", "injury", "airbag", "towed", "vru")

ROBUST_DEFINITION = {
    "name": "Injury, air bag, tow-away (ADS) or VRU: comparable across the 2025-06-16 rule change",
    "short": "threshold-robust crashes",
    "ads": "Any injury or fatality, or an air bag deployed (any vehicle), or any vehicle towed, or a pedestrian, cyclist, "
           "scooter/skateboard or other non-motorist crash partner (structured fields).",
    "l2": "Any injury or fatality, or an air bag deployed, or a pedestrian, cyclist, scooter/skateboard or other non-motorist "
          "crash partner. A tow-away alone does not count for Level 2.",
    "why": "Under the Third Amended SGO (effective 2025-06-16) minor ADS crashes without injury, air bag or tow-away largely "
           "stopped being reported, and tow-away-only Level 2 reports nearly vanished. Crashes meeting these criteria were "
           "reportable before and after the change, so their counts can be compared across it.",
    "uncertainty": [
        "Inferred from the data pattern (Waymo: no-injury, no-airbag, not-towed crashes per mile fell to a third at the change "
        "while the rest stayed flat; Tesla: tow-only reports fell from about 20% to 1-4%), not from a re-reading of the order's text.",
        "A criterion whose field is unknown counts as not met, so the class is a lower bound. Air bag is unknown in about 15% of "
        "archive-era reports (mostly Level 2); towed is unknown in about 92% of current-era Level 2 reports (towed is not used for "
        "Level 2) and in a few percent of ADS reports.",
        "Any injury includes injuries without hospital treatment. The archive severity labels do not say whether an injury was "
        "hospital-treated.",
        "Tesla Level 2 severity is unknown in about 94% of reports, so its robust class is close to 'air bag deployed'.",
    ],
}


def group_of(program):
    """'ads', 'l2' or None for a program key."""
    return PROGRAM_GROUP.get(program)


def is_vru(report):
    """A structured vulnerable-road-user partner: crash_with, or a non-motorist partner movement."""
    return report.get("crash_with") in VRU_PARTNERS or (report.get("cp_movement") or "").startswith("nm_")


def robust_criteria(report, group=None):
    """The criteria (in CRITERIA order) that a report meets and that are reportable under both regimes."""
    group = group or group_of(report.get("program"))
    hits = []
    severity = report.get("severity")
    if severity == "fatal":
        hits.append("fatality")
    if severity in INJURY:
        hits.append("injury")
    if report.get("airbag") is True:
        hits.append("airbag")
    if group == ADS_GROUP and report.get("towed") is True:
        hits.append("towed")
    if is_vru(report):
        hits.append("vru")
    return hits


def is_robust(report, group=None):
    return bool(robust_criteria(report, group))


# -------------------------------------------------------------- clock time
# Tesla, Inc. files incident times in UTC, not local time. Evidence (archive era, where a Lighting field exists):
# recorded Lighting agrees with the light derived from the time as filed in 55% of Tesla's day/night reports, and in
# 96% after a 6 hour shift; the best shift per state matches that state's time zone (California -7, Texas -6,
# Florida -4, Georgia -5), while every other reporter agrees best with no shift (Waymo 100%, GM 99%). In the current
# era Tesla Robotaxi (Austin) has no crash between 04:00 and 11:00 as filed, which is 23:00-06:00 local. Tesla times
# are therefore converted from UTC to the local time of the report's state (majority time zone, daylight saving time
# March to October by incident month, since the day is not published); without a state the hour is unknown.
UTC_ENTITIES = frozenset({"Tesla, Inc."})
STATE_UTC_OFFSET = {  # standard-time offset of the state's most populous time zone, hours
    **{s: -5 for s in ("CT", "DC", "DE", "FL", "GA", "IN", "KY", "MA", "MD", "ME", "MI", "NC", "NH", "NJ", "NY", "OH",
                       "PA", "RI", "SC", "VA", "VT", "WV")},
    **{s: -6 for s in ("AL", "AR", "IA", "IL", "KS", "LA", "MN", "MO", "MS", "ND", "NE", "OK", "SD", "TN", "TX", "WI")},
    **{s: -7 for s in ("AZ", "CO", "ID", "MT", "NM", "UT", "WY")},
    **{s: -8 for s in ("CA", "NV", "OR", "WA")},
    "AK": -9, "HI": -10, "PR": -4, "VI": -4, "GU": 10,
}
NO_DST = frozenset({"AZ", "HI", "PR", "VI", "GU"})
TIME_RULE = (
    "Incident times are used as filed (local time), except Tesla, Inc. reports, which are filed in UTC: those are converted "
    "to the local time of the report's state (most populous time zone; daylight saving time March to October by incident "
    "month). Evidence: in the archive file Tesla's recorded Lighting agrees with the time-derived light in 55% of day/night "
    "reports as filed and 96% after converting; every other reporter agrees best as filed."
)


def utc_offset_hours(state, month_text):
    """Local UTC offset in hours for a state and 'YYYY-MM', or None for an unknown state."""
    std = STATE_UTC_OFFSET.get((state or "").upper())
    if std is None:
        return None
    try:
        month = int((month_text or "")[5:7])
    except ValueError:
        month = 0
    return std + (1 if month in DST_MONTHS and (state or "").upper() not in NO_DST else 0)


def local_time(report):
    """(local 'HH:MM' or None, basis): 'as filed', or 'converted from UTC' for UTC filers (None without a state)."""
    text = report.get("incident_time")
    if report.get("entity") not in UTC_ENTITIES:
        return (text if parse_minutes(text) is not None else None), "as filed"
    minutes = parse_minutes(text)
    offset = utc_offset_hours(report.get("state"), report.get("month"))
    if minutes is None or offset is None:
        return None, "converted from UTC"
    return _clock(minutes + offset * 60), "converted from UTC"


# ------------------------------------------------------------------- light
SUN_LATITUDE = 37.0
SOLAR_NOON_OFFSET_MIN = 20  # typical US position west of the time-zone meridian, minutes
TWILIGHT_BAND_MIN = 60
DST_MONTHS = frozenset(range(3, 11))  # mid-month dates in daylight saving time: 15 March to 15 October
NO_DST_STATES = frozenset({"AZ", "HI"})
_MID_MONTH_DOY = (15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349)
RECORDED_LIGHT = {
    "daylight": "day", "dawn_dusk": "twilight", "dark_lighted": "night", "dark_unlit": "night", "dark_unknown": "night",
}
LIGHT_CLASSES = ("day", "twilight", "night", "unknown")
LIGHT_RULE = (
    "Approximate light condition from the incident clock time and month: one US-wide table of sunrise and sunset "
    "(latitude %d N, the 15th of the month, solar noon %d minutes after the time-zone meridian, daylight saving time "
    "March to October except Arizona and Hawaii) with a +-%d minute twilight band around sunrise and sunset. "
    "Night = more than %d minutes after sunset or before sunrise. Approximate: actual light depends on the exact place "
    "and date, which the public data does not give."
    % (SUN_LATITUDE, SOLAR_NOON_OFFSET_MIN, TWILIGHT_BAND_MIN, TWILIGHT_BAND_MIN)
)


def _sun_times(doy, latitude=SUN_LATITUDE):
    """(sunrise, sunset) in minutes after midnight, local standard time, for a day of the year."""
    b = math.radians(360.0 / 365.0 * (doy - 81))
    declination = math.radians(23.44) * math.sin(b)
    eot = 9.87 * math.sin(2 * b) - 7.53 * math.cos(b) - 1.5 * math.sin(b)  # minutes
    phi = math.radians(latitude)
    cos_h = (math.sin(math.radians(-0.833)) - math.sin(phi) * math.sin(declination)) / (math.cos(phi) * math.cos(declination))
    half_day = math.degrees(math.acos(max(-1.0, min(1.0, cos_h)))) * 4.0  # minutes
    noon = 720.0 - eot + SOLAR_NOON_OFFSET_MIN
    return int(round(noon - half_day)), int(round(noon + half_day))


# month (1-12) -> (sunrise, sunset), minutes after midnight in local STANDARD time.
SUN_TABLE = {m + 1: _sun_times(doy) for m, doy in enumerate(_MID_MONTH_DOY)}


def sun_table_clock():
    """The table as published: month -> {'sunrise': 'HH:MM', 'sunset': 'HH:MM'} in local clock time (with DST)."""
    out = {}
    for month, (rise, sett) in sorted(SUN_TABLE.items()):
        shift = 60 if month in DST_MONTHS else 0
        out["%02d" % month] = {"sunrise": _clock(rise + shift), "sunset": _clock(sett + shift)}
    return out


def _clock(minutes):
    return "%02d:%02d" % divmod(int(minutes) % 1440, 60)


def parse_minutes(time_text):
    """'HH:MM' -> minutes after midnight, or None."""
    if not time_text or len(time_text) < 4 or ":" not in time_text:
        return None
    try:
        h, m = time_text.split(":", 1)
        h, m = int(h), int(m)
    except ValueError:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return h * 60 + m


def hour_of(time_text):
    minutes = parse_minutes(time_text)
    return None if minutes is None else minutes // 60


def light_from_time(time_text, month_text, state=None):
    """'day' | 'twilight' | 'night' | 'unknown' from an 'HH:MM' time and a 'YYYY-MM' month (approximate)."""
    minutes = parse_minutes(time_text)
    if minutes is None or not month_text or len(month_text) < 7:
        return "unknown"
    try:
        month = int(month_text[5:7])
    except ValueError:
        return "unknown"
    if month not in SUN_TABLE:
        return "unknown"
    rise, sett = SUN_TABLE[month]
    if month in DST_MONTHS and (state or "").upper() not in NO_DST_STATES:
        rise, sett = rise + 60, sett + 60
    band = TWILIGHT_BAND_MIN
    if minutes < rise - band or minutes >= sett + band:
        return "night"
    if minutes < rise + band or minutes >= sett - band:
        return "twilight"
    return "day"


def light_from_report(report):
    """light_from_time on the report's local time (Tesla converted from UTC)."""
    return light_from_time(local_time(report)[0], report.get("month"), report.get("state"))


def light_condition(report):
    """(condition, basis): recorded Lighting when the report has a known one, else derived from time, else unknown."""
    recorded = RECORDED_LIGHT.get(report.get("lighting"))
    if recorded:
        return recorded, "recorded"
    derived = light_from_report(report)
    if derived != "unknown":
        return derived, "derived from time"
    return "unknown", None


def night_clock(hour):
    """The fixed 21:00-05:59 clock window used for the night share (no approximation), or None without an hour."""
    if hour is None:
        return None
    return hour >= 21 or hour < 6


# -------------------------------------------------------------- lag months
def month_number(month_text):
    """'YYYY-MM' (or a 'YYYY-MM-DD' date) -> months since year 0, or None."""
    if not month_text or len(month_text) < 7:
        return None
    try:
        return int(month_text[:4]) * 12 + int(month_text[5:7]) - 1
    except ValueError:
        return None


def lag_months(report):
    """Whole months from the incident month to the submission month (floored at 0), or None."""
    a, b = month_number(report.get("month")), month_number(report.get("submitted"))
    if a is None or b is None:
        return None
    return max(0, b - a)
