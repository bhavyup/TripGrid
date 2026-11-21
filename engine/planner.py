"""The planner: choose which partition files a question needs,
using only the partition index — the data itself is never opened
at this stage. Partitions that cannot match the question's month /
borough conditions are pruned (skipped), and the plan reports how
much was skipped, because that saving is the point.
"""
from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_PATH = REPO_ROOT / "data" / "partitioned" / "partitions.json"


def load_index() -> list[dict]:
    if not INDEX_PATH.exists():
        raise FileNotFoundError(f"{INDEX_PATH} — run ingest.manifest first")
    return json.loads(INDEX_PATH.read_text(encoding="utf-8"))["partitions"]


def select_partitions(
    partitions: list[dict],
    months: set[str] | None = None,
    boroughs: set[str] | None = None,
) -> tuple[list[dict], dict]:
    """Filter the index by month (YYYY-MM) and/or borough names.
    Returns (selected entries, pruning stats)."""
    selected = [
        p
        for p in partitions
        if (months is None or p["month"] in months)
        and (boroughs is None or p["borough"] in boroughs)
    ]
    stats = {
        "partitions_total": len(partitions),
        "partitions_selected": len(selected),
        "partitions_pruned": len(partitions) - len(selected),
        "rows_total": sum(p["rows"] for p in partitions),
        "rows_selected": sum(p["rows"] for p in selected),
    }
    return selected, stats
