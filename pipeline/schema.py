"""Constants and value maps for harmonizing NHTSA SGO 2021-01 CSVs.

Everything here is data. The loading and transformation logic is in harmonize.py.

Value maps are explicit: each known source label is listed, and there is no
catch-all. A label that is not in a map is recorded in UNMAPPED by
harmonize.py so it surfaces in validation (Task 5) instead of being hidden.
The maps were built from the distinct values in the six raw files as of the
2026-11 fetch.
"""

# (field, raw value) pairs for categorical values missing from the maps below.
# harmonize.load_all() clears this at the start of every load.
UNMAPPED = set()

REDACTION_MARKER = "[REDACTED, MAY CONTAIN CONFIDENTIAL BUSINESS INFORMATION]"

# --------------------------------------------------------------------------
# Frozen column sets, generated once from the live files (2026-11 fetch) and
# pasted in. They are NOT computed at runtime. Within an era the three file
# kinds (ADS, ADAS, OTHER) have identical columns: 137 for archive, 116 for
# current. A schema change upstream shows up as a mismatch against these.
# --------------------------------------------------------------------------
_ARCHIVE_COLUMNS = frozenset({
    'ADAS/ADS Hardware Version',
    'ADAS/ADS Hardware Version - Unk',
    'ADAS/ADS Hardware Version CBI',
    'ADAS/ADS Software Version',
    'ADAS/ADS Software Version - Unk',
    'ADAS/ADS Software Version CBI',
    'ADAS/ADS System Version',
    'ADAS/ADS System Version - Unk',
    'ADAS/ADS System Version CBI',
    'ADS Equipped?',
    'Address',
    'Address - Unknown',
    'Automation System Engaged?',
    'CP Any Air Bags Deployed?',
    'CP Contact Area - Bottom',
    'CP Contact Area - Front',
    'CP Contact Area - Front Left',
    'CP Contact Area - Front Right',
    'CP Contact Area - Left',
    'CP Contact Area - Rear',
    'CP Contact Area - Rear Left',
    'CP Contact Area - Rear Right',
    'CP Contact Area - Right',
    'CP Contact Area - Top',
    'CP Contact Area - Unknown',
    'CP Pre-Crash Movement',
    'CP Was Vehicle Towed?',
    'City',
    'City - Unknown',
    'Crash With',
    'Data Availability - Complaints',
    'Data Availability - EDR',
    'Data Availability - No Data',
    'Data Availability - Other',
    'Data Availability - Police Rpt',
    'Data Availability - Telematics',
    'Data Availability - Unknown',
    'Data Availability - Video',
    'Driver / Operator Type',
    'Federal Reg. Exemption - No',
    'Federal Reg. Exemption - Unk',
    'Federal Regulatory Exemption?',
    'Highest Injury Severity Alleged',
    'Incident Date',
    'Incident Date - Unknown',
    'Incident Time (24:00)',
    'Incident Time - Unknown',
    'Inv. Officer Email - Unknown',
    'Inv. Officer Name - Unknown',
    'Inv. Officer Phone - Unknown',
    'Investigating Agency',
    'Investigating Agency - Unknown',
    'Investigating Officer Email',
    'Investigating Officer Name',
    'Investigating Officer Phone',
    'Latitude',
    'Latitude - Unknown',
    'Law Enforcement Investigating?',
    'Lighting',
    'Longitude',
    'Longitude - Unknown',
    'Make',
    'Mileage',
    'Mileage - Unknown',
    'Model',
    'Model - Unknown',
    'Model Year',
    'Model Year - Unknown',
    'Narrative',
    'Narrative - CBI?',
    'Notice Received Date',
    'Operating Entity',
    'Operating Entity - Unknown',
    'Other Federal Reg. Exemption',
    'Other Reporting Entities?',
    'Other Reporting Entities? - NA',
    'Other Reporting Entities? - Unk',
    'Posted Speed Limit (MPH)',
    'Posted Speed Limit - Unknown',
    'Property Damage?',
    'Rep Ent Or Mfr Investigating?',
    'Report ID',
    'Report Month',
    'Report Submission Date',
    'Report Type',
    'Report Version',
    'Report Year',
    'Reporting Entity',
    'Roadway Description',
    'Roadway Surface',
    'Roadway Type',
    'SV Any Air Bags Deployed?',
    'SV Contact Area - Bottom',
    'SV Contact Area - Front',
    'SV Contact Area - Front Left',
    'SV Contact Area - Front Right',
    'SV Contact Area - Left',
    'SV Contact Area - Rear',
    'SV Contact Area - Rear Left',
    'SV Contact Area - Rear Right',
    'SV Contact Area - Right',
    'SV Contact Area - Top',
    'SV Contact Area - Unknown',
    'SV Pre-Crash Movement',
    'SV Pre-crash Speed - Unknown',
    'SV Precrash Speed (MPH)',
    'SV Was Vehicle Towed?',
    'SV Were All Passengers Belted?',
    'Same Incident ID',
    'Same Vehicle ID',
    'Serial Number',
    'Source - Complaint/Claim',
    'Source - Field Report',
    'Source - Law Enforcement',
    'Source - Media',
    'Source - Other',
    'Source - Other Text',
    'Source - Telematics',
    'Source - Testing',
    'State',
    'State or Local Permit',
    'State or Local Permit?',
    'VIN',
    'VIN - Unknown',
    'Weather - Clear',
    'Weather - Cloudy',
    'Weather - Fog/Smoke',
    'Weather - Other',
    'Weather - Other Text',
    'Weather - Rain',
    'Weather - Severe Wind',
    'Weather - Snow',
    'Weather - Unknown',
    'Within ODD?',
    'Within ODD? - CBI',
    'Zip Code',
    'Zip Code - Unknown',
})

