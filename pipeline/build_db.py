"""Build the golden database: JSONL store in data/golden/ plus a sqlite download.

    python3 -m pipeline.build_db [--run-id ID]

Reads data/raw (SGO CSVs), data/manual, data/registry/fetch_log.json and the
previous data/golden/*.jsonl; writes one JSONL file per table (the canonical,
diff-friendly store that is committed) and data/golden/golden.sqlite (a build
artifact for download, not committed). Prints the row count of every table.

Run it once per refresh, and only after the validation gate (Task 5) has passed.
Unchanged reports are not rewritten, so a refresh only diffs rows that are new,
changed or removed (plus one new row in runs.jsonl). Rebuilding with the same
--run-id is a no-op.

The JSONL files are sorted by key, with sorted keys, UTF-8 and \\n line endings,
so a rebuild with unchanged inputs is byte-identical. reports.jsonl is split
into reports.<era>_<kind>.jsonl shards when it would exceed SHARD_THRESHOLD_BYTES.
labels.jsonl is never rewritten by this module once it exists; pipeline.responsibility.write_labels
replaces only its own label set in it.
"""
import argparse
import datetime
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path

from . import config, golden, manual

GOLDEN_DIR = config.REPO_ROOT / "data" / "golden"
SQLITE_NAME = "golden.sqlite"
SHARD_THRESHOLD_BYTES = 60_000_000

# Columns that need an index for the usual queries.
REPORT_INDEXES = ("program", "month", "severity", "company", "incident_key", "report_id", "is_latest", "source_file")
PRIMARY_KEYS = {"reports": "report_key", "incidents": "incident_key", "runs": "run_id"}


# ------------------------------------------------------------------- JSONL
def _encode(table, rows):
    return b"".join(golden.dumps_row(r).encode("utf-8") + b"\n" for r in golden.sort_rows(table, rows))


def _report_files(directory):
    return sorted(Path(directory).glob("reports*.jsonl"))


def _write_all(files):
    """Write every (path, payload) atomically: all temp files first, then rename them in place.

    A failure while writing leaves the existing files untouched and removes the temp files.
    """
    temps = []
    try:
        for path, payload in files:
            temp = path.with_name("." + path.name + ".tmp")
            temp.write_bytes(payload)
            temps.append((temp, path))
        for temp, path in temps:
            os.replace(temp, path)
    except BaseException:
        for temp, _ in temps:
            if temp.exists():
                temp.unlink()
        raise


def write_jsonl(tables, golden_dir=GOLDEN_DIR, shard_threshold=SHARD_THRESHOLD_BYTES):
    """Write one JSONL file per table; returns [(path, bytes)].

    Everything is serialized, and written to temp files in the same directory,
    before any existing file is replaced; each file is then swapped in with an
    atomic rename (see _write_all). A failure while serializing or writing
    leaves the committed files untouched.

    reports goes to reports.jsonl, or to reports.<source_file>.jsonl shards when
    the single file would be larger than shard_threshold bytes (stale files of
    the other layout are removed). labels.jsonl is only created when missing.
    """
    directory = Path(golden_dir)
    directory.mkdir(parents=True, exist_ok=True)
    files = []
    for table in golden.TABLES:
        if table == "labels":
            if not (directory / "labels.jsonl").exists():
                files.append((directory / "labels.jsonl", b""))
        elif table != "reports":
            files.append((directory / (table + ".jsonl"), _encode(table, tables[table])))
        else:
            payload = _encode("reports", tables["reports"])
            if len(payload) <= shard_threshold:
                files.append((directory / "reports.jsonl", payload))
            else:
                shards = {}
                for row in tables["reports"]:
                    shards.setdefault(row["source_file"], []).append(row)
                for source_file, rows in sorted(shards.items()):
                    files.append((directory / ("reports.%s.jsonl" % source_file), _encode("reports", rows)))
    _write_all(files)
    keep = {path for path, _ in files}
    for stale in _report_files(directory):
        if stale not in keep:
            stale.unlink()
    return [(path, len(payload)) for path, payload in files]


def _read_jsonl(path):
    with open(path, encoding="utf-8", newline="") as f:
        return [json.loads(line) for line in f if line.strip()]


def read_previous(golden_dir=GOLDEN_DIR):
    """The tables of the last build ({} when there is none), reports sorted by key."""
    directory = Path(golden_dir)
    previous = {}
    files = _report_files(directory)
    if files:
        rows = [row for path in files for row in _read_jsonl(path)]
        previous["reports"] = golden.sort_rows("reports", rows)
    for table in golden.TABLES:
        if table != "reports" and (directory / (table + ".jsonl")).exists():
            previous[table] = _read_jsonl(directory / (table + ".jsonl"))
    return previous


# ------------------------------------------------------------------ sqlite
def _cell(value):
    if isinstance(value, (list, dict)):
        return golden.dumps_row(value)
    if isinstance(value, bool):
        return int(value)
    return value


def _affinity(values):
    kinds = {type(v) for v in values if v is not None}
    if kinds and kinds <= {bool, int}:
        return "INTEGER"
    if kinds and kinds <= {bool, int, float}:
        return "REAL"
    return "TEXT"


def _table_columns(table, rows):
    if table == "reports":
        preferred = golden.REPORT_COLUMNS[:-2] + ("last_seen_run", "narrative", "status", "raw")
    elif table == "labels":
        preferred = golden.LABEL_COLUMNS
    elif table in manual.COLUMNS:
        preferred = manual.COLUMNS[table]
    else:
        preferred = ()
    columns = list(preferred)
    for row in rows:
        columns.extend(k for k in row if k not in columns)
    return columns


