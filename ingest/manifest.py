"""Build the partition index: one entry per organised data file.

The planner (engine/planner.py) reads ONLY this index to decide which
files a question needs — that is what "pruning" means: whole folders
are skipped without opening them. The index is built from Parquet
file metadata and column statistics, so building it reads no row data.

Output: data/partitioned/partitions.json
Entry: {path, month (YYYY-MM), borough, rows, fare_min, fare_max,
        fleet, layout}

Two directory shapes are recognised, so the fleet gate stays open:
  <month>/<borough>/<file>            (fleet defaults to "yellow")
  <fleet>/<month>/<borough>/<file>
Fare stats are reported in dollars under both storage layouts —
for v2 files the stored fare_c cents are scaled back here.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pyarrow.parquet as pq

REPO_ROOT = Path(__file__).resolve().parent.parent
PART_DIR = REPO_ROOT / "data" / "partitioned"
_MONTH_DIR = re.compile(r"^\d{4}-\d{2}$")


def build_partition_index() -> dict:
    entries = []
    for path in sorted(PART_DIR.rglob("*.parquet")):
        rel = path.relative_to(REPO_ROOT).as_posix()
        parts = path.relative_to(PART_DIR).parts
        month_at = next(
            (i for i, p in enumerate(parts) if _MONTH_DIR.match(p)), None
        )
        if month_at is None or month_at + 1 >= len(parts):
            continue
        month = parts[month_at]
        borough = parts[month_at + 1]
        fleet = parts[month_at - 1] if month_at > 0 else "yellow"
        pf = pq.ParquetFile(path)
        md = pf.metadata
        fare_min = fare_max = None
        schema = pf.schema_arrow
        layout = "v1"
        fare_col, scale = "fare_amount", 1.0
        if "fare_c" in schema.names:
            layout, fare_col, scale = "v2", "fare_c", 0.01
        if fare_col in schema.names:
            idx = schema.get_field_index(fare_col)
            stats = md.row_group(0).column(idx).statistics
            if stats is not None:
                fare_min = float(stats.min) * scale
                fare_max = float(stats.max) * scale
        entries.append(
            {
                "path": rel,
                "month": month,
                "borough": borough,
                "rows": int(md.num_rows),
                "fare_min": fare_min,
                "fare_max": fare_max,
                "fleet": fleet,
                "layout": layout,
            }
        )
    index = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "partitions": entries,
        "total_rows": sum(e["rows"] for e in entries),
    }
    (PART_DIR / "partitions.json").write_text(json.dumps(index, indent=2), encoding="utf-8")
    return index


if __name__ == "__main__":
    idx = build_partition_index()
    print(f"partitions: {len(idx['partitions'])}  total rows: {idx['total_rows']:,}")