_CURRENT_COLUMNS = frozenset({
    'Address',
    'Address - Unknown',
    'Any Air Bags Deployed?',
    'Automation Feature Version',
    'Automation Feature Version CBI',
    'Automation System Engaged?',
    'CP Contact Area - Bottom',
    'CP Contact Area - Front',
    'CP Contact Area - Front Left',
    'CP Contact Area - Front Right',
    'CP Contact Area - Left',
    'CP Contact Area - Rear',
    'CP Contact Area - Rear Left',
    'CP Contact Area - Rear Right',
    'CP Contact Area - Right',
    'CP Contact Area - Top',
    'CP Contact Area - Unknown',
    'CP Pre-Crash Movement',
    'City',
    'City - Unknown',
    'Crash With',
    'Data Availability - Complaints',
    'Data Availability - EDR',
    'Data Availability - No Data',
    'Data Availability - Other',
    'Data Availability - Police Rpt',
    'Data Availability - Telematics',
    'Data Availability - Unknown',
    'Data Availability - Video',
    'Driver / Operator Type',
    'Engagement Status',
    'Highest Injury Severity Alleged',
    'Incident Date',
    'Incident Date - Unknown',
    'Incident Time (24:00)',
    'Incident Time - Unknown',
    'Investigating Agency',
    'Investigating Agency - Unknown',
    'Latitude',
    'Latitude - Unknown',
    'Longitude',
    'Longitude - Unknown',
    'Make',
    'Make - Unknown',
    'Model',
    'Model - Unknown',
    'Model Year',
    'Model Year - Unknown',
    'Narrative',
    'Narrative - CBI?',
    'Operating Entity',
    'Operating Entity - Unknown',
    'Report ID',
    'Report Month',
    'Report Submission Date',
    'Report Type',
    'Report Version',
    'Report Year',
    'Reporting Entity',
    'Roadway Type',
    'Roadway-Degraded Surface',
    'Roadway-Missing/Degraded Marking',
    'Roadway-No Unusual Conditions',
    'Roadway-Other-See Narrative',
    'Roadway-Traffic Incident',
    'Roadway-Unknown',
    'Roadway-Wet Surface Condition',
    'Roadway-Work Zone',
    'SV Contact Area - Bottom',
    'SV Contact Area - Front',
    'SV Contact Area - Front Left',
    'SV Contact Area - Front Right',
    'SV Contact Area - Left',
    'SV Contact Area - Rear',
    'SV Contact Area - Rear Left',
    'SV Contact Area - Rear Right',
    'SV Contact Area - Right',
    'SV Contact Area - Top',
    'SV Contact Area - Unknown',
    'SV Pre-Crash Movement',
    'SV Pre-crash Speed - Unknown',
    'SV Precrash Speed (MPH)',
    'Same Incident ID',
    'Same Vehicle ID',
    'Serial Number',
    'Source - Complaint/Claim',
    'Source - Field Report',
    'Source - Internal Process Review',
    'Source - Law Enforcement',
    'Source - Media',
    'Source - NHTSA VOQ',
    'Source - Other - See Narrative',
    'Source - Other Entity',
    'Source - State or Other Agency',
    'Source - Telematics',
    'Source - Testing',
    'State',
    'VIN',
    'VIN Decoded',
    'Was Any Vehicle Towed?',
    'Weather - Clear',
    'Weather - Cloudy',
    'Weather - Dust Storm',
    'Weather - Fog/Smoke/Haze',
    'Weather - Partly Cloudy',
    'Weather - Rain',
    'Weather - Severe Hurricane',
    'Weather - Severe Wind',
    'Weather - Snow',
    'Weather - Structure-Indoor',
    'Weather - Unk - See Narrative',
    'Were All Passengers Belted?',
    'Within ODD?',
    'Within ODD? - CBI',
    'Zip Code',
    'Zip Code - Unknown',
})

