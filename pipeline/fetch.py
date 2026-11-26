"""Download the NHTSA SGO CSV files and record provenance in a fetch log."""
import csv
import hashlib
import io
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from . import config

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
TIMEOUT = 120
ATTEMPTS = 3


def count_rows(body: bytes) -> int:
    """Count CSV records excluding the header (embedded newlines are handled)."""
    text = body.decode("utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text, newline=""))
    return max(sum(1 for _ in reader) - 1, 0)


def _download(url, opener, sleep):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    last_exc = None
    for attempt in range(ATTEMPTS):
        try:
            resp = opener(req, timeout=TIMEOUT)
            try:
                body = resp.read()
                headers = resp.headers
                return body, headers.get("Last-Modified"), headers.get("ETag")
            finally:
                close = getattr(resp, "close", None)
                if close:
                    close()
        except Exception as exc:  # network errors, HTTP errors, timeouts
            last_exc = exc
            if attempt < ATTEMPTS - 1:
                sleep(2 ** (attempt + 1))
    raise last_exc


def fetch_one(spec, raw_dir, opener=urllib.request.urlopen, sleep=time.sleep):
    raw_dir = Path(raw_dir)
    body, last_modified, etag = _download(spec["url"], opener, sleep)
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / f"{spec['key']}.csv").write_bytes(body)
    return {
        "key": spec["key"],
        "url": spec["url"],
        "retrieved_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "last_modified": last_modified,
        "etag": etag,
        "sha256": hashlib.sha256(body).hexdigest(),
        "bytes": len(body),
        "rows": count_rows(body),
    }


def fetch_all(raw_dir, opener=urllib.request.urlopen, log_path=None, sleep=time.sleep):
    """Fetch all six SGO files into raw_dir and write the fetch log."""
    entries = [fetch_one(spec, raw_dir, opener=opener, sleep=sleep) for spec in config.SGO_FILES]
    log_path = Path(log_path) if log_path is not None else config.FETCH_LOG
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(json.dumps(entries, indent=2) + "\n")
    return entries


def main():
    entries = fetch_all(config.RAW_DIR)
    for e in entries:
        print(f"{e['key']:14s} rows={e['rows']:6d} bytes={e['bytes']:9d} sha256={e['sha256'][:12]}")


if __name__ == "__main__":
    main()
