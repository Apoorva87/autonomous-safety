import contextlib
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import support
from pipeline import aggregate, config, run


def snapshot(directory):
    """{relative path: sha256} of every file under directory ({} when it does not exist)."""
    directory = Path(directory)
    if not directory.exists():
        return {}
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(directory.rglob("*")) if p.is_file()}


class FakeResponse:
    def __init__(self, body):
        self._body = body
        self.headers = {"Last-Modified": "Mon, 16 Nov 2026 13:31:10 GMT", "ETag": "x"}

    def read(self):
        return self._body

    def close(self):
        pass


class RunBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.raw = support.make_raw_dir(root / "data" / "raw")
        self.golden = root / "data" / "golden"
        self.out = root / "site" / "data"
        self.fetch_log = root / "data" / "registry" / "fetch_log.json"
        self.fetch_log.parent.mkdir(parents=True)
        self.fetch_log.write_text(json.dumps(support.fetch_log_for(self.raw)))
        self.entities = root / "expected_entities.json"
        self.entities.write_text(json.dumps({"entities": support.EXPECTED_ENTITIES}))

    def run_pipeline(self, run_id="r1", offline=True, **kw):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = run.run(
                offline=offline, run_id=run_id, raw_dir=self.raw, manual_dir=config.MANUAL_DIR, golden_dir=self.golden,
                out_dir=self.out, fetch_log_path=self.fetch_log, expected_entities_path=self.entities, **kw)
        return code, out.getvalue(), err.getvalue()

    def state(self):
        return snapshot(self.out), snapshot(self.golden), snapshot(self.raw)


