"""Schema normalisation for TLC monthly files.

TLC files drift: `Airport_fee` vs `airport_fee` casing changes by month,
`tpep_` prefixes come and go, and `cbd_congestion_fee` only exists from
Jan 2025. Ingestion normalises every file to ONE canonical schema, by
column name (case-insensitive), so the engine never sees the drift.
Columns the file does not have are added as nulls of the canonical type;
columns we do not know are dropped and recorded in the manifest.
"""
from __future__ import annotations

import pyarrow as pa

# canonical name -> pyarrow type. Order is the stored column order.
CANONICAL: dict[str, pa.DataType] = {
    "vendor_id": pa.int64(),
    "pickup_datetime": pa.timestamp("us"),
    "dropoff_datetime": pa.timestamp("us"),
    "passenger_count": pa.float64(),
    "trip_distance": pa.float64(),
    "ratecode_id": pa.float64(),
    "store_and_fwd_flag": pa.string(),
    "pu_location_id": pa.int64(),
    "do_location_id": pa.int64(),
    "payment_type": pa.int64(),
    "fare_amount": pa.float64(),
    "extra": pa.float64(),
    "mta_tax": pa.float64(),
    "tip_amount": pa.float64(),
    "tolls_amount": pa.float64(),
    "improvement_surcharge": pa.float64(),
    "total_amount": pa.float64(),
    "congestion_surcharge": pa.float64(),
    "airport_fee": pa.float64(),
    "cbd_congestion_fee": pa.float64(),
}

# raw name (lowercased) -> canonical name, for names that do not survive
# a plain lowercase + tpep_-strip unchanged.
ALIASES = {
    "vendorid": "vendor_id",
    "ratecodeid": "ratecode_id",
    "pulocationid": "pu_location_id",
    "dolocationid": "do_location_id",
}


def canonical_name(raw: str) -> str | None:
    name = raw.strip().lower()
    if name.startswith("tpep_"):
        name = name[len("tpep_"):]
    name = ALIASES.get(name, name)
    return name if name in CANONICAL else None


def normalize_table(table: pa.Table) -> tuple[pa.Table, list[str], list[str]]:
    """Return (canonical table, columns_seen, columns_dropped)."""
    by_canonical: dict[str, pa.ChunkedArray] = {}
    seen: list[str] = []
    dropped: list[str] = []
    for raw in table.column_names:
        canon = canonical_name(raw)
        if canon is None:
            dropped.append(raw)
        else:
            by_canonical[canon] = table.column(raw)
            seen.append(raw)
    columns = []
    for name, typ in CANONICAL.items():
        if name in by_canonical:
            columns.append(by_canonical[name].cast(typ, safe=False))
        else:
            columns.append(pa.nulls(table.num_rows, type=typ))
    out = pa.Table.from_arrays(columns, names=list(CANONICAL.keys()))
    return out, seen, dropped