EXPECTED_COLUMNS = {
    "archive_ADS": _ARCHIVE_COLUMNS,
    "archive_ADAS": _ARCHIVE_COLUMNS,
    "archive_OTHER": _ARCHIVE_COLUMNS,
    "current_ADS": _CURRENT_COLUMNS,
    "current_ADAS": _CURRENT_COLUMNS,
    "current_OTHER": _CURRENT_COLUMNS,
}

# --------------------------------------------------------------------------
# Column -> field maps. A field whose column does not exist in an era is None
# there (never imputed): current drops Lighting, Roadway Surface, Posted Speed
# Limit and the separate SV/CP airbag/towed columns, and renames the version
# columns.
# --------------------------------------------------------------------------
_COMMON_COLUMNS = {
    "id": "Report ID",
    "ver": "Report Version",
    "report_type": "Report Type",
    "entity": "Reporting Entity",
    "engaged": "Automation System Engaged?",
    "submitted": "Report Submission Date",
    "incident_date": "Incident Date",
    "same_incident_id": "Same Incident ID",
    "make": "Make",
    "model": "Model",
    "model_year": "Model Year",
    "city": "City",
    "state": "State",
    "roadway_type": "Roadway Type",
    "speed_mph": "SV Precrash Speed (MPH)",
    "crash_with": "Crash With",
    "cp_movement": "CP Pre-Crash Movement",
    "sv_movement": "SV Pre-Crash Movement",
    "severity": "Highest Injury Severity Alleged",
    "within_odd": "Within ODD?",
    "narrative": "Narrative",
    "narrative_cbi": "Narrative - CBI?",
}

COLUMNS = {
    "archive": {
        **_COMMON_COLUMNS,
        "surface": "Roadway Surface",
        "lighting": "Lighting",
        "speed_limit": "Posted Speed Limit (MPH)",
        "version_text": "ADAS/ADS System Version",
        "version_cbi": "ADAS/ADS System Version CBI",
        # Airbag and towed are split by vehicle in archive.
        "airbag_sv": "SV Any Air Bags Deployed?",
        "airbag_cp": "CP Any Air Bags Deployed?",
        "airbag_combined": None,
        "towed_sv": "SV Was Vehicle Towed?",
        "towed_cp": "CP Was Vehicle Towed?",
        "towed_combined": None,
    },
    "current": {
        **_COMMON_COLUMNS,
        "surface": None,
        "lighting": None,
        "speed_limit": None,
        "version_text": "Automation Feature Version",
        "version_cbi": "Automation Feature Version CBI",
        # Airbag and towed are one combined label in current.
        "airbag_sv": None,
        "airbag_cp": None,
        "airbag_combined": "Any Air Bags Deployed?",
        "towed_sv": None,
        "towed_cp": None,
        "towed_combined": "Was Any Vehicle Towed?",
    },
}

# Weather flag columns ('Y' or blank) -> normalized condition, in output order.
# Archive: no Partly Cloudy/Dust Storm/Hurricane/Indoor, and "Other" exists.
# Archive "Weather - Other Text" is free text and is ignored.
WEATHER_COLUMNS = {
    "archive": {
        "Weather - Clear": "clear",
        "Weather - Cloudy": "cloudy",
        "Weather - Snow": "snow",
        "Weather - Fog/Smoke": "fog",
        "Weather - Rain": "rain",
        "Weather - Severe Wind": "severe_wind",
        "Weather - Other": "other",
        "Weather - Unknown": "unknown",
    },
    "current": {
        "Weather - Clear": "clear",
        "Weather - Cloudy": "cloudy",
        "Weather - Partly Cloudy": "partly_cloudy",
        "Weather - Snow": "snow",
        "Weather - Fog/Smoke/Haze": "fog",
        "Weather - Rain": "rain",
        "Weather - Severe Wind": "severe_wind",
        "Weather - Dust Storm": "dust_storm",
        "Weather - Severe Hurricane": "hurricane",
        "Weather - Structure-Indoor": "indoor",
        "Weather - Unk - See Narrative": "unknown",
    },
}

