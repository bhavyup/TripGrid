"""Correctness check for Q4: our exact percentiles vs DuckDB's
quantile_cont over the same partitioned data, per borough.
Compared with a tight relative tolerance (1e-9); the largest
difference is printed, not hidden. Borough comes from each file's
path (the partition layout), because it is not a data column.
"""
from __future__ import annotations

import json
import sys

import duckdb
import numpy as np

from engine.executor import REPO_ROOT, run_q4


def duckdb_q4(year: int) -> dict[str, tuple[int, float, float, float]]:
    pattern = (REPO_ROOT / "data" / "partitioned" / "**" / "*.parquet").as_posix()
    rows = duckdb.sql(
        f"""
        SELECT regexp_extract(filename, '/\\d{{4}}-\\d{{2}}/([^/]+)/', 1) AS borough,
               count(*) AS trips,
               quantile_cont(fare_c / 100.0, 0.5) AS p50,
               quantile_cont(fare_c / 100.0, 0.9) AS p90,
               quantile_cont(fare_c / 100.0, 0.99) AS p99
        FROM read_parquet('{pattern}', filename = true)
        WHERE substr(regexp_extract(filename, '(\\d{{4}}-\\d{{2}})', 1), 1, 4) = '{year}'
        GROUP BY borough
        """
    ).fetchall()
    return {b: (int(t), float(a), float(c), float(d)) for b, t, a, c, d in rows}


if __name__ == "__main__":
    year = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    ours, stats = run_q4(year)
    theirs = duckdb_q4(year)
    print(json.dumps(stats, indent=2))
    ok = True
    max_diff = 0.0
    if {r["borough"] for r in ours} != set(theirs):
        ok = False
        print("borough sets differ:", [r["borough"] for r in ours], list(theirs))
    for r in ours:
        t_trips, t50, t90, t99 = theirs[r["borough"]]
        if r["trips"] != t_trips:
            ok = False
            print(f"{r['borough']}: trips {r['trips']} != duckdb {t_trips}")
        for ours_v, theirs_v in ((r["p50"], t50), (r["p90"], t90), (r["p99"], t99)):
            if not np.isclose(ours_v, theirs_v, rtol=1e-9, atol=1e-9):
                ok = False
            max_diff = max(max_diff, abs(ours_v - theirs_v))
        print(
            f"{r['borough']:<14} trips {r['trips']:>10,}  distinct {r['distinct_fares']:>6,}  "
            f"p50 {r['p50']:.2f} (duckdb {t50:.2f})  p90 {r['p90']:.2f} ({t90:.2f})  "
            f"p99 {r['p99']:.2f} ({t99:.2f})"
        )
    print(f"max float difference vs duckdb: {max_diff:.2e}")
    print("VERDICT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
