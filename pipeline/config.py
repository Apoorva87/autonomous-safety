"""Shared paths and the list of NHTSA SGO 2021-01 source files."""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

RAW_DIR = REPO_ROOT / "data" / "raw"
OUT_DIR = REPO_ROOT / "site" / "public" / "data"
MANUAL_DIR = REPO_ROOT / "data" / "manual"
FETCH_LOG = REPO_ROOT / "data" / "registry" / "fetch_log.json"

_BASE = "https://static.nhtsa.gov/odi/ffdd/sgo-2021-01"

# "current": reports from 2025-06-16 onward.
# "archive": 2021-07 through 2025-06-15.
_ERA_PATHS = {
    "current": _BASE,
    "archive": _BASE + "/Archive-2021-2025",
}

SGO_FILES = [
    {
        "key": f"{era}_{kind}",
        "era": era,
        "kind": kind,
        "url": f"{prefix}/SGO-2021-01_Incident_Reports_{kind}.csv",
    }
    for era, prefix in _ERA_PATHS.items()
    for kind in ("ADS", "ADAS", "OTHER")
]
