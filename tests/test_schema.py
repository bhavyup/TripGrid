"""Unit tests for schema normalisation (M0).

Covers the three drift cases from DESIGN Traps D: casing drift
(`Airport_fee`), the `tpep_` prefix + concatenated IDs (`VendorID`,
`PULocationID`), and a missing late-arriving column
(`cbd_congestion_fee`, absent before Jan 2025) filled with nulls.
"""
from datetime import datetime

import pyarrow as pa

from ingest.schema import CANONICAL, normalize_table


def _raw_table() -> pa.Table:
    return pa.table(
        {
            "VendorID": [1, 2],
            "tpep_pickup_datetime": pa.array(
                [datetime(2024, 1, 1, 0, 0), datetime(2024, 1, 1, 1, 0)],
                type=pa.timestamp("us"),
            ),
            "PULocationID": [161, 237],
            "Airport_fee": [1.25, 0.0],
            "fare_amount": [12.50, 7.00],
            "some_future_column": [0, 0],
        }
    )


def test_casing_and_alias_normalisation():
    out, seen, dropped = normalize_table(_raw_table())
    assert out.column_names == list(CANONICAL.keys())
    assert out.column("vendor_id").to_pylist() == [1, 2]
    assert out.column("pu_location_id").to_pylist() == [161, 237]
    assert out.column("airport_fee").to_pylist() == [1.25, 0.0]
    assert "some_future_column" in dropped


def test_missing_column_filled_with_nulls():
    out, _, _ = normalize_table(_raw_table())
    assert out.column("cbd_congestion_fee").to_pylist() == [None, None]
    assert out.column("cbd_congestion_fee").type == pa.float64()