def last_seen_runs(rows, run_ids):
    """{report_key: last run that saw the row}, derived from the runs history.

    A row still in the source was seen by the latest run. A removed row was last
    seen by the run before removed_in_run (None if there was none).
    """
    run_ids = sorted(run_ids)
    out = {}
    for row in rows:
        removed = row["removed_in_run"]
        if removed is None:
            out[row["report_key"]] = run_ids[-1] if run_ids else None
        else:
            earlier = [r for r in run_ids if r < removed]
            out[row["report_key"]] = earlier[-1] if earlier else None
    return out


def _sqlite_rows(table, tables):
    rows = tables[table]
    if table != "reports":
        return rows
    # last_seen_run is not in the JSONL (it would change every row on every refresh).
    # The narrative text is stored once in JSONL (inside raw); sqlite also gets a flat column.
    seen = last_seen_runs(rows, [r["run_id"] for r in tables["runs"]])
    return [dict(r, last_seen_run=seen[r["report_key"]], narrative=r["raw"].get("Narrative")) for r in rows]


def write_sqlite(tables, path):
    """Compile the tables into a fresh sqlite file (stdlib sqlite3).

    Lists and dicts (raw, status, contact areas, ...) are JSON text columns, so
    json_extract(status, '$.lighting') works; booleans are 0/1.
    """
    final = Path(path)
    final.parent.mkdir(parents=True, exist_ok=True)
    path = final.with_name("." + final.name + ".tmp")
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    try:
        with con:
            for table in golden.TABLES:
                rows = _sqlite_rows(table, tables)
                columns = _table_columns(table, rows)
                defs = []
                for column in columns:
                    definition = '"%s" %s' % (column, _affinity([r.get(column) for r in rows]))
                    if PRIMARY_KEYS.get(table) == column:
                        definition += " PRIMARY KEY"
                    defs.append(definition)
                con.execute('CREATE TABLE "%s" (%s)' % (table, ", ".join(defs)))
                con.executemany(
                    'INSERT INTO "%s" VALUES (%s)' % (table, ", ".join("?" * len(columns))),
                    [tuple(_cell(r.get(c)) for c in columns) for r in rows],
                )
            for column in REPORT_INDEXES:
                con.execute('CREATE INDEX "idx_reports_%s" ON reports ("%s")' % (column, column))
            con.execute('CREATE INDEX idx_incidents_month ON incidents (month)')
            con.execute(
                "CREATE VIEW latest_reports AS SELECT * FROM reports "
                "WHERE is_latest = 1 AND removed_in_run IS NULL AND is_placeholder = 0"
            )
    except BaseException:
        con.close()
        path.unlink()
        raise
    con.close()
    os.replace(path, final)


# --------------------------------------------------------------------- run
def run(raw_dir, golden_dir, manual_tables, run_id, fetch_log, allow_missing=False, sqlite_path=None,
        shard_threshold=SHARD_THRESHOLD_BYTES):
    """Build the tables from previous + sources, write JSONL (and sqlite). Returns (tables, written files)."""
    previous = read_previous(golden_dir)
    tables = golden.build(raw_dir, manual_tables, run_id, previous=previous, fetch_log=fetch_log, allow_missing=allow_missing)
    written = write_jsonl(tables, golden_dir, shard_threshold)
    if sqlite_path is not None:
        write_sqlite(tables, sqlite_path)
        written.append((Path(sqlite_path), Path(sqlite_path).stat().st_size))
    return tables, written


def _check_fetch_log(fetch_log, raw_dir):
    """Warn when a raw file is not the one the fetch log describes."""
    for entry in fetch_log:
        path = Path(raw_dir) / (entry["key"] + ".csv")
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            print("warning: %s does not match the sha256 in the fetch log" % path.name, file=sys.stderr)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the golden database (JSONL store + sqlite).")
    parser.add_argument("--run-id", default=datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"),
                        help="name of this run (default: current UTC timestamp)")
    parser.add_argument("--raw-dir", type=Path, default=config.RAW_DIR)
    parser.add_argument("--manual-dir", type=Path, default=config.MANUAL_DIR)
    parser.add_argument("--fetch-log", type=Path, default=config.FETCH_LOG)
    parser.add_argument("--golden-dir", type=Path, default=GOLDEN_DIR)
    parser.add_argument("--no-sqlite", action="store_true", help="skip golden.sqlite")
    args = parser.parse_args(argv)

    try:
        manual_tables = manual.load(args.manual_dir)
    except manual.ManualDataError as exc:
        print("manual data invalid: %s" % exc, file=sys.stderr)
        return 1
    fetch_log = json.loads(args.fetch_log.read_text(encoding="utf-8")) if args.fetch_log.exists() else []
    _check_fetch_log(fetch_log, args.raw_dir)
    sqlite_path = None if args.no_sqlite else args.golden_dir / SQLITE_NAME
    tables, written = run(args.raw_dir, args.golden_dir, manual_tables, args.run_id, fetch_log, sqlite_path=sqlite_path)

    print("run %s" % args.run_id)
    for table in golden.TABLES:
        print("  %-17s %7d rows" % (table, len(tables[table])))
    for path, size in written:
        print("  wrote %-36s %8.2f MB" % (path.name, size / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
