"""The M3 benchmark suite: every query x every engine x one year,
each run as a clean subprocess (bench/runners.py), with a
correctness gate — TripGrid and pandas are both compared against
DuckDB, counts exactly and floats to 1e-6 relative. A fast-but-wrong
result fails the suite, by design.

Usage: python -m bench.suite 2024 [2025 ...]
Writes bench/results/suite_<year>.json and prints a summary table.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
ENGINES = ["tripgrid", "duckdb", "pandas"]
QUERIES = ["q1", "q2", "q3", "q4"]
RTOL = 1e-6


def run_one(engine: str, query: str, year: int) -> dict:
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "bench.runners",
            "--engine",
            engine,
            "--query",
            query,
            "--year",
            str(year),
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"{engine}/{query}/{year} failed:\n{proc.stderr[-2000:]}")
    return json.loads(proc.stdout.strip().splitlines()[-1])


def compare(query: str, ours: dict, ref: dict) -> tuple[bool, str]:
    """Compare one engine's result against DuckDB's (the reference)."""
    if query == "q1":
        ok = ours["total"] == ref["total"] and ours["matrix"] == ref["matrix"]
        return ok, "counts matrix exact" if ok else "counts differ"
    if query == "q2":
        a = {r["payment_type"]: r for r in ours["rows"]}
        b = {r["payment_type"]: r for r in ref["rows"]}
        if set(a) != set(b):
            return False, "payment types differ"
        worst = 0.0
        for k in a:
            if a[k]["trips"] != b[k]["trips"]:
                return False, f"trips differ for payment {k}"
            for f in ("avg_fare", "tip_pct"):
                if not np.isclose(a[k][f], b[k][f], rtol=RTOL, atol=1e-9):
                    return False, f"{f} differs for payment {k}"
                worst = max(worst, abs(a[k][f] - b[k][f]))
        return True, f"max float diff {worst:.2e}"
    if query == "q3":
        a = {z: c for z, c in ours["rows"]}
        b = {z: c for z, c in ref["rows"]}
        ok = a == b
        return ok, "top-20 zones+counts exact" if ok else f"top-20 differ: {a} vs {b}"
    if query == "q4":
        a = {r["borough"]: r for r in ours["rows"]}
        b = {r["borough"]: r for r in ref["rows"]}
        if set(a) != set(b):
            return False, "boroughs differ"
        worst = 0.0
        for k in a:
            if a[k]["trips"] != b[k]["trips"]:
                return False, f"trips differ for {k}"
            for f in ("p50", "p90", "p99"):
                if not np.isclose(a[k][f], b[k][f], rtol=RTOL, atol=1e-9):
                    return False, f"{f} differs for {k}"
                worst = max(worst, abs(a[k][f] - b[k][f]))
        return True, f"max float diff {worst:.2e}"
    raise ValueError(query)


def main(years: list[int]) -> int:
    all_ok = True
    for year in years:
        runs: dict[tuple[str, str], dict] = {}
        for query in QUERIES:
            for engine in ENGINES:
                print(f"[{year}] {query} / {engine} ...", flush=True)
                runs[(engine, query)] = run_one(engine, query, year)
        print(f"\n=== {year} ===")
        print(f"{'query':<6}{'engine':<10}{'wall (s)':>10}{'peak MB':>10}  gate vs duckdb")
        gates = {}
        for query in QUERIES:
            ref = runs[("duckdb", query)]["result"]
            for engine in ENGINES:
                r = runs[(engine, query)]
                if engine == "duckdb":
                    gate = "reference"
                else:
                    ok, note = compare(query, r["result"], ref)
                    gates[(engine, query)] = ok
                    all_ok = all_ok and ok
                    gate = ("PASS " if ok else "FAIL ") + note
                print(
                    f"{query:<6}{engine:<10}{r['wall_seconds']:>10.3f}"
                    f"{r['peak_rss_mb']:>10.1f}  {gate}"
                )
        out = {
            "year": year,
            "runs": {
                f"{e}/{q}": {k: v for k, v in runs[(e, q)].items() if k != "result"}
                for e in ENGINES
                for q in QUERIES
            },
            "gates_vs_duckdb": {f"{e}/{q}": v for (e, q), v in gates.items()},
        }
        out_dir = REPO_ROOT / "bench" / "results"
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"suite_{year}.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
        print(f"saved bench/results/suite_{year}.json")
    print("\nSUITE VERDICT:", "ALL GATES PASS" if all_ok else "SOME GATES FAILED")
    return 0 if all_ok else 1


if __name__ == "__main__":
    years = [int(a) for a in sys.argv[1:]] or [2024]
    sys.exit(main(years))
