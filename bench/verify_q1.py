"""Correctness check for M1: run Query 1 with our engine and with
DuckDB (the expert reference tool) over the same partitioned data,
and compare the two answers exactly — counts are integers, so there
is no "close enough": every month x zone count must be identical.
"""
from __future__ import annotations

import json
import sys

import duckdb
import numpy as np

from engine.executor import MONTHS, ZONE_RANGE, REPO_ROOT, run_q1


def duckdb_q1(year: int) -> np.ndarray:
    pattern = (REPO_ROOT / "data" / "partitioned" / "**" / "*.parquet").as_posix()
    # The layout is partitioned/<YYYY-MM>/<borough>/<file>.parquet (plain
    # directory partitioning, no key=value names), so DuckDB gets the
    # month from each file's path instead of a hive partition column.
    rows = duckdb.sql(
        f"""
        SELECT CAST(substr(regexp_extract(filename, '(\\d{{4}}-\\d{{2}})', 1), 6, 2) AS INTEGER) - 1 AS month_idx,
               pu AS zone,
               count(*) AS trips
        FROM read_parquet('{pattern}', filename = true)
        WHERE substr(regexp_extract(filename, '(\\d{{4}}-\\d{{2}})', 1), 1, 4) = '{year}'
        GROUP BY month_idx, zone
        """
    ).fetchall()
    out = np.zeros((MONTHS, ZONE_RANGE), dtype=np.int64)
    for month_idx, zone, trips in rows:
        out[int(month_idx), int(zone)] = int(trips)
    return out


if __name__ == "__main__":
    year = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    ours, stats = run_q1(year)
    theirs = duckdb_q1(year)
    match = bool(np.array_equal(ours, theirs))
    print(json.dumps(stats, indent=2))
    print(f"engine total: {int(ours.sum()):,}  duckdb total: {int(theirs.sum()):,}")
    print("VERDICT:", "PASS — answers identical" if match else "FAIL — answers differ")
    sys.exit(0 if match else 1)
