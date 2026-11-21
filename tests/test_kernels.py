"""Unit tests for the M1 kernels and the chunk-merge property.

The most important test here is `test_chunked_merge_equals_whole`:
it proves that counting piece by piece and adding the pieces gives
exactly the same answer as counting everything at once. The whole
engine rests on that.
"""
import numpy as np

from engine import kernels


def test_group_count_hand_checked():
    keys = np.array([0, 1, 1, 2, 2, 2], dtype=np.int64)
    assert kernels.group_count(keys, 4).tolist() == [1, 2, 3, 0]


def test_group_sum_and_mean_hand_checked():
    keys = np.array([0, 0, 1, 1, 1], dtype=np.int64)
    values = np.array([10.0, 20.0, 3.0, 6.0, 9.0])
    assert kernels.group_sum(keys, values, 2).tolist() == [30.0, 18.0]
    assert kernels.group_mean(keys, values, 2).tolist() == [15.0, 6.0]


def test_composite_key_rejects_out_of_range():
    high = np.array([0, 1], dtype=np.int64)
    low = np.array([0, 512], dtype=np.int64)
    try:
        kernels.composite_key(high, low, 512)
        raise AssertionError("should have raised")
    except ValueError:
        pass


def test_chunked_merge_equals_whole():
    rng = np.random.default_rng(42)
    keys = rng.integers(0, 12 * 512, size=100_000, dtype=np.int64)
    whole = kernels.group_count(keys, 12 * 512)
    merged = np.zeros_like(whole)
    for start in range(0, keys.size, 7_919):  # uneven pieces on purpose
        piece = kernels.group_count(keys[start : start + 7_919], 12 * 512)
        merged = kernels.merge_partials(merged, piece)
    assert np.array_equal(merged, whole)
