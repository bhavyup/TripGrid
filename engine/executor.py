"""Chunked executor (M1): runs a query over the partitioned dataset
by reading small pieces, never the whole thing.

For each Parquet file under data/partitioned it streams batches of
`batch_rows` rows (PyArrow `iter_batches`), turns each batch into a
partial result with the kernels, and merges partials by addition.
Peak memory is watched the whole time; if the process tree crosses
the ceiling, the run fails loudly instead of quietly swapping.

M1 runs single-process on purpose: the worker pool is M2. What M1
proves is the chunk-and-merge machinery and the memory ceiling.
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from engine import kernels
from engine.measure import PeakSampler

REPO_ROOT = Path(__file__).resolve().parent.parent
PART_DIR = REPO_ROOT / "data" / "partitioned"

ZONE_RANGE = 512  # zone ids are 0..265; 512 gives composite keys headroom
MONTHS = 12
DEFAULT_CEILING_MB = 2048.0
DEFAULT_BATCH_ROWS = 65_536

_MONTH_RE = re.compile(r"^(\d{4})-(\d{2})$")


class CeilingExceeded(RuntimeError):
    pass


def _month_index(path: Path) -> int:
    """The layout is partitioned/<YYYY-MM>/<borough>/<file>.parquet —
    find the path part that looks like a month and use it."""
    for part in path.parts:
        m = _MONTH_RE.match(part)
        if m:
            return int(m.group(2)) - 1
    raise ValueError(f"no YYYY-MM partition in path: {path}")


def iter_zone_chunks(year: int, batch_rows: int = DEFAULT_BATCH_ROWS):
    """Yield (month_index, pu_location_id array) pieces, one batch at a time."""
    files = sorted(PART_DIR.glob(f"{year}-*/**/*.parquet"))
    if not files:
        raise FileNotFoundError(f"no partitioned files for {year} under {PART_DIR}")
    for path in files:
        month_idx = _month_index(path)
        pf = pq.ParquetFile(path)
        for batch in pf.iter_batches(batch_size=batch_rows, columns=["pu_location_id"]):
            yield month_idx, batch.column(0).to_numpy(zero_copy_only=False)


def run_q1(
    year: int,
    batch_rows: int = DEFAULT_BATCH_ROWS,
    ceiling_mb: float = DEFAULT_CEILING_MB,
) -> tuple[np.ndarray, dict]:
    """Benchmark Query 1: trips per pickup zone per month.

    Returns (counts, stats) where counts is a (12, ZONE_RANGE) matrix:
    counts[month, zone] = trips that started in that zone that month.
    """
    counts = np.zeros(MONTHS * ZONE_RANGE, dtype=np.int64)
    rows = 0
    chunks = 0
    t0 = time.perf_counter()
    with PeakSampler() as sampler:
        for month_idx, zones in iter_zone_chunks(year, batch_rows):
            keys = kernels.composite_key(
                np.full(zones.shape, month_idx, dtype=np.int64), zones, ZONE_RANGE
            )
            counts = kernels.merge_partials(counts, kernels.group_count(keys, counts.size))
            rows += int(zones.size)
            chunks += 1
            if sampler.peak_mb > ceiling_mb:
                raise CeilingExceeded(
                    f"peak RSS {sampler.peak_mb:.0f} MB crossed ceiling {ceiling_mb:.0f} MB"
                )
    wall = time.perf_counter() - t0
    stats = {
        "query": "Q1 trips per pickup zone per month",
        "year": year,
        "rows_scanned": rows,
        "chunks": chunks,
        "batch_rows": batch_rows,
        "wall_seconds": round(wall, 3),
        "rows_per_second": int(rows / wall) if wall > 0 else 0,
        "peak_rss_mb": round(sampler.peak_mb, 1),
        "ceiling_mb": ceiling_mb,
        "under_ceiling": sampler.peak_mb <= ceiling_mb,
    }
    return counts.reshape(MONTHS, ZONE_RANGE), stats


# ---------------------------------------------------------------- M2
# Pruning (planner picks files from the index) + a small worker pool
# (2-3 workers, DESIGN Traps B) + the zone join + top-k.
# Each worker handles whole files and returns a small partial; the
# main process merges partials by addition, exactly as in M1.

from concurrent.futures import ProcessPoolExecutor

from engine import planner, zones

PAYMENT_TYPES = 8  # payment_type values are 0..6 in practice
FRIDAY = 4  # in kernels.weekday_of numbering (Monday=0)
EVENING_START, EVENING_END = 17, 23  # 17:00 .. 23:59


def _months_of(year: int) -> set[str]:
    return {f"{year}-{m:02d}" for m in range(1, 13)}


def _run_pool(worker, jobs: list, workers: int, ceiling_mb: float):
    """Run worker over jobs in a pool, merge nothing — returns the
    list of partials plus run stats. Peak RSS covers the whole tree
    (main + pool workers), and the ceiling is enforced on it."""
    t0 = time.perf_counter()
    with PeakSampler() as sampler:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            partials = list(pool.map(worker, jobs))
    wall = time.perf_counter() - t0
    if sampler.peak_mb > ceiling_mb:
        raise CeilingExceeded(
            f"peak RSS {sampler.peak_mb:.0f} MB crossed ceiling {ceiling_mb:.0f} MB"
        )
    stats = {
        "wall_seconds": round(wall, 3),
        "peak_rss_mb": round(sampler.peak_mb, 1),
        "ceiling_mb": ceiling_mb,
        "under_ceiling": sampler.peak_mb <= ceiling_mb,
        "workers": workers,
    }
    return partials, stats


def _q2_partial(job) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    path, airport_tuple = job
    airports = np.array(airport_tuple, dtype=np.int64)
    counts = np.zeros(PAYMENT_TYPES, dtype=np.int64)
    fare_sum = np.zeros(PAYMENT_TYPES, dtype=np.float64)
    tip_sum = np.zeros(PAYMENT_TYPES, dtype=np.float64)
    scanned = 0
    pf = pq.ParquetFile(path)
    for batch in pf.iter_batches(
        batch_size=DEFAULT_BATCH_ROWS,
        columns=["pu_location_id", "payment_type", "fare_amount", "tip_amount"],
    ):
        pu = batch.column(0).to_numpy(zero_copy_only=False)
        scanned += pu.size
        mask = np.isin(pu, airports)
        if not mask.any():
            continue
        pay = batch.column(1).to_numpy(zero_copy_only=False)[mask]
        fare = batch.column(2).to_numpy(zero_copy_only=False)[mask]
        tip = batch.column(3).to_numpy(zero_copy_only=False)[mask]
        counts += kernels.group_count(pay, PAYMENT_TYPES)
        fare_sum += kernels.group_sum(pay, fare, PAYMENT_TYPES)
        tip_sum += kernels.group_sum(pay, tip, PAYMENT_TYPES)
    return counts, fare_sum, tip_sum, scanned


def run_q2(year: int, workers: int = 3, ceiling_mb: float = DEFAULT_CEILING_MB):
    """Benchmark Query 2: for rides that START at an airport, the
    average fare and tip % per payment type. Pruning: only the
    boroughs that contain an airport (Queens, EWR) are read."""
    zone_map = zones.load_zones()
    airports = zones.airport_ids(zone_map)
    airport_boroughs = {zone_map[i]["borough"].replace("/", "-") for i in airports}
    index = planner.load_index()
    selected, prune = planner.select_partitions(
        index, months=_months_of(year), boroughs=airport_boroughs
    )
    jobs = [
        (str(REPO_ROOT / e["path"]), tuple(sorted(airports))) for e in selected
    ]
    partials, stats = _run_pool(_q2_partial, jobs, workers, ceiling_mb)
    counts = sum(p[0] for p in partials)
    fare_sum = sum(p[1] for p in partials)
    tip_sum = sum(p[2] for p in partials)
    rows = []
    for pay in range(PAYMENT_TYPES):
        if counts[pay] == 0:
            continue
        rows.append(
            {
                "payment_type": pay,
                "trips": int(counts[pay]),
                "avg_fare": float(fare_sum[pay] / counts[pay]),
                "tip_pct": float(100.0 * tip_sum[pay] / fare_sum[pay])
                if fare_sum[pay] > 0
                else 0.0,
            }
        )
    stats.update(prune)
    stats["rows_scanned"] = int(sum(p[3] for p in partials))
    stats["query"] = "Q2 airport pickups: avg fare + tip % by payment type"
    stats["airport_zone_ids"] = sorted(airports)
    return rows, stats


def _q3_partial(job) -> tuple[np.ndarray, int]:
    (path,) = job
    counts = np.zeros(ZONE_RANGE, dtype=np.int64)
    scanned = 0
    pf = pq.ParquetFile(path)
    for batch in pf.iter_batches(
        batch_size=DEFAULT_BATCH_ROWS, columns=["pickup_datetime", "do_location_id"]
    ):
        dt = batch.column(0).to_numpy(zero_copy_only=False)
        scanned += dt.size
        mask = (kernels.weekday_of(dt) == FRIDAY) & (
            (kernels.hour_of(dt) >= EVENING_START) & (kernels.hour_of(dt) <= EVENING_END)
        )
        if not mask.any():
            continue
        do = batch.column(1).to_numpy(zero_copy_only=False)[mask]
        counts += kernels.group_count(do, ZONE_RANGE)
    return counts, scanned


def run_q3(year: int, workers: int = 3, ceiling_mb: float = DEFAULT_CEILING_MB, k: int = 20):
    """Benchmark Query 3: top-20 drop-off zones for rides that start
    in Manhattan on a Friday evening (17:00-23:59). Pruning: only
    Manhattan partitions are read. The zone join turns ids into
    names at the very end, on 20 rows only."""
    index = planner.load_index()
    selected, prune = planner.select_partitions(
        index, months=_months_of(year), boroughs={"Manhattan"}
    )
    jobs = [(str(REPO_ROOT / e["path"]),) for e in selected]
    partials, stats = _run_pool(_q3_partial, jobs, workers, ceiling_mb)
    counts = sum(p[0] for p in partials)
    zone_map = zones.load_zones()
    rows = []
    for rank, zone_id in enumerate(kernels.topk_indices(counts, k), start=1):
        info = zone_map.get(int(zone_id), {"borough": "?", "zone": "?"})
        rows.append(
            {
                "rank": rank,
                "do_location_id": int(zone_id),
                "zone": info["zone"],
                "borough": info["borough"],
                "trips": int(counts[zone_id]),
            }
        )
    stats.update(prune)
    stats["rows_scanned"] = int(sum(p[1] for p in partials))
    stats["query"] = "Q3 Friday-evening Manhattan pickups: top-20 drop-off zones"
    return rows, stats


if __name__ == "__main__":
    year = int(sys.argv[1]) if len(sys.argv) > 1 else 2024
    counts, stats = run_q1(year)
    print(json.dumps(stats, indent=2))
    out_dir = REPO_ROOT / "bench" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out_dir / f"q1_engine_{year}.npz", counts=counts)
    (out_dir / f"q1_engine_{year}.json").write_text(
        json.dumps(stats, indent=2), encoding="utf-8"
    )
    print(f"total trips counted: {int(counts.sum()):,}")
