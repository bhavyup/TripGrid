"""M0 ingest pipeline for one month of TLC data.

Steps: read raw Parquet -> normalise schema (schema.py) -> validate ->
convert to the v2 tight layout (ingest/tight.py) and write one file
per borough partition + quarantine file -> update the manifest.

Partition layout: pickup_month x pickup_borough (borough via the TLC
zone lookup on pu_location_id), plain directories under
data/partitioned/.

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
import pyarrow.parquet as pq

from ingest.schema import normalize_table
from ingest.tight import overflow_mask, to_tight, write_tight

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


def ingest_month(year: int, month: int, fleet: str = "yellow") -> dict:
    raw_path = RAW_DIR / f"{fleet}_tripdata_{year}-{month:02d}.parquet"
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
    borough_good = borough[valid]

    # Rows whose money/distance values overflow int32 cents cannot
    # be stored exactly; they join the quarantine, counted, instead
    # of blocking the whole month or being silently clipped.
    overflow = overflow_mask(good)
    n_overflow = int(np.count_nonzero(overflow))
    if n_overflow:
        keep = ~overflow
        bad_overflow = good.filter(overflow)
        good = good.filter(keep)
        borough_good = borough_good[keep]
    else:
        bad_overflow = None

    # The v2 tight layout (ingest/tight.py) is written per borough
    # partition by hand — one sorted file per borough — instead of
    # through write_dataset, so the stored column set, types, sort
    # order and encodings are exactly the measured ones.
    tight_table, order, tight_info = to_tight(good, year, month)
    borough_sorted = borough_good[order]

    PART_DIR.mkdir(parents=True, exist_ok=True)
    for label in sorted(set(borough_sorted.tolist())):
        rows = np.nonzero(borough_sorted == label)[0]
        out_dir = PART_DIR / month_label / label
        out_dir.mkdir(parents=True, exist_ok=True)
        write_tight(tight_table.take(pa.array(rows)), out_dir / "part-0.parquet")

    reasons: dict[str, int] = {}
    if n_quar:
        reasons["pickup_out_of_month"] = n_quar
    if n_overflow:
        reasons["value_overflows_int32"] = n_overflow
    if reasons:
        QUAR_DIR.mkdir(parents=True, exist_ok=True)
        bad_parts = []
        if n_quar:
            bad_parts.append(
                table.filter(~valid).append_column(
                    "quarantine_reason",
                    pa.array(["pickup_out_of_month"] * n_quar),
                )
            )
        if bad_overflow is not None:
            bad_parts.append(
                bad_overflow.append_column(
                    "quarantine_reason",
                    pa.array(["value_overflows_int32"] * n_overflow),
                )
            )
        pq.write_table(
            pa.concat_tables(bad_parts),
            QUAR_DIR / f"{fleet}_tripdata_{year}-{month:02d}.parquet",
        )

    fares = good.column("fare_amount").to_numpy(zero_copy_only=False)
    entry = {
        "source_file": raw_path.name,
        "fleet": fleet,
        "layout": "v2",
        "dur_saturated": tight_info["dur_saturated"],
        "rows_in": rows_in,
        "rows_partitioned": int(good.num_rows),
        "rows_quarantined": n_quar + n_overflow,
        "quarantine_reasons": reasons,
        "columns_seen": seen,
        "columns_dropped": dropped,
        "zero_distance_trips": int(
            np.count_nonzero(good.column("trip_distance").to_numpy(zero_copy_only=False) == 0)
        ),
        **fare_measurements(fares),
        "boroughs": {
            b: int(np.count_nonzero(borough_good == b)) for b in sorted(set(borough_good))
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
