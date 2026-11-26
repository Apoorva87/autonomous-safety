import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from pipeline import config, fetch

CSV_BODY = (
    b'Report ID,Narrative,Make\n'
    b'1,"line one\nline two",Waymo\n'
    b'2,plain,Cruise\n'
    b'3,"quoted, comma",Tesla\n'
)


class FakeResponse:
    def __init__(self, body, headers=None):
        self._body = body
        self.headers = headers or {
            "Last-Modified": "Mon, 16 Jun 2025 00:00:00 GMT",
            "ETag": '"abc123"',
        }

    def read(self):
        return self._body

    def close(self):
        pass


class FetchTests(unittest.TestCase):
    def test_config_lists_six_sgo_files(self):
        keys = [f["key"] for f in config.SGO_FILES]
        self.assertEqual(
            keys,
            ["current_ADS", "current_ADAS", "current_OTHER",
             "archive_ADS", "archive_ADAS", "archive_OTHER"],
        )
        for f in config.SGO_FILES:
            self.assertIn(f["era"], ("current", "archive"))
            self.assertIn(f["kind"], ("ADS", "ADAS", "OTHER"))
            self.assertTrue(f["url"].startswith("https://static.nhtsa.gov/odi/ffdd/sgo-2021-01/"))
            self.assertTrue(f["url"].endswith(f"_{f['kind']}.csv"))
            self.assertEqual("Archive-2021-2025" in f["url"], f["era"] == "archive")

    def test_fetch_records_hash_and_rows(self):
        requests = []

        def opener(req, timeout=None):
            requests.append((req, timeout))
            return FakeResponse(CSV_BODY)

        with tempfile.TemporaryDirectory() as tmp:
            raw_dir = Path(tmp) / "raw"
            log_path = Path(tmp) / "registry" / "fetch_log.json"
            entries = fetch.fetch_all(raw_dir, opener=opener, log_path=log_path)

            self.assertEqual(len(entries), 6)
            entry = next(e for e in entries if e["key"] == "current_ADS")
            self.assertEqual(entry["rows"], 3)  # csv rows, not 5 lines
            self.assertEqual(entry["sha256"], hashlib.sha256(CSV_BODY).hexdigest())
            self.assertEqual(entry["bytes"], len(CSV_BODY))
            self.assertEqual(entry["etag"], '"abc123"')
            self.assertEqual(entry["last_modified"], "Mon, 16 Jun 2025 00:00:00 GMT")
            self.assertEqual(entry["url"], config.SGO_FILES[0]["url"])
            self.assertTrue(entry["retrieved_at"])
            self.assertEqual((raw_dir / "current_ADS.csv").read_bytes(), CSV_BODY)

            logged = json.loads(log_path.read_text())
            self.assertEqual(logged, entries)

        req, timeout = requests[0]
        self.assertEqual(timeout, 120)
        self.assertIn("Mozilla", req.get_header("User-agent"))

    def test_retries_then_succeeds(self):
        calls = {"n": 0}
        sleeps = []

        def opener(req, timeout=None):
            calls["n"] += 1
            if calls["n"] < 3:
                raise OSError("boom")
            return FakeResponse(CSV_BODY)

        with tempfile.TemporaryDirectory() as tmp:
            f = config.SGO_FILES[0]
            entry = fetch.fetch_one(f, Path(tmp), opener=opener, sleep=sleeps.append)
        self.assertEqual(entry["rows"], 3)
        self.assertEqual(calls["n"], 3)
        self.assertEqual(len(sleeps), 2)

    def test_gives_up_after_three_attempts(self):
        def opener(req, timeout=None):
            raise OSError("down")

        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(OSError):
                fetch.fetch_one(config.SGO_FILES[0], Path(tmp), opener=opener, sleep=lambda s: None)


if __name__ == "__main__":
    unittest.main()
