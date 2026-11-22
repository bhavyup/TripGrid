"""The storage layer — the ONE place that knows how trips are
physically stored on disk.

Two layouts exist:
  v1  the M0 layout: canonical column names and types, money and
      distance as float64 dollars / miles, real timestamp columns.
      ~22.1 bytes per row.
  v2  the tight layout (TripGrid 2.0, Step 2): money and distance
      as exact int32 cents / hundredths of a mile, pickup as a
      uint32 count of seconds into the partition month plus an
      int32 trip duration, ids narrowed to uint16 / uint8.
      Measured 9.92 bytes per row (Jan 2024 probe, sorted by
      (pu, do, pickup) with delta encoding on the time columns).

Everything above this module — kernels, executor, composer, the
benchmark runners — speaks canonical names and canonical values:
dollars as float64, real timestamps, int64 ids. Translation
happens here, per batch, in vectorised numpy. A question's answer
cannot depend on which layout a file happens to be in; the test
suite proves that by running the same gates over both.

The v2 layout is fleet-agnostic: it is defined over the canonical
schema that ingest.schema produces for every fleet, so green /
FHV / HVFHV partitions will land in the same shape when their
turn comes.
"""
from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

_MONTH_PART = re.compile(r"^\d{4}-\d{2}$")

# canonical name -> (stored name, translation kind) for v2 files.
_V2_MAP: dict[str, tuple[str, str]] = {
    "pu_location_id": ("pu", "id"),
    "do_location_id": ("do", "id"),
    "payment_type": ("pay", "id"),
    "passenger_count": ("pax", "pax"),
    "trip_distance": ("dist_100mi", "scaled"),
    "fare_amount": ("fare_c", "scaled"),
    "tip_amount": ("tip_c", "scaled"),
    "total_amount": ("total_c", "scaled"),
    "congestion_surcharge": ("cong_c", "scaled"),
    "airport_fee": ("airport_c", "scaled"),
}

V2_STORED_COLUMNS = [
    "pickup_off_s", "dur_s", "pu", "do", "pay", "pax",
    "dist_100mi", "fare_c", "tip_c", "total_c", "cong_c", "airport_c",
]


def is_v2(schema_names) -> bool:
    return "fare_c" in schema_names


def month_from_path(path) -> str:
    """The "YYYY-MM" partition a file lives under — needed to turn
    v2 pickup offsets back into timestamps."""
    for part in Path(path).parts:
        if _MONTH_PART.match(part):
            return part
    raise ValueError(f"no YYYY-MM partition in path: {path}")


def iter_canonical(path, columns, batch_rows: int, month: str | None = None):
    """Stream a partition file as (n_rows, {canonical: ndarray})
    batches, translating the on-disk layout as needed.

    `columns` are canonical names. Requesting a column the file's
    layout does not store raises KeyError — loudly, at the file
    that cannot answer, rather than as a silent null.
    """
    pf = pq.ParquetFile(path)
    names = pf.schema_arrow.names
    if is_v2(names):
        yield from _iter_v2(pf, path, list(columns), batch_rows, month)
    else:
        yield from _iter_v1(pf, list(columns), batch_rows)


def _iter_v1(pf, columns: list[str], batch_rows: int):
    read = columns or [pf.schema_arrow.names[0]]
    for batch in pf.iter_batches(batch_size=batch_rows, columns=read):
        out = {
            name: batch.column(i).to_numpy(zero_copy_only=False)
            for i, name in enumerate(read)
        }
        n = batch.num_rows
        yield n, {name: out[name] for name in columns}


def _iter_v2(pf, path, columns: list[str], batch_rows: int,
             month: str | None):
    stored_needed: list[str] = []
    for c in columns:
        if c == "pickup_datetime":
            stored_needed.append("pickup_off_s")
        elif c == "dropoff_datetime":
            stored_needed.extend(["pickup_off_s", "dur_s"])
        elif c in _V2_MAP:
            stored_needed.append(_V2_MAP[c][0])
        else:
            raise KeyError(
                f"column {c!r} is not stored in the v2 layout of {path}"
            )
    read = list(dict.fromkeys(stored_needed)) or ["pu"]
    base_us = None
    if any(c in ("pickup_datetime", "dropoff_datetime") for c in columns):
        m = month or month_from_path(path)
        base_us = int(np.datetime64(f"{m}-01", "us").astype(np.int64))
    for batch in pf.iter_batches(batch_size=batch_rows, columns=read):
        raw = {
            name: batch.column(i).to_numpy(zero_copy_only=False)
            for i, name in enumerate(read)
        }
        n = batch.num_rows
        out: dict[str, np.ndarray] = {}
        pickup_us = None
        for c in columns:
            if c in ("pickup_datetime", "dropoff_datetime"):
                if pickup_us is None:
                    pickup_us = (
                        base_us + raw["pickup_off_s"].astype(np.int64) * 1_000_000
                    )
                if c == "pickup_datetime":
                    out[c] = pickup_us.astype("datetime64[us]")
                else:
                    drop_us = pickup_us + raw["dur_s"].astype(np.int64) * 1_000_000
                    out[c] = drop_us.astype("datetime64[us]")
                continue
            stored, kind = _V2_MAP[c]
            arr = raw[stored]
            if kind == "id":
                out[c] = arr.astype(np.int64)
            elif kind == "pax":
                out[c] = arr.astype(np.float64)
            else:  # scaled: int32 cents / hundredths -> float64 units
                out[c] = arr.astype(np.float64) / 100.0
        yield n, out
