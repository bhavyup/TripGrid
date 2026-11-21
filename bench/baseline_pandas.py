"""The naive baseline (M0): one query, done the ordinary pandas way.

Loads a whole month with `pd.read_parquet` — no chunking, no pruning,
no memory budget — and runs Benchmark Query 1 for that month (trips per
pickup zone). Records wall time and peak RSS of the whole process tree
(psutil, DESIGN Traps B). Later engine numbers are only meaningful
against this baseline.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pandas as pd
import psutil

REPO_ROOT = Path(__file__).resolve().parent.parent


def peak_rss_mb() -> float:
    proc = psutil.Process()
    total = proc.memory_info().rss
    for child in proc.children(recursive=True):
        try:
            total += child.memory_info().rss
        except psutil.NoSuchProcess:
            pass
    return total / (1 << 20)


def run(year: int, month: int) -> dict:
    raw = REPO_ROOT / "data" / "raw" / f"yellow_tripdata_{year}-{month:02d}.parquet"
    t0 = time.perf_counter()
    df = pd.read_parquet(raw)
    counts = df.groupby("PULocationID").size().sort_values(ascending=False)
    wall = time.perf_counter() - t0
    result = {
        "engine": "pandas-naive",
        "query": "Q1 trips per pickup zone (single month)",
        "file": raw.name,
        "rows": int(len(df)),
        "zones": int(counts.size),
        "wall_seconds": round(wall, 3),
        "peak_rss_mb": round(peak_rss_mb(), 1),
        "top5_zones": {str(k): int(v) for k, v in counts.head(5).items()},
    }
    out_dir = REPO_ROOT / "bench" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"baseline_{year}-{month:02d}.json"
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    return result


if __name__ == "__main__":
    run(int(sys.argv[1]), int(sys.argv[2]))
