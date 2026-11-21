"""One (engine, query, year) run, executed as a subprocess by
bench/suite.py so each engine gets a clean process and an honest
peak-RSS reading. Prints exactly one JSON line:
{engine, query, year, wall_seconds, peak_rss_mb, result}.

Fairness rules, kept deliberately simple and stated here:
- All three engines read the SAME partitioned files — the exact
  file list the planner selects for that query (pruning is a
  property of the data layout, not of one engine).
- Wall time excludes interpreter/import startup; peak RSS includes
  the interpreter baseline. All three engines are Python processes,
  so the baseline is the same shape for everyone.
- pandas runs the way it is actually used on data this size: one
  file at a time, aggregating as it goes. Loading a whole year into
  one DataFrame first is the M0 baseline's job, not this suite's.
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

from engine import planner
from engine.measure import PeakSampler
from engine.zones import airport_ids, load_zones

REPO_ROOT = Path(__file__).resolve().parent.parent
ZONE_RANGE = 512


def _months(year: int) -> set[str]:
    return {f"{year}-{m:02d}" for m in range(1, 13)}


def _selected(year: int, boroughs: set[str] | None) -> list[dict]:
    selected, _ = planner.select_partitions(
        planner.load_index(), months=_months(year), boroughs=boroughs
    )
    return selected


def _files(year: int, boroughs: set[str] | None) -> list[str]:
    return [str(REPO_ROOT / e["path"]) for e in _selected(year, boroughs)]


# ------------------------------------------------------------ tripgrid
def tripgrid(query: str, year: int):
    from engine import executor

    if query == "q1":
        counts, _ = executor.run_q1(year, workers=executor.DEFAULT_WORKERS)
        return {"total": int(counts.sum()), "matrix": counts.tolist()}
    if query == "q2":
        rows, _ = executor.run_q2(year)
        return {"rows": rows}
    if query == "q3":
        rows, _ = executor.run_q3(year)
        return {"rows": [[r["do_location_id"], r["trips"]] for r in rows]}
    if query == "q4":
        rows, _ = executor.run_q4(year)
        return {"rows": rows}
    raise ValueError(query)


# ------------------------------------------------------------ duckdb
def duckdb_run(query: str, year: int):
    import duckdb

    if query == "q1":
        files = _files(year, None)
        rows = duckdb.sql(
            f"""
            SELECT CAST(substr(regexp_extract(filename, '(\\d{{4}}-\\d{{2}})', 1), 6, 2) AS INTEGER) - 1 AS m,
                   pu_location_id AS z, count(*) AS c
            FROM read_parquet({files!r}, filename = true) GROUP BY m, z
            """
        ).fetchall()
        matrix = np.zeros((12, ZONE_RANGE), dtype=np.int64)
        for m, z, c in rows:
            matrix[int(m), int(z)] = int(c)
        return {"total": int(matrix.sum()), "matrix": matrix.tolist()}
    if query == "q2":
        zone_map = load_zones()
        boroughs = {zone_map[i]["borough"].replace("/", "-") for i in airport_ids(zone_map)}
        files = _files(year, boroughs)
        airports = ",".join(str(i) for i in sorted(airport_ids(zone_map)))
        rows = duckdb.sql(
            f"""
            SELECT payment_type, count(*), avg(fare_amount),
                   100.0 * sum(tip_amount) / sum(fare_amount)
            FROM read_parquet({files!r})
            WHERE pu_location_id IN ({airports})
            GROUP BY payment_type ORDER BY payment_type
            """
        ).fetchall()
        return {
            "rows": [
                {"payment_type": int(p), "trips": int(t), "avg_fare": float(a), "tip_pct": float(tp)}
                for p, t, a, tp in rows
            ]
        }
    if query == "q3":
        files = _files(year, {"Manhattan"})
        rows = duckdb.sql(
            f"""
            SELECT do_location_id, count(*) AS c FROM read_parquet({files!r})
            WHERE dayofweek(pickup_datetime) = 5 AND hour(pickup_datetime) BETWEEN 17 AND 23
            GROUP BY do_location_id ORDER BY c DESC LIMIT 20
            """
        ).fetchall()
        return {"rows": [[int(z), int(c)] for z, c in rows]}
    if query == "q4":
        files = _files(year, None)
        rows = duckdb.sql(
            f"""
            SELECT regexp_extract(filename, '/\\d{{4}}-\\d{{2}}/([^/]+)/', 1) AS borough,
                   count(*), quantile_cont(fare_amount, 0.5),
                   quantile_cont(fare_amount, 0.9), quantile_cont(fare_amount, 0.99)
            FROM read_parquet({files!r}, filename = true) GROUP BY borough ORDER BY borough
            """
        ).fetchall()
        return {
            "rows": [
                {"borough": b, "trips": int(t), "p50": float(a), "p90": float(c), "p99": float(d)}
                for b, t, a, c, d in rows
            ]
        }
    raise ValueError(query)


# ------------------------------------------------------------ pandas
def pandas_run(query: str, year: int):
    import pandas as pd

    if query == "q1":
        matrix = np.zeros((12, ZONE_RANGE), dtype=np.int64)
        for e in _selected(year, None):
            month_idx = int(e["month"][5:7]) - 1
            s = pd.read_parquet(REPO_ROOT / e["path"], columns=["pu_location_id"])[
                "pu_location_id"
            ]
            matrix[month_idx] += np.bincount(s.to_numpy(), minlength=ZONE_RANGE)
        return {"total": int(matrix.sum()), "matrix": matrix.tolist()}
    if query == "q2":
        zone_map = load_zones()
        airports = airport_ids(zone_map)
        boroughs = {zone_map[i]["borough"].replace("/", "-") for i in airports}
        frames = []
        for e in _selected(year, boroughs):
            df = pd.read_parquet(
                REPO_ROOT / e["path"],
                columns=["pu_location_id", "payment_type", "fare_amount", "tip_amount"],
            )
            frames.append(df[df["pu_location_id"].isin(airports)])
        df = pd.concat(frames)
        g = df.groupby("payment_type")
        out = []
        for pay, grp in g:
            out.append(
                {
                    "payment_type": int(pay),
                    "trips": int(len(grp)),
                    "avg_fare": float(grp["fare_amount"].mean()),
                    "tip_pct": float(100.0 * grp["tip_amount"].sum() / grp["fare_amount"].sum()),
                }
            )
        return {"rows": sorted(out, key=lambda r: r["payment_type"])}
    if query == "q3":
        counts = np.zeros(ZONE_RANGE, dtype=np.int64)
        for e in _selected(year, {"Manhattan"}):
            df = pd.read_parquet(
                REPO_ROOT / e["path"], columns=["pickup_datetime", "do_location_id"]
            )
            mask = (df["pickup_datetime"].dt.dayofweek == 4) & (
                df["pickup_datetime"].dt.hour.between(17, 23)
            )
            counts += np.bincount(
                df.loc[mask, "do_location_id"].to_numpy(), minlength=ZONE_RANGE
            )
        top = np.argsort(-counts)[:20]
        return {"rows": [[int(z), int(counts[z])] for z in top if counts[z] > 0]}
    if query == "q4":
        import pandas as pd  # noqa: F811

        rows = []
        boroughs = sorted({e["borough"] for e in _selected(year, None)})
        for borough in boroughs:
            parts = [
                pd.read_parquet(REPO_ROOT / e["path"], columns=["fare_amount"])[
                    "fare_amount"
                ].to_numpy()
                for e in _selected(year, {borough})
            ]
            fares = np.concatenate(parts)
            p50, p90, p99 = np.percentile(fares, [50, 90, 99])
            rows.append(
                {
                    "borough": borough,
                    "trips": int(fares.size),
                    "p50": float(p50),
                    "p90": float(p90),
                    "p99": float(p99),
                }
            )
        return {"rows": rows}
    raise ValueError(query)


ENGINES = {"tripgrid": tripgrid, "duckdb": duckdb_run, "pandas": pandas_run}

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, choices=list(ENGINES))
    ap.add_argument("--query", required=True, choices=["q1", "q2", "q3", "q4"])
    ap.add_argument("--year", required=True, type=int)
    args = ap.parse_args()
    with PeakSampler() as sampler:
        t0 = time.perf_counter()
        result = ENGINES[args.engine](args.query, args.year)
        wall = time.perf_counter() - t0
    print(
        json.dumps(
            {
                "engine": args.engine,
                "query": args.query,
                "year": args.year,
                "wall_seconds": round(wall, 3),
                "peak_rss_mb": round(sampler.peak_mb, 1),
                "result": result,
            }
        )
    )