# --------------------------------------------------------------------------
# Value maps. Keys are the stripped source labels.
# --------------------------------------------------------------------------

# label -> (severity, hospitalized). Archive labels say nothing about
# hospitalization, so it is None there (except "No Injuries Reported": nobody
# was hurt). Current labels spell it out. Fatality and Unknown carry no
# hospitalization information in either era. A blank label (two non-placeholder
# archive_OTHER rows) is treated as unknown.
SEVERITY_ARCHIVE = {
    "Fatality": ("fatal", None),
    "Serious": ("serious", None),
    "Moderate": ("moderate", None),
    "Minor": ("minor", None),
    "No Injuries Reported": ("none", False),
    "Unknown": ("unknown", None),
    "": ("unknown", None),
}
SEVERITY_CURRENT = {
    "Fatality": ("fatal", None),
    "Serious W/ Hospitalization": ("serious", True),
    "Serious W/O Hospitalization": ("serious", False),
    "Moderate W/ Hospitalization": ("moderate", True),
    "Moderate W/O Hospitalization": ("moderate", False),
    "Minor W/ Hospitalization": ("minor", True),
    "Minor W/O Hospitalization": ("minor", False),
    "No Injured Reported": ("none", False),
    "Property Damage. No Injured Reported": ("none", False),
    "Unknown": ("unknown", None),
    "": ("unknown", None),
}
SEVERITY = {"archive": SEVERITY_ARCHIVE, "current": SEVERITY_CURRENT}

LIGHTING = {  # archive only
    "Daylight": "daylight",
    "Dawn / Dusk": "dawn_dusk",
    "Dark - Lighted": "dark_lighted",
    "Dark - Not Lighted": "dark_unlit",
    "Dark - Unknown Lighting": "dark_unknown",
    "Other, see Narrative": "other",
    "Unknown": "unknown",
}

ROADWAY_TYPE = {
    "Highway / Freeway": "highway",
    "Intersection": "intersection",
    "Street": "street",
    "Parking Lot": "parking_lot",
    "Parking Garage": "parking_garage",
    "Rural Road": "rural_road",
    "Traffic Circle": "traffic_circle",
    "Unpaved Road": "unpaved_road",
    "Unknown": "unknown",
}

SURFACE = {  # archive only
    "Dry": "dry",
    "Wet": "wet",
    "Snow / Slush / Ice": "snow_ice",
    "Other, see Narrative": "other",
    "Unknown": "unknown",
}

CRASH_WITH = {
    "Passenger Car": "passenger_car",
    "SUV": "suv",
    "Pickup Truck": "pickup_truck",
    "Van": "van",
    "Bus": "bus",
    "Heavy Truck": "heavy_truck",
    "Motorcycle": "motorcycle",
    "First Responder Vehicle": "first_responder_vehicle",
    "Non-Motorist: Pedestrian": "pedestrian",
    "Non-Motorist: Cyclist": "cyclist",
    "Non-Motorist: Scooter - Skateboard": "scooter_skateboard",
    "Non-Motorist: Other": "non_motorist_other",
    "Animal": "animal",
    "Pole / Tree": "pole_tree",
    "Other Fixed Object": "fixed_object",
    "Other, see Narrative": "other",
    "Unknown": "unknown",
}

# Shared by SV and CP pre-crash movement.
MOVEMENT = {
    "Proceeding Straight": "proceeding_straight",
    "Stopped": "stopped",
    "Parked": "parked",
    "Parking Maneuver": "parking_maneuver",
    "Backing": "backing",
    "Changing Lanes": "changing_lanes",
    "Merging": "merging",
    "Passing": "passing",
    "Entering Traffic": "entering_traffic",
    "Making Left Turn": "left_turn",
    "Making Right Turn": "right_turn",
    "Making U-Turn": "u_turn",
    "Crossing into Opposing Lane": "crossing_opposing_lane",
    "Lane / Road Departure": "lane_departure",
    "Traveling Wrong Way": "wrong_way",
    "NM Crossing Roadway": "nm_crossing_roadway",
    "NM Moving on Sidewalk": "nm_on_sidewalk",
    "NM Moving Alongside Roadway": "nm_alongside_roadway",
    "NM Waiting to Cross Roadway": "nm_waiting_to_cross",
    "NM in Roadway - Other": "nm_in_roadway_other",
    "Other, see Narrative": "other",
    "Unknown": "unknown",
}