class OfflineRunTests(RunBase):
    def test_offline_run_succeeds_and_writes_every_output(self):
        code, out, err = self.run_pipeline()
        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), sorted(aggregate.OUTPUT_FILES))
        for name in ("reports.jsonl", "runs.jsonl", "incidents.jsonl", "labels.jsonl", "golden.sqlite"):
            self.assertTrue((self.golden / name).exists(), name)
        meta = json.loads((self.out / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(meta["run_id"], "r1")
        self.assertTrue(meta["warnings"])
        for warning in meta["warnings"]:
            self.assertIn(warning, out)  # the run output carries meta.json's warnings
        self.assertIn("crashes by program", out)
        self.assertIs(meta["offline"], True)
        self.assertIn("offline: row-drop checks compare against the previous fetch log only", meta["warnings"])
        self.assertIn("offline: row-drop checks compare against the previous fetch log only", out)

    def test_fixture_run_totals(self):
        self.run_pipeline()
        meta = json.loads((self.out / "meta.json").read_text(encoding="utf-8"))
        counts = json.loads((self.out / "counts.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(sum(r["crashes"] for r in counts["rows"]), meta["counts_total"]["unique_incidents"])
        self.assertEqual(meta["counts_total"]["unique_incidents"], meta["counts_total"]["incidents"])
        self.assertEqual(sum(r["reports"] for r in counts["rows"]), meta["counts_total"]["reports"])

    def test_second_run_prepends_a_changelog_entry(self):
        self.run_pipeline("r1")
        first = json.loads((self.out / "changelog.json").read_text(encoding="utf-8"))["entries"]
        self.assertGreater(first[0]["new_reports"], 0)  # nothing existed before the first run
        self.run_pipeline("r2")
        entries = json.loads((self.out / "changelog.json").read_text(encoding="utf-8"))["entries"]
        self.assertEqual([e["run_id"] for e in entries], ["r2", "r1"])
        self.assertEqual((entries[0]["new_reports"], entries[0]["revised_reports"], entries[0]["removed_reports"]), (0, 0, 0))

    def test_preview_files_keep_the_shapes_the_site_reads(self):
        self.run_pipeline()
        read = lambda n: json.loads((self.out / n).read_text(encoding="utf-8"))  # noqa: E731
        self.assertEqual(set(read("records.json")), {"fields", "rows"})
        self.assertTrue({"severities", "months", "programs", "counts"} <= set(read("counts.json")))
        self.assertTrue({"programs", "fields", "era_limited", "cells"} <= set(read("transparency.json")))
        meta = read("meta.json")
        for key in ("fetched_date", "run_date", "nhtsa_last_modified", "structural_break", "total_reports",
                    "total_incidents", "placeholder_rows_skipped", "first_month", "last_month", "files", "tag_rules"):
            self.assertIn(key, meta)
        self.assertIsInstance(meta["nhtsa_last_modified"], str)


class ResponsibilityRunTests(RunBase):
    def read_labels(self):
        return [json.loads(l) for l in (self.golden / "labels.jsonl").read_text(encoding="utf-8").splitlines() if l.strip()]

    def test_every_current_report_is_labelled_and_exported(self):
        self.assertEqual(self.run_pipeline("20261126T100000Z")[0], 0)
        labels = self.read_labels()
        meta = json.loads((self.out / "meta.json").read_text(encoding="utf-8"))
        self.assertEqual(len(labels), meta["counts_total"]["reports"])
        self.assertEqual({l["label_set"] for l in labels}, {"responsibility_rules_v1"})
        self.assertEqual({l["run_at"] for l in labels}, {"2026-11-26T10:00:00Z"})
        data = json.loads((self.out / "responsibility.json").read_text(encoding="utf-8"))
        self.assertEqual(len(data["rows"]), len(labels))
        self.assertEqual(data["generated_for_run"], "20261126T100000Z")
        for name in ("responsibility_rules.json", "responsibility_audit.json"):
            self.assertTrue((self.out / name).exists(), name)

    def test_sqlite_includes_the_labels(self):
        import sqlite3
        self.run_pipeline()
        con = sqlite3.connect(self.golden / "golden.sqlite")
        try:
            n, rules = con.execute("SELECT count(*), count(rule) FROM labels WHERE label_set = 'responsibility_rules_v1'").fetchone()
        finally:
            con.close()
        self.assertEqual(n, len(self.read_labels()))
        self.assertEqual(rules, n)

    def test_rerun_with_the_same_run_id_is_byte_identical(self):
        self.run_pipeline("r1")
        before = self.state()
        self.assertEqual(self.run_pipeline("r1")[0], 0)
        self.assertEqual(self.state()[:2], before[:2])

    def test_foreign_label_rows_survive_a_regeneration_byte_for_byte(self):
        self.run_pipeline("r1")
        key = self.read_labels()[0]["report_key"]
        foreign = ('{"label":"avoidable","label_set":"llm_v1","model":"m","prompt_version":"p","rationale":"r",'
                   '"report_key":"%s","run_at":"2026-01-01T00:00:00Z","evidence_fields":[]}\n' % key).encode("utf-8")
        path = self.golden / "labels.jsonl"
        path.write_bytes(path.read_bytes() + foreign)
        self.assertEqual(self.run_pipeline("r2")[0], 0)
        self.assertIn(foreign, path.read_bytes())
        own = [l for l in self.read_labels() if l["label_set"] == "responsibility_rules_v1"]
        self.assertEqual(len(own), len([l for l in self.read_labels() if l["label_set"] != "llm_v1"]))

    def test_unchanged_labels_keep_their_run_at_across_runs(self):
        self.run_pipeline("20261126T100000Z")
        self.run_pipeline("20261127T100000Z")
        self.assertEqual({l["run_at"] for l in self.read_labels()}, {"2026-11-26T10:00:00Z"})

    def test_a_refused_run_leaves_the_labels_alone(self):
        self.run_pipeline("r1")
        before = (self.golden / "labels.jsonl").read_bytes()
        support.edit_csv(self.raw / "current_ADS.csv", lambda rows, fields: rows[0].update({"Highest Injury Severity Alleged": "Mildly Ouchy"}))
        self.assertEqual(self.run_pipeline("r2")[0], 1)
        self.assertEqual((self.golden / "labels.jsonl").read_bytes(), before)


class GateTests(RunBase):
    def assertRefused(self, before, code, err, *needles):
        self.assertEqual(code, 1)
        self.assertEqual(self.state(), before, "a refused run must write nothing")
        for needle in needles:
            self.assertIn(needle, err)

    def test_header_drift_exits_1_and_leaves_everything_untouched(self):
        self.assertEqual(self.run_pipeline("r1")[0], 0)
        before = self.state()

        def drift(rows, fields):
            for r in rows:
                r["Surprise Column"] = "x"
            return fields + ["Surprise Column"]
        support.edit_csv(self.raw / "current_ADS.csv", drift)
        drifted = self.state()
        code, _, err = self.run_pipeline("r2")
        self.assertEqual(code, 1)
        self.assertEqual(self.state(), drifted)  # raw is as the test left it; outputs and golden are as after r1
        self.assertEqual(before[0], drifted[0])
        self.assertEqual(before[1], drifted[1])
        self.assertIn("Surprise Column", err)

    def test_first_run_refused_creates_no_output_at_all(self):
        support.edit_csv(self.raw / "current_ADS.csv", lambda rows, fields: rows[0].update({"Highest Injury Severity Alleged": "Mildly Ouchy"}))
        code, _, err = self.run_pipeline()
        self.assertEqual(code, 1)
        self.assertIn("Mildly Ouchy", err)
        self.assertFalse(self.out.exists())
        self.assertFalse(self.golden.exists())

    def test_duplicate_key_is_refused_before_the_golden_build_can_raise(self):
        import csv
        with open(self.raw / "current_ADS.csv", encoding="utf-8", newline="") as f:
            first = next(csv.DictReader(f))
        support.edit_csv(self.raw / "archive_ADAS.csv", lambda rows, fields: rows.append(dict(rows[0], **{"Report ID": first["Report ID"], "Report Version": first["Report Version"]})))
        code, _, err = self.run_pipeline()
        self.assertEqual(code, 1)
        self.assertIn("duplicate", err)
        self.assertFalse(self.golden.exists())

    def test_dropped_reports_exit_1(self):
        self.assertEqual(self.run_pipeline("r1")[0], 0)
        before = self.state()
        support.edit_csv(self.raw / "current_ADS.csv", lambda rows, fields: rows.pop())
        code, _, err = self.run_pipeline("r2")
        self.assertEqual(code, 1)
        self.assertIn("dropped", err)
        self.assertEqual(self.state()[:2], before[:2])

    def test_missing_expected_entity_exits_1(self):
        self.entities.write_text(json.dumps({"entities": support.EXPECTED_ENTITIES + ["Zoox, Inc."]}))
        code, _, err = self.run_pipeline()
        self.assertEqual(code, 1)
        self.assertIn("Zoox, Inc.", err)

    def test_counts_that_do_not_reconcile_are_refused_before_any_write(self):
        before = self.state()
        real = aggregate.build_counts

        def broken(crashes):
            counts = real(crashes)
            counts["rows"][0]["crashes"] += 1
            return counts
        with mock.patch.object(aggregate, "build_counts", broken):
            code, _, err = self.run_pipeline()
        self.assertRefused(before, code, err, "counts.json")


class OnlineRunTests(RunBase):
    def opener(self, drift=False):
        bodies = {}
        for spec in config.SGO_FILES:
            body = (self.raw / (spec["key"] + ".csv")).read_bytes()
            if drift and spec["key"] == "current_ADS":
                body = body.replace(b"Narrative,", b"Narrative Renamed,", 1)
            bodies[spec["url"]] = body
        return lambda req, timeout=None: FakeResponse(bodies[req.full_url])

    def test_good_download_is_promoted_and_staging_removed(self):
        opener = self.opener()
        (self.raw / "current_ADS.csv").write_bytes(b"stale")  # replaced by the download
        code, _, err = self.run_pipeline(offline=False, opener=opener)
        # the stale copy would not have validated; the staged download must be what was checked
        self.assertEqual(code, 0, err)
        self.assertNotEqual((self.raw / "current_ADS.csv").read_bytes(), b"stale")
        self.assertEqual(len(json.loads(self.fetch_log.read_text())), len(config.SGO_FILES))
        self.assertEqual([p.name for p in self.raw.parent.iterdir() if p.name.startswith(".staging")], [])

    def test_bad_download_is_rejected_without_touching_data_raw(self):
        support.edit_csv(self.raw / "current_ADS.csv", lambda rows, fields: None)  # no-op rewrite: bytes stay valid
        before_raw, before_log = snapshot(self.raw), self.fetch_log.read_text()
        code, _, err = self.run_pipeline(offline=False, opener=self.opener(drift=True))
        self.assertEqual(code, 1)
        self.assertIn("Narrative", err)
        self.assertEqual(snapshot(self.raw), before_raw)
        self.assertEqual(self.fetch_log.read_text(), before_log)
        self.assertFalse(self.out.exists())
        self.assertEqual([p.name for p in self.raw.parent.iterdir() if p.name.startswith(".staging")], [])

    def test_failed_download_exits_1(self):
        def boom(req, timeout=None):
            raise OSError("network down")
        with mock.patch("pipeline.fetch.time.sleep"):
            code, _, err = self.run_pipeline(offline=False, opener=boom)
        self.assertEqual(code, 1)
        self.assertIn("network down", err)


if __name__ == "__main__":
    unittest.main()
