"""Correctness check for Q2: our engine vs DuckDB over the same
partitioned data. Money averages are floats summed in different
orders, so they are compared with a tight relative tolerance
(1e-9) and the largest difference is printed, not hidden.
"""
from __future__ import annotations

import json
import sys

import duckdb
import numpy as np

from engine.executor import REPO_ROOT, run_q2
from engine.zones import airport_ids, load_zones


def duckdb_q2(year: int) -> dict[int, tuple[int, float, float]]:
    pattern = (REPO_ROOT / "data" / "partitioned" / "**" / "*.parquet").as_posix()
    airports = ",".join(str(i) for i in sorted(airport_ids(load_zones())))
    rows = duckdb.sql(
        f"""
        SELECT pay AS payment_type, count(*) AS trips, avg(fare_c) / 100.0 AS avg_fare,
               100.0 * sum(tip_c) / sum(fare_c) AS tip_pct
        FROM read_parquet('{pattern}', filename = true)
        WHERE substr(regexp_extract(filename, '(\\d{{4}}-\\d{{2}})', 1), 1, 4) = '{year}'
          AND pu IN ({airports})
        GROUP BY pay
        """
    ).fetchall()
    return {int(p): (int(t), float(a), float(tp)) for p, t, a, tp in rows}


if __name__ == "__main__":
    year = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    ours, stats = run_q2(year)
    theirs = duckdb_q2(year)
    print(json.dumps(stats, indent=2))
    ok = True
    max_diff = 0.0
    if {r["payment_type"] for r in ours} != set(theirs):
        ok = False
        print("payment type sets differ:", [r["payment_type"] for r in ours], list(theirs))
    for r in ours:
        t_trips, t_avg, t_tip = theirs[r["payment_type"]]
        if r["trips"] != t_trips:
            ok = False
            print(f"payment {r['payment_type']}: trips {r['trips']} != duckdb {t_trips}")
        for ours_v, theirs_v, name in (
            (r["avg_fare"], t_avg, "avg_fare"),
            (r["tip_pct"], t_tip, "tip_pct"),
        ):
            if not np.isclose(ours_v, theirs_v, rtol=1e-9, atol=1e-9):
                ok = False
            max_diff = max(max_diff, abs(ours_v - theirs_v))
        print(
            f"payment {r['payment_type']}: trips {r['trips']:,}  "
            f"avg fare {r['avg_fare']:.4f} (duckdb {t_avg:.4f})  "
            f"tip {r['tip_pct']:.3f}% (duckdb {t_tip:.3f}%)"
        )
    print(f"max float difference vs duckdb: {max_diff:.2e}")
    print("VERDICT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)
