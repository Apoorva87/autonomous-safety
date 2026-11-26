"""Shared helpers for the aggregate, validate and run tests (imported as `support`)."""
import csv
import shutil
from pathlib import Path

from pipeline import config, schema

FIXTURES = Path(__file__).resolve().parent / "fixtures"
EXPECTED_ENTITIES = ["Tesla, Inc.", "General Motors, LLC", "Waymo LLC", "Cruise LLC"]


def make_raw_dir(directory):
    """A raw directory with all six files: the fixture CSVs, header-only files for the rest."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for spec in config.SGO_FILES:
        key = spec["key"]
        source = FIXTURES / (key + ".csv")
        target = directory / (key + ".csv")
        if source.exists():
            shutil.copy(source, target)
        else:
            columns = sorted(schema.EXPECTED_COLUMNS[key])
            with open(target, "w", encoding="utf-8", newline="") as f:
                csv.writer(f, lineterminator="\n").writerow(columns)
    return directory


def edit_csv(path, edit):
    """Rewrite a CSV after `edit(rows)` changed the list of row dicts in place."""
    with open(path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        fields = reader.fieldnames
        rows = list(reader)
    fields = edit(rows, fields) or fields
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def fetch_log_for(raw_dir):
    """A fetch log describing the files in raw_dir (row counts from the files)."""
    from pipeline import fetch

    entries = []
    for spec in config.SGO_FILES:
        body = (Path(raw_dir) / (spec["key"] + ".csv")).read_bytes()
        entries.append({
            "key": spec["key"], "url": spec["url"], "retrieved_at": "2026-11-26T21:28:45Z",
            "last_modified": "Mon, 16 Nov 2026 13:31:10 GMT", "etag": "x", "sha256": "0" * 64,
            "bytes": len(body), "rows": fetch.count_rows(body),
        })
    return entries
