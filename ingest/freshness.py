"""Freshness automation for the preload-all archive.

The archive is only useful if it stays current on its own. TLC publishes
one new month at a time, roughly 1-2 months behind real time, and
occasionally re-publishes an old month with corrected rows. This module:

- remembers, per raw file, the remote size/ETag seen when it was fetched
  (data/raw/remote_index.json), so a re-published month is detectable;
- finds new months by HEAD-probing forward from the newest month in the
  partition index until the CDN says no;
- appends a month atomically: download to a temp name, ingest, rebuild
  the index — a crash mid-append leaves the previous index untouched;
- re-ingests a month whose remote size/ETag changed.

Run manually:  python -m ingest.freshness [--check-only]
The API calls check_and_update() in a background thread on startup and
then daily; it never blocks query serving.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from ingest.download import CDN, RAW_DIR, TRIP_URL, download_file
from ingest.pipeline import ingest_month

REPO_ROOT = Path(__file__).resolve().parent.parent
PART_DIR = REPO_ROOT / "data" / "partitioned"
REMOTE_INDEX = RAW_DIR / "remote_index.json"


def _head(url: str) -> dict | None:
    """Remote metadata for url, or None when the file is not published."""
    req = urllib.request.Request(url, method="HEAD")
    try:
        with urllib.request.urlopen(req) as resp:
            return {
                "size": int(resp.headers.get("Content-Length") or 0),
                "etag": resp.headers.get("ETag"),
            }
    except urllib.error.HTTPError:
        return None


def _load_remote_index() -> dict:
    if REMOTE_INDEX.exists():
        return json.loads(REMOTE_INDEX.read_text(encoding="utf-8"))
    return {}


def _save_remote_index(index: dict) -> None:
    REMOTE_INDEX.parent.mkdir(parents=True, exist_ok=True)
    tmp = REMOTE_INDEX.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(index, indent=2), encoding="utf-8")
    tmp.replace(REMOTE_INDEX)


def _record_remote(year: int, month: int) -> dict | None:
    meta = _head(TRIP_URL.format(year=year, month=month))
    if meta is not None:
        index = _load_remote_index()
        index[f"yellow_tripdata_{year}-{month:02d}.parquet"] = meta
        _save_remote_index(index)
    return meta


def indexed_months() -> list[tuple[int, int]]:
    """(year, month) pairs present in the partition index, sorted."""
    index_path = PART_DIR / "partitions.json"
    if not index_path.exists():
        return []
    data = json.loads(index_path.read_text(encoding="utf-8"))
    months = set()
    for entry in data.get("partitions", []):
        year, _, month = str(entry["month"]).partition("-")
        months.add((int(year), int(month)))
    return sorted(months)


def _next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


def find_new_months() -> list[tuple[int, int]]:
    """Published months after the newest indexed one (usually 0 or 1)."""
    months = indexed_months()
    if not months:
        return []
    year, month = months[-1]
    found = []
    while True:
        year, month = _next_month(year, month)
        if _head(TRIP_URL.format(year=year, month=month)) is None:
            return found
        found.append((year, month))


def find_republished() -> list[tuple[int, int]]:
    """Indexed months whose remote file changed since we fetched it.

    Months with no recorded baseline are baselined silently (their
    current remote metadata is stored, no re-ingest): a re-publish that
    happened before freshness existed cannot be detected, and pretending
    otherwise would re-download the whole archive for nothing.
    """
    index = _load_remote_index()
    changed = []
    dirty = False
    for year, month in indexed_months():
        name = f"yellow_tripdata_{year}-{month:02d}.parquet"
        meta = _head(TRIP_URL.format(year=year, month=month))
        if meta is None:
            continue
        if name not in index:
            index[name] = meta
            dirty = True
        elif index[name].get("size") != meta["size"] or (
            meta["etag"] and index[name].get("etag") != meta["etag"]
        ):
            changed.append((year, month))
    if dirty:
        _save_remote_index(index)
    return changed


def append_month(year: int, month: int, force: bool = False) -> dict:
    """Download (unless present) + ingest one month, then rebuild index."""
    dest = RAW_DIR / f"yellow_tripdata_{year}-{month:02d}.parquet"
    if force and dest.exists():
        dest.unlink()
    download_file(TRIP_URL.format(year=year, month=month), dest)
    _record_remote(year, month)
    entry = ingest_month(year, month)
    _rebuild_index()
    return entry


def _rebuild_index() -> None:
    import subprocess
    import sys

    proc = subprocess.run(
        [sys.executable, "-m", "ingest.manifest"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"index rebuild failed: {proc.stderr[-1000:]}")


def check_and_update(check_only: bool = False) -> dict:
    """One freshness pass. Returns a small status dict for /api/meta."""
    status = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "new_months": [],
        "republished": [],
        "updated": [],
    }
    new = find_new_months()
    republished = find_republished()
    status["new_months"] = [f"{y}-{m:02d}" for y, m in new]
    status["republished"] = [f"{y}-{m:02d}" for y, m in republished]
    if check_only:
        return status
    for year, month in new:
        append_month(year, month)
        status["updated"].append(f"{year}-{month:02d}")
    for year, month in republished:
        append_month(year, month, force=True)
        status["updated"].append(f"{year}-{month:02d} (re-published)")
    return status


if __name__ == "__main__":
    import sys

    print(json.dumps(check_and_update(check_only="--check-only" in sys.argv), indent=2))
