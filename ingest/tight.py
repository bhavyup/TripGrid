"""The v2 tight layout: how a canonical month becomes stored files.

Conversions (all proven lossless on the full 2024+2025 data before
adoption — money and distance are exact cents / hundredths in
every one of the 89.9M rows):
  fare / tip / total / congestion / airport fee -> int32 cents
  trip_distance                                 -> int32 hundredths
  pickup_datetime -> uint32 seconds into the partition month
  dropoff_datetime -> int32 duration in seconds (pickup + dur)
  pu / do location ids -> uint16, payment_type -> uint8,
  passenger_count -> uint16 (nulls become 0, as the probes did)

Rows are sorted by (pickup zone, drop-off zone, pickup time) and
written with zstd and DELTA_BINARY_PACKED on the two time columns:
9.92 bytes per row measured on Jan 2024, against 22.13 for v1.

Two honest edges:
- A duration outside int32 range (a dropoff dated 2099 would do
  it) is SATURATED to the int32 bound, never wrapped — and the
  count of saturated rows is returned so the manifest records it.
  Saturated rows are data junk by definition; every sane-trip
  rule still excludes them exactly as before.
- Columns the engine has never used (vendor, ratecode, taxes,
  tolls, flags) are not stored. The raw city files stay on disk;
  nothing is unrecoverable.
"""
from __future__ import annotations

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

INT32_MAX = 2**31 - 1
INT32_MIN = -(2**31)

STORED_COLUMNS = [
    "pickup_off_s", "dur_s", "pu", "do", "pay", "pax",
    "dist_100mi", "fare_c", "tip_c", "total_c", "cong_c", "airport_c",
]

_DELTA_ENCODED = {
    "pickup_off_s": "DELTA_BINARY_PACKED",
    "dur_s": "DELTA_BINARY_PACKED",
}


def _cents(values: np.ndarray, name: str) -> np.ndarray:
    cents = np.round(np.nan_to_num(values.astype(np.float64)) * 100.0)
    if cents.size and bool((np.abs(cents) > INT32_MAX).any()):
        raise ValueError(
            f"{name}: a value overflows int32 cents "
            f"(max seen {np.abs(cents).max():,.0f}) — refusing to wrap it"
        )
    return cents.astype(np.int32)


def _ids(values: np.ndarray, name: str, limit: int) -> np.ndarray:
    v = values.astype(np.int64)
    if v.size and (v.min() < 0 or v.max() > limit):
        raise ValueError(f"{name}: id out of range [0, {limit}]: "
                         f"{v.min()}..{v.max()}")
    return v


def to_tight(table: pa.Table, year: int, month: int):
    """Convert a canonical, already month-filtered table to the v2
    layout. Returns (table, order, info): `order` is the sort
    permutation that was applied, so callers can keep per-row side
    data (borough labels) aligned with the stored rows."""
    pick = table.column("pickup_datetime").to_numpy(zero_copy_only=False)
    drop = table.column("dropoff_datetime").to_numpy(zero_copy_only=False)
    pick_s = pick.astype("datetime64[s]").astype(np.int64)
    drop_s = drop.astype("datetime64[s]").astype(np.int64)
    base_s = int(np.datetime64(f"{year}-{month:02d}-01", "s").astype(np.int64))

    off = pick_s - base_s
    if off.size and (off.min() < 0 or off.max() > 2**32 - 1):
        raise ValueError("pickup offset outside the partition month")

    dur = drop_s - pick_s
    saturated = int(np.count_nonzero((dur > INT32_MAX) | (dur < INT32_MIN)))
    dur32 = np.clip(dur, INT32_MIN, INT32_MAX).astype(np.int32)

    pu = _ids(table.column("pu_location_id").to_numpy(zero_copy_only=False),
              "pu_location_id", 65535)
    do = _ids(table.column("do_location_id").to_numpy(zero_copy_only=False),
              "do_location_id", 65535)
    pay = _ids(table.column("payment_type").to_numpy(zero_copy_only=False),
               "payment_type", 255)
    pax_raw = table.column("passenger_count").fill_null(0).to_numpy(
        zero_copy_only=False)
    pax = np.clip(np.nan_to_num(pax_raw.astype(np.float64)), 0, 65535)

    cols = {
        "pickup_off_s": off.astype(np.uint32),
        "dur_s": dur32,
        "pu": pu.astype(np.uint16),
        "do": do.astype(np.uint16),
        "pay": pay.astype(np.uint8),
        "pax": pax.astype(np.uint16),
        "dist_100mi": _cents(
            table.column("trip_distance").to_numpy(zero_copy_only=False),
            "trip_distance"),
        "fare_c": _cents(
            table.column("fare_amount").to_numpy(zero_copy_only=False),
            "fare_amount"),
        "tip_c": _cents(
            table.column("tip_amount").to_numpy(zero_copy_only=False),
            "tip_amount"),
        "total_c": _cents(
            table.column("total_amount").to_numpy(zero_copy_only=False),
            "total_amount"),
        "cong_c": _cents(
            table.column("congestion_surcharge").to_numpy(zero_copy_only=False),
            "congestion_surcharge"),
        "airport_c": _cents(
            table.column("airport_fee").to_numpy(zero_copy_only=False),
            "airport_fee"),
    }
    order = np.lexsort((cols["pickup_off_s"], cols["do"], cols["pu"]))
    out = pa.table({k: pa.array(v[order]) for k, v in cols.items()})
    return out, order, {"dur_saturated": saturated}


def write_tight(table: pa.Table, path) -> None:
    pq.write_table(
        table,
        path,
        compression="zstd",
        use_dictionary=False,
        column_encoding=_DELTA_ENCODED,
    )
