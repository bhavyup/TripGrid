"""M0 ingest pipeline for one month of TLC data.

Steps: read raw Parquet -> normalise schema (schema.py) -> validate ->
write partitioned dataset + quarantine file -> update the manifest.

Partition layout: pickup_month x pickup_borough (borough via the TLC
zone lookup on pu_location_id), Hive-style under data/partitioned/.

Validation rule (M0): a row is quarantined only when its pickup
timestamp falls outside the file's own month — TLC files routinely
carry garbage timestamps (2001, 2099) that would otherwise create
garbage partitions and wreck the manifest's min/max stats. Everything
else is kept and *measured*: negative fares and zero-distance trips are
counted in the manifest, not silently dropped (the percentile kernel
handles negative fares exactly via its outlier slice, DESIGN Traps C).
"""
from __future__ import annotations

import csv
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.dataset as ds
import pyarrow.parquet as pq

from ingest.schema import normalize_table

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
PART_DIR = REPO_ROOT / "data" / "partitioned"
QUAR_DIR = REPO_ROOT / "data" / "quarantine"


def load_borough_map() -> dict[int, str]:
    path = RAW_DIR / "taxi_zone_lookup.csv"
    with open(path, newline="", encoding="utf-8") as f:
        return {int(r["LocationID"]): r["Borough"] for r in csv.DictReader(f)}


def month_window(year: int, month: int) -> tuple[np.datetime64, np.datetime64]:
    start = np.datetime64(f"{year}-{month:02d}-01")
    if month == 12:
        end = np.datetime64(f"{year + 1}-01-01")
    else:
        end = np.datetime64(f"{year}-{month + 1:02d}-01")
    return start, end


def fare_measurements(fares: np.ndarray) -> dict:
    """The numbers DESIGN Traps C requires M0 to measure before M3:
    distinct fare count, fare range, and whether fares are really
    cent-quantised (the sparse-histogram design rests on it)."""
    if fares.size == 0:
        return {"distinct_fares": 0}
    cents = fares * 100.0
    non_cent = int(np.count_nonzero(np.abs(cents - np.round(cents)) > 1e-6))
    return {
        "fare_min": float(fares.min()),
        "fare_max": float(fares.max()),
        "distinct_fares": int(np.unique(fares).size),
        "negative_fares": int(np.count_nonzero(fares < 0)),
        "non_cent_fares": non_cent,
    }


def ingest_month(year: int, month: int) -> dict:
    raw_path = RAW_DIR / f"yellow_tripdata_{year}-{month:02d}.parquet"
    if not raw_path.exists():
        raise FileNotFoundError(f"{raw_path} — run ingest.download first")
    boroughs = load_borough_map()

    table = pq.read_table(raw_path)
    rows_in = table.num_rows
    table, seen, dropped = normalize_table(table)

    pickup = table.column("pickup_datetime").to_numpy(zero_copy_only=False)
    start, end = month_window(year, month)
    valid = (pickup >= start) & (pickup < end)
    n_quar = int(np.count_nonzero(~valid))

    pu = table.column("pu_location_id").to_numpy(zero_copy_only=False)
    # The zone lookup's borough for a few zones is literally "N/A" — the
    # slash would split the partition directory into two levels, so the
    # stored partition label is "N-A". Counts are recorded under "N-A".
    borough = np.array(
        [boroughs.get(int(x), "Unknown").replace("/", "-") for x in pu], dtype=object
    )
    month_label = f"{year}-{month:02d}"

    good = table.filter(valid)
    good = good.append_column("pickup_month", pa.array([month_label] * good.num_rows))
    good = good.append_column("pickup_borough", pa.array(borough[valid]))

    PART_DIR.mkdir(parents=True, exist_ok=True)
    ds.write_dataset(
        good,
        base_dir=PART_DIR,
        format="parquet",
        partitioning=["pickup_month", "pickup_borough"],
        existing_data_behavior="overwrite_or_ignore",
    )

    if n_quar:
        QUAR_DIR.mkdir(parents=True, exist_ok=True)
        bad = table.filter(~valid)
        bad = bad.append_column(
            "quarantine_reason", pa.array(["pickup_out_of_month"] * n_quar)
        )
        pq.write_table(bad, QUAR_DIR / f"yellow_tripdata_{year}-{month:02d}.parquet")

    fares = good.column("fare_amount").to_numpy(zero_copy_only=False)
    entry = {
        "source_file": raw_path.name,
        "rows_in": rows_in,
        "rows_partitioned": int(good.num_rows),
        "rows_quarantined": n_quar,
        "quarantine_reasons": {"pickup_out_of_month": n_quar} if n_quar else {},
        "columns_seen": seen,
        "columns_dropped": dropped,
        "zero_distance_trips": int(
            np.count_nonzero(good.column("trip_distance").to_numpy(zero_copy_only=False) == 0)
        ),
        **fare_measurements(fares),
        "boroughs": {
            b: int(np.count_nonzero(borough[valid] == b)) for b in sorted(set(borough[valid]))
        },
    }
    _update_manifest(entry)
    return entry


def _update_manifest(entry: dict) -> None:
    path = PART_DIR / "manifest.json"
    if path.exists():
        manifest = json.loads(path.read_text(encoding="utf-8"))
    else:
        manifest = {"files": []}
    manifest["files"] = [
        e for e in manifest["files"] if e["source_file"] != entry["source_file"]
    ]
    manifest["files"].append(entry)
    manifest["generated_at"] = datetime.now(timezone.utc).isoformat()
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


if __name__ == "__main__":
    # usage: python -m ingest.pipeline 2024 1 [2 3 ...]
    year = int(sys.argv[1])
    months = [int(a) for a in sys.argv[2:]] or [1]
    for m in months:
        result = ingest_month(year, m)
        print(json.dumps(result, indent=2))