# Within ODD? -> "yes" | "no" | "exiting" | "unknown" | "redacted".
# The redaction marker is a distinct value (not "unknown"): the operator
# withheld the answer as confidential. Blank is None.
WITHIN_ODD = {
    "Yes": "yes",
    "No, see Narrative": "no",
    "Exiting ODD": "exiting",
    "Unknown, see Narrative": "unknown",
    REDACTION_MARKER: "redacted",
}

# Archive airbag/towed per-vehicle answers. "blank" (no answer given) is
# treated like unknown when combining, and "na" means the vehicle did not exist
# (for example a fixed-object crash has no crash partner).
FLAG_ARCHIVE = {
    "Yes": "yes",
    "No": "no",
    "Unknown": "unknown",
    "Not Applicable": "na",
    "": "blank",
}

# Current combined airbag/towed label -> (subject vehicle, crash partner).
FLAG_CURRENT = {
    "Yes Subject Vehicle, Yes Crash Partner": ("yes", "yes"),
    "Yes Subject Vehicle, No Crash Partner": ("yes", "no"),
    "Yes Subject Vehicle, Unknown Crash Partner": ("yes", "unknown"),
    "No Subject Vehicle, No Crash Partner": ("no", "no"),
    "No Subject Vehicle, Unknown Crash Partner": ("no", "unknown"),
    "Yes Crash Partner, No Subject Vehicle": ("no", "yes"),
    "Yes Crash Partner, Unknown Subject Vehicle": ("unknown", "yes"),
    "No Crash Partner, Unknown Subject Vehicle": ("unknown", "no"),
    "Unknown": ("unknown", "unknown"),
    "Not Applicable": ("na", "na"),
}

# Automation System Engaged? (used only for OTHER-file rows) -> mode.
ENGAGED_MODE = {
    "ADS": "ads",
    "ADAS": "l2",
    "Unknown, see Narrative": "unknown",
    "": "unknown",
}

# --------------------------------------------------------------------------
# Company and program.
# --------------------------------------------------------------------------
COMPANY_BY_ENTITY = {
    "Tesla, Inc.": "tesla",
    "General Motors, LLC": "gm",
    "Cruise LLC": "gm",
    "Waymo LLC": "waymo",
    "Zoox, Inc.": "zoox",
}
# Any entity not listed above is company "other".

# (company, mode) -> program, mode being "ads" or "l2". Waymo and Zoox only
# have an ADS program, so both modes map to it; the same goes for Cruise LLC,
# which is handled by ENTITY_PROGRAM_OVERRIDE.
PROGRAM_BY_COMPANY_MODE = {
    ("tesla", "ads"): "tesla_robotaxi",
    ("tesla", "l2"): "tesla_l2",
    ("gm", "ads"): "gm_cruise_ads",
    ("gm", "l2"): "gm_supercruise",
    ("waymo", "ads"): "waymo_ads",
    ("waymo", "l2"): "waymo_ads",
    ("zoox", "ads"): "zoox_ads",
    ("zoox", "l2"): "zoox_ads",
    ("other", "ads"): "other_ads",
    ("other", "l2"): "other_l2",
}
# Cruise LLC is always the Cruise ADS program, whatever file it is in.
ENTITY_PROGRAM_OVERRIDE = {"Cruise LLC": "gm_cruise_ads"}

# --------------------------------------------------------------------------
# Rules and constants.
# --------------------------------------------------------------------------
PLACEHOLDER_REPORT_TYPE = "No New or Updated Incident Reports"

# Narrative redaction (see harmonize.is_narrative_redacted): blank, or the
# redaction markers cover at least this share of the text. When the narrative
# CBI flag is 'Y' the operator asserted confidentiality, so the lower threshold
# applies.
NARRATIVE_REDACTED_COVERAGE = 0.5
NARRATIVE_REDACTED_COVERAGE_CBI = 0.25

# Incident months before this year are source placeholders (JAN-1900), not
# dates. Real pre-2021 incident months (2019, 2020) are kept.
MIN_INCIDENT_YEAR = 2000

# Text values that mean "not known" for free-text fields; stored as None.
UNKNOWN_TEXT = frozenset({"", "unknown", "unk"})

# unknown_fields counts, for each of these record fields, a value that is
# unknown, blank or redacted. All of them exist in both eras, so the count is
# comparable across eras (Lighting and Roadway Surface are archive-only and are
# deliberately excluded).
UNKNOWN_FIELD_KEYS = (
    "month",
    "state",
    "city",
    "roadway_type",
    "weather",
    "crash_with",
    "severity",
    "sv_movement",
    "cp_movement",
    "speed_mph",
    "within_odd",
    "airbag",
    "towed",
    "narrative",
)
