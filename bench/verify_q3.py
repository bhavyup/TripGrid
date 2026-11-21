"""Correctness check for Q3: our engine vs DuckDB. Counts are
integers and must match exactly. The one honest wrinkle is a tie
at the rank-20 boundary: if several zones share the 20th count,
either selection is a correct top-20 — so the check compares the
full count lists and reports any boundary tie instead of hiding it.
DuckDB dayofweek: 0=Sunday .. 5=Friday. Ours: Monday=0 .. Friday=4.
"""
from __future__ import annotations

import json
import sys

import duckdb

from engine.executor import REPO_ROOT, run_q3
from engine.zones import ids_in_borough, load_zones


def duckdb_q3(year: int) -> list[tuple[int, int]]:
    pattern = (REPO_ROOT / "data" / "partitioned" / "**" / "*.parquet").as_posix()
    manhattan = ",".join(str(i) for i in sorted(ids_in_borough(load_zones(), "Manhattan")))
    rows = duckdb.sql(
        f"""
        SELECT do_location_id AS zone, count(*) AS trips
        FROM read_parquet('{pattern}', filename = true)
        WHERE substr(regexp_extract(filename, '(\\d{{4}}-\\d{{2}})', 1), 1, 4) = '{year}'
          AND pu_location_id IN ({manhattan})
          AND dayofweek(pickup_datetime) = 5
          AND hour(pickup_datetime) BETWEEN 17 AND 23
        GROUP BY zone
        ORDER BY trips DESC
        LIMIT 21
        """
    ).fetchall()
    return [(int(z), int(t)) for z, t in rows]


if __name__ == "__main__":
    year = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    ours, stats = run_q3(year)
    theirs = duckdb_q3(year)
    print(json.dumps(stats, indent=2))
    ours_pairs = [(r["do_location_id"], r["trips"]) for r in ours]
    theirs20 = theirs[:20]
    same_set = set(ours_pairs) == set(theirs20)
    print("our top 5:   ", ours_pairs[:5])
    print("duckdb top 5:", theirs20[:5])
    if len(theirs) > 20:
        boundary = theirs[19][1]
        tied = [z for z, t in theirs if t == boundary]
        if len(tied) > 1:
            print(f"note: tie at the rank-20 boundary (count {boundary}, zones {tied})")
    print("VERDICT:", "PASS — top-20 identical" if same_set else "CHECK — see tie note / diff")
    for r in ours:
        print(f"  #{r['rank']:>2}  {r['zone']} ({r['borough']}) — {r['trips']:,}")
    sys.exit(0 if same_set else 1)
