"""Build the partition index: one entry per organised data file.

The planner (engine/planner.py) reads ONLY this index to decide which
files a question needs — that is what "pruning" means: whole folders
are skipped without opening them. The index is built from Parquet
file metadata and column statistics, so building it reads no row data.

Output: data/partitioned/partitions.json
Entry: {path, month (YYYY-MM), borough, rows, fare_min, fare_max}
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
    for path in sorted(PART_DIR.glob("*/*/*.parquet")):
        rel = path.relative_to(REPO_ROOT).as_posix()
        month = next((p for p in path.parts if _MONTH_DIR.match(p)), None)
        borough = path.parent.name
        pf = pq.ParquetFile(path)
        md = pf.metadata
        fare_min = fare_max = None
        schema = pf.schema_arrow
        if "fare_amount" in schema.names:
            idx = schema.get_field_index("fare_amount")
            stats = md.row_group(0).column(idx).statistics
            if stats is not None:
                fare_min, fare_max = float(stats.min), float(stats.max)
        entries.append(
            {
                "path": rel,
                "month": month,
                "borough": borough,
                "rows": int(md.num_rows),
                "fare_min": fare_min,
                "fare_max": fare_max,
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
