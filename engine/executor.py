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
