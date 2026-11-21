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


def weekday_of(datetimes: np.ndarray) -> np.ndarray:
    """Day of week for naive datetimes, Monday=0 .. Sunday=6.

    Pure arithmetic on the day count: the Unix epoch (1970-01-01)
    was a Thursday, which is 3 in Monday-first numbering, hence +3.
    """
    days = datetimes.astype("datetime64[D]").astype(np.int64)
    return (days + 3) % 7


def hour_of(datetimes: np.ndarray) -> np.ndarray:
    """Hour of day (0..23) for naive datetimes, from the hour count."""
    return (datetimes.astype("datetime64[h]").astype(np.int64) % 24).astype(np.int64)


def topk_indices(values: np.ndarray, k: int) -> np.ndarray:
    """Indexes of the k largest values, largest first.

    `np.argpartition` finds the top k in O(N) without sorting all N;
    only the k winners are then sorted between themselves.
    """
    k = min(k, values.size)
    if k == 0:
        return np.empty(0, dtype=np.int64)
    part = np.argpartition(-values, k - 1)[:k]
    return part[np.argsort(-values[part])]


def select_kth_int64(values: np.ndarray, k: int) -> int:
    """The k-th smallest value (0-based) of an int64 array, by radix
    selection: bucket by the top byte, keep only the bucket that
    must contain rank k, repeat on the next byte. No full sort.

    The percentile fallback (DESIGN Traps C). It works on the raw
    signed integers through an order-preserving flip — XOR with the
    sign bit maps int64 order onto uint64 order. Sorting raw float64
    bytes instead would order negatives backwards (IEEE-754), which
    is why this takes int64 cents, never floats.
    """
    if not 0 <= k < values.size:
        raise ValueError(f"k={k} out of range for size {values.size}")
    arr = (values.astype(np.int64) ^ np.iinfo(np.int64).min).view(np.uint64).copy()
    for shift in range(56, -1, -8):
        byte = ((arr >> shift) & 0xFF).astype(np.int64)
        counts = np.bincount(byte, minlength=256)
        cum = np.cumsum(counts)
        bucket = int(np.searchsorted(cum, k, side="right"))
        if bucket > 0:
            k -= int(cum[bucket - 1])
        arr = arr[byte == bucket]
        if arr.size == 1:
            break
    return int(arr[0].view(np.int64) ^ np.iinfo(np.int64).min)


def merge_partials(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Merge two partial count/sum vectors. This is just addition —
    the whole reason chunked execution gives the same answer as
    reading everything at once."""
    if a.shape != b.shape:
        raise ValueError(f"partial shape mismatch: {a.shape} vs {b.shape}")
    return a + b
