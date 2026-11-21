"""The TLC zone lookup: 265 rows that turn location ids into names.

The join in this engine is a hash join against this tiny table —
load it once into a dict, then look up ids in O(1). The table is
small enough that it is broadcast to every worker whole; there is
no reason to partition it.
"""
from __future__ import annotations

import csv
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LOOKUP_PATH = REPO_ROOT / "data" / "raw" / "taxi_zone_lookup.csv"


def load_zones() -> dict[int, dict]:
    """id -> {borough, zone}"""
    with open(LOOKUP_PATH, newline="", encoding="utf-8") as f:
        return {
            int(r["LocationID"]): {"borough": r["Borough"], "zone": r["Zone"]}
            for r in csv.DictReader(f)
        }


def airport_ids(zones: dict[int, dict]) -> set[int]:
    """Ids whose zone name says Airport (JFK, LaGuardia, Newark)."""
    return {i for i, z in zones.items() if "Airport" in z["zone"]}


def ids_in_borough(zones: dict[int, dict], borough: str) -> set[int]:
    return {i for i, z in zones.items() if z["borough"] == borough}
