"""Download NYC TLC monthly Parquet files and the taxi zone lookup.

Source: the TLC CDN. Files are public domain trip records.
Downloads are streamed to a `.part` file and renamed on success, so a
killed download never leaves a corrupt file that later steps trust.
Re-running skips files that already exist with a non-zero size.
"""
from __future__ import annotations

import sys
import urllib.request
from pathlib import Path

CDN = "https://d37ci6vzurychx.cloudfront.net"
TRIP_URL = CDN + "/trip-data/yellow_tripdata_{year}-{month:02d}.parquet"
ZONE_URL = CDN + "/misc/taxi_zone_lookup.csv"

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"


def download_file(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        print(f"skip (exists): {dest.name} ({dest.stat().st_size:,} bytes)")
        return dest
    part = dest.with_suffix(dest.suffix + ".part")
    print(f"downloading: {url}")
    with urllib.request.urlopen(url) as resp, open(part, "wb") as out:
        while chunk := resp.read(1 << 20):
            out.write(chunk)
    part.replace(dest)
    print(f"done: {dest.name} ({dest.stat().st_size:,} bytes)")
    return dest


def download_month(year: int, month: int) -> Path:
    url = TRIP_URL.format(year=year, month=month)
    return download_file(url, RAW_DIR / f"yellow_tripdata_{year}-{month:02d}.parquet")


def download_zone_lookup() -> Path:
    return download_file(ZONE_URL, RAW_DIR / "taxi_zone_lookup.csv")


if __name__ == "__main__":
    # usage: python -m ingest.download 2024 1 [2 3 ...]
    year = int(sys.argv[1])
    months = [int(a) for a in sys.argv[2:]] or [1]
    download_zone_lookup()
    for m in months:
        download_month(year, m)
