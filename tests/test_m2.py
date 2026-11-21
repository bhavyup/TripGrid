"""Unit tests for M2 pieces: the planner's skipping, the weekday /
hour arithmetic Q3 rests on, and top-k selection.

Known dates, checked against a real calendar:
- 2024-01-01 was a Monday; 2024-01-05 was a Friday; 2024-01-07 a Sunday.
"""
import numpy as np

from engine import kernels
from engine.planner import select_partitions


def _fake_index():
    return [
        {"path": "p1", "month": "2024-01", "borough": "Manhattan", "rows": 100},
        {"path": "p2", "month": "2024-01", "borough": "Queens", "rows": 50},
        {"path": "p3", "month": "2024-02", "borough": "Manhattan", "rows": 70},
    ]


def test_planner_prunes_by_borough():
    selected, stats = select_partitions(_fake_index(), boroughs={"Manhattan"})
    assert [p["path"] for p in selected] == ["p1", "p3"]
    assert stats["partitions_pruned"] == 1
    assert stats["rows_selected"] == 170


def test_planner_prunes_by_month():
    selected, stats = select_partitions(_fake_index(), months={"2024-02"})
    assert [p["path"] for p in selected] == ["p3"]
    assert stats["rows_selected"] == 70


def test_weekday_known_dates():
    dt = np.array(
        ["2024-01-01", "2024-01-05", "2024-01-07"], dtype="datetime64[D]"
    ).astype("datetime64[us]")
    assert kernels.weekday_of(dt).tolist() == [0, 4, 6]  # Mon, Fri, Sun


def test_hour_known_times():
    dt = np.array(
        ["2024-01-05T17:30", "2024-01-05T23:59", "2024-01-05T00:05"],
        dtype="datetime64[m]",
    ).astype("datetime64[us]")
    assert kernels.hour_of(dt).tolist() == [17, 23, 0]


def test_topk_order():
    values = np.array([5, 9, 1, 9, 3], dtype=np.int64)
    idx = kernels.topk_indices(values, 3)
    assert values[idx].tolist() == [9, 9, 5]
