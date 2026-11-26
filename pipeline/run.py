"""One command for a data refresh: fetch, validate, build the golden database, aggregate.

    python3 -m pipeline.run [--offline] [--run-id ID]

  1. fetch   download the six SGO files into a staging directory (skipped with
             --offline, which uses data/raw as it is)
  2. validate  pipeline.validate.check on the staged files and the manual tables.
             Any error: print it, exit 1, and write nothing. Not the golden
             database, not site/public/data, not data/raw, not the fetch log.
             This gate runs before build_db: a duplicate (Report ID, Version)
             would otherwise make the builder raise.
  3. build   golden.build in memory, then aggregate.build_all and the
             post-aggregate checks (counts reconcile with the incidents).
             Any error again exits 1 with nothing written.
  4. write   promote the staged files to data/raw and the fetch log, write the
             golden JSONL (and golden.sqlite), then site/public/data/*.json.
             The warnings are printed and stored in meta.json.

Exit status: 0 on success, 1 on any validation error or failed download.
"""
import argparse
import datetime
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from . import aggregate, build_db, config, fetch, golden, manual, validate


def _read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except ValueError:
        print("warning: %s is not valid JSON; ignoring it" % path, file=sys.stderr)
        return default


def _fail(errors, warnings=()):
    print("VALIDATION FAILED: nothing was built, written or deployed", file=sys.stderr)
    for error in errors:
        print("  error: %s" % error, file=sys.stderr)
    for warning in warnings:
        print("  warning: %s" % warning, file=sys.stderr)
    return 1


def _promote(staging, raw_dir, fetch_log, fetch_log_path):
    """Move the validated downloads into place (each file is replaced atomically)."""
    raw_dir, fetch_log_path = Path(raw_dir), Path(fetch_log_path)
    raw_dir.mkdir(parents=True, exist_ok=True)
    fetch_log_path.parent.mkdir(parents=True, exist_ok=True)
    for spec in config.SGO_FILES:
        os.replace(Path(staging) / (spec["key"] + ".csv"), raw_dir / (spec["key"] + ".csv"))
    temp = fetch_log_path.with_name("." + fetch_log_path.name + ".tmp")
    temp.write_text(json.dumps(fetch_log, indent=2) + "\n")
    os.replace(temp, fetch_log_path)


def _summary(outputs):
    totals = {}
    for row in outputs["counts.json"]["rows"]:
        slot = totals.setdefault(row["program"], [0, 0])
        slot[0] += row["crashes"]
        slot[1] += row["reports"]
    print("crashes by program (unique incidents within each program, overlapping across programs; reports in brackets):")
    for program, (crashes, reports) in sorted(totals.items()):
        print("  %-16s %6d  (%d)" % (program, crashes, reports))
    meta = outputs["meta.json"]
    print("total: %d unique incidents (not the sum of the rows above), %d reports" % (meta["total_incidents"], meta["total_reports"]))


def run(offline=False, run_id=None, raw_dir=None, manual_dir=None, golden_dir=None, out_dir=None, fetch_log_path=None,
        expected_entities_path=None, today=None, opener=None, write_sqlite=True):
    now = datetime.datetime.now(datetime.timezone.utc)
    today = today or now.date()
    run_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    run_id = run_id or now.strftime("%Y%m%dT%H%M%SZ")
    raw_dir = Path(raw_dir or config.RAW_DIR)
    manual_dir = Path(manual_dir or config.MANUAL_DIR)
    golden_dir = Path(golden_dir or build_db.GOLDEN_DIR)
    out_dir = Path(out_dir or config.OUT_DIR)
    fetch_log_path = Path(fetch_log_path or config.FETCH_LOG)

    previous_meta = _read_json(out_dir / "meta.json")
    previous_fetch_log = _read_json(fetch_log_path)
    staging = None
    try:
        if offline:
            source_dir = raw_dir
            fetch_log = previous_fetch_log or []
            if not fetch_log:
                print("warning: no fetch log at %s; provenance in meta.json will be empty" % fetch_log_path, file=sys.stderr)
        else:
            raw_dir.parent.mkdir(parents=True, exist_ok=True)
            staging = Path(tempfile.mkdtemp(prefix=".staging-", dir=str(raw_dir.parent)))
            try:
                kwargs = {"opener": opener} if opener is not None else {}
                fetch_log = fetch.fetch_all(staging, log_path=staging / "fetch_log.json", **kwargs)
            except Exception as exc:  # network, HTTP, timeout
                return _fail(["download failed: %s" % exc])
            source_dir = staging

        errors, warnings = validate.check(
            source_dir, today=today, manual_dir=manual_dir,
            expected_entities=validate.load_expected_entities(expected_entities_path),
            previous_meta=previous_meta, previous_fetch_log=previous_fetch_log,
        )
        if errors:
            return _fail(errors, warnings)
        if offline:
            note = "offline: row-drop checks compare against the previous fetch log only"
            print(note)
            warnings = [note] + list(warnings)

        manual_tables = manual.load(manual_dir, today=today)
        previous = build_db.read_previous(golden_dir)
        tables = golden.build(source_dir, manual_tables, run_id, previous=previous, fetch_log=fetch_log)
        outputs, warnings = aggregate.build_all(
            tables, fetch_log, run_id, run_at, today, previous_tables=previous,
            previous_changelog=_read_json(out_dir / "changelog.json"), warnings=warnings, offline=offline,
        )
        errors = validate.check_outputs(outputs, tables)
        if errors:
            return _fail(errors, warnings)

        # Everything checked out: only now touch the disk.
        if staging is not None:
            _promote(staging, raw_dir, fetch_log, fetch_log_path)
        build_db.write_jsonl(tables, golden_dir)
        if write_sqlite:
            build_db.write_sqlite(tables, Path(golden_dir) / build_db.SQLITE_NAME)
        aggregate.write_all(outputs, out_dir)
    finally:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)

    print("run %s: wrote %d files to %s" % (run_id, len(outputs), out_dir))
    _summary(outputs)
    changelog = outputs["changelog.json"]["entries"][0]
    print("since the previous run: %(new_reports)d new, %(revised_reports)d revised, %(removed_reports)d removed reports" % changelog)
    print("warnings (%d):" % len(warnings))
    for warning in warnings:
        print("  - %s" % warning)
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description="Fetch, validate, build the golden database and the site data.")
    parser.add_argument("--offline", action="store_true", help="do not download; use the files in data/raw")
    parser.add_argument("--run-id", help="name of this run (default: current UTC timestamp)")
    parser.add_argument("--no-sqlite", action="store_true", help="skip golden.sqlite")
    for name in ("raw-dir", "manual-dir", "golden-dir", "out-dir", "fetch-log", "expected-entities"):
        parser.add_argument("--" + name, type=Path, help="override the default location (used by tests)")
    args = parser.parse_args(argv)
    return run(
        offline=args.offline, run_id=args.run_id, raw_dir=args.raw_dir, manual_dir=args.manual_dir,
        golden_dir=args.golden_dir, out_dir=args.out_dir, fetch_log_path=args.fetch_log,
        expected_entities_path=args.expected_entities, write_sqlite=not args.no_sqlite,
    )


if __name__ == "__main__":
    sys.exit(main())
