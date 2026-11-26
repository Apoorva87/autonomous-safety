import datetime
import json
import tempfile
import unittest
from pathlib import Path

from pipeline import export_preview as ex
from pipeline import harmonize

FIXTURES = Path(__file__).resolve().parent / "fixtures"

FETCH_LOG = [
    {"key": "a", "url": "u1", "retrieved_at": "2026-11-26T21:28:45Z", "last_modified": "Mon, 16 Nov 2026 13:31:10 GMT",
     "etag": "x", "sha256": "s1", "bytes": 1, "rows": 2},
    {"key": "b", "url": "u2", "retrieved_at": "2026-11-26T21:28:46Z", "last_modified": "Tue, 12 Aug 2025 13:28:43 GMT",
     "etag": "y", "sha256": "s2", "bytes": 3, "rows": 4},
]


def rec(id, key, severity="none", program="waymo_ads", month="2025-01", **kw):
    base = {
        "id": id, "incident_key": key, "era": "current", "entity": "E", "company": "waymo", "program": program,
        "month": month, "lag_days": 30, "make": None, "model": None, "model_year": None, "city": None, "state": "CA",
        "roadway_type": "street", "surface": None, "lighting": None, "weather": [], "speed_mph": 10, "speed_limit": None,
        "crash_with": "suv", "cp_movement": None, "sv_movement": "stopped", "severity": severity, "hospitalized": None,
        "airbag": None, "towed": None, "within_odd": "yes", "narrative": "secret text", "narrative_redacted": False,
        "version_redacted": False, "file": "ADS", "ver": 1, "submitted": None, "unknown_fields": 0,
    }
    base.update(kw)
    return base


class ExportTests(unittest.TestCase):
    def test_incident_severity_is_max_and_dedupes(self):
        records = [
            rec("1", "K", "minor", month="2025-01"),
            rec("2", "K", "serious", program="gm_cruise_ads", month="2025-01"),
            rec("3", "J", "unknown"),
            rec("4", "J", "none"),
            rec("5", "solo", "fatal", month=None),
        ]
        crashes = ex.unique_crashes(records)
        self.assertEqual(len(crashes), 3)
        by_key = {r["incident_key"]: (r, n) for r, n in crashes}
        self.assertEqual(by_key["K"][0]["severity"], "serious")
        self.assertEqual(by_key["K"][0]["program"], "gm_cruise_ads")  # representative report
        self.assertEqual(by_key["K"][1], 2)
        self.assertEqual(by_key["J"][0]["severity"], "none")  # known beats unknown

        counts = ex.build_counts(crashes)
        self.assertEqual(counts["counts"]["gm_cruise_ads"]["2025-01"], {"serious": 1})
        self.assertEqual(counts["counts"]["waymo_ads"]["2025-01"], {"none": 1})
        self.assertEqual(counts["counts"]["waymo_ads"]["undated"], {"fatal": 1})
        total = sum(n for p in counts["counts"].values() for m in p.values() for n in m.values())
        self.assertEqual(total, len(crashes))

    def test_records_json_has_no_narrative_and_columnar(self):
        crashes = ex.unique_crashes([rec("1", "K", crash_with="pedestrian")])
        out = ex.build_records(crashes)
        self.assertEqual(out["fields"], ex.RECORD_FIELDS)
        self.assertNotIn("narrative", out["fields"])
        self.assertNotIn("secret text", json.dumps(out))
        row = dict(zip(out["fields"], out["rows"][0]))
        self.assertIn("vru:f", row["tags"])
        self.assertEqual(row["speed_band"], "6-15")
        self.assertEqual(row["n_reports"], 1)

    def test_transparency_shares(self):
        records = [
            rec("1", "a", program="tesla_l2", narrative_redacted=True, version_redacted=True, crash_with="unknown",
                within_odd="redacted", era="archive", lighting="daylight"),
            rec("2", "b", program="tesla_l2", narrative_redacted=False, version_redacted=True, era="current"),
        ]
        t = ex.build_transparency(records)
        cells = t["cells"]["tesla_l2"]
        self.assertEqual(cells["narrative"]["redacted"], 0.5)
        self.assertEqual(cells["version"]["redacted"], 1.0)
        self.assertEqual(cells["crash_with"]["unknown"], 0.5)
        self.assertEqual(cells["within_odd"]["redacted"], 0.5)
        # archive-only field: only the archive-era report counts
        self.assertEqual(cells["lighting"]["n"], 1)
        self.assertEqual(cells["lighting"]["provided"], 1.0)
        for field in t["fields"]:
            c = cells[field]
            self.assertAlmostEqual(c["provided"] + c["unknown"] + c["redacted"], 1.0)

    def test_fixture_end_to_end(self):
        records = harmonize.load_all(FIXTURES, allow_missing=True)
        skipped = harmonize.SKIPPED_PLACEHOLDERS
        self.assertGreater(skipped, 0)
        outputs = ex.build_all(records, FETCH_LOG, skipped, datetime.date(2026, 11, 26))
        with tempfile.TemporaryDirectory() as tmp:
            ex.write_all(outputs, Path(tmp) / "data")
            for name in ("records.json", "counts.json", "transparency.json", "meta.json"):
                self.assertTrue((Path(tmp, "data", name)).exists())
            meta = json.loads(Path(tmp, "data", "meta.json").read_text())
        self.assertEqual(meta["total_reports"], len(records))
        self.assertEqual(meta["total_incidents"], len(outputs["records.json"]["rows"]))
        self.assertEqual(meta["placeholder_rows_skipped"], skipped)
        self.assertEqual(meta["nhtsa_last_modified"], "2026-11-16")
        self.assertEqual(meta["fetched_date"], "2026-11-26")
        self.assertEqual(meta["run_date"], "2026-11-26")


if __name__ == "__main__":
    unittest.main()
