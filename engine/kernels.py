"""Vectorised NumPy kernels — the engine's building blocks.

Every kernel works on plain NumPy arrays, one chunk at a time, and
returns a *partial* result that can be merged with the partial from
any other chunk by simple addition. That merge property is what makes
chunked, out-of-core execution possible: counts add, sums add, and a
mean is just a merged sum divided by a merged count at the end.

No Python row loops anywhere: counting is `np.bincount` (one linear
pass, O(N)), which works when keys are small non-negative integers —
zone ids, month indexes, payment types. Two integer key columns are
combined into one with `composite_key` (high * range + low).
"""
from __future__ import annotations

import numpy as np


def composite_key(high: np.ndarray, low: np.ndarray, low_range: int) -> np.ndarray:
    """Combine two int key columns into one int64 key: high * low_range + low."""
    low = low.astype(np.int64)
    if low.size and (low.min() < 0 or low.max() >= low_range):
        raise ValueError(f"low key out of range [0, {low_range})")
    return high.astype(np.int64) * low_range + low


def group_count(keys: np.ndarray, size: int) -> np.ndarray:
    """Count rows per key value. Result[i] = number of rows with key == i."""
    return np.bincount(keys, minlength=size).astype(np.int64)


def group_sum(keys: np.ndarray, values: np.ndarray, size: int) -> np.ndarray:
    """Sum `values` per key value, in one linear pass."""
    return np.bincount(keys, weights=values.astype(np.float64), minlength=size)


def group_mean(keys: np.ndarray, values: np.ndarray, size: int) -> np.ndarray:
    """Mean of `values` per key value, from a merged sum and count."""
    counts = group_count(keys, size)
    sums = group_sum(keys, values, size)
    out = np.full(size, np.nan)
    np.divide(sums, counts, out=out, where=counts > 0)
    return out


def merge_partials(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Merge two partial count/sum vectors. This is just addition —
    the whole reason chunked execution gives the same answer as
    reading everything at once."""
    if a.shape != b.shape:
        raise ValueError(f"partial shape mismatch: {a.shape} vs {b.shape}")
    return a + b
