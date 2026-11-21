"""Exact fare percentiles — the locked hybrid design (DESIGN Traps C).

Why this needs care: an exact percentile over 40M+ rows cannot sort
the data in memory, and a sketch (t-digest etc.) is approximate —
both were rejected. Munro-Paterson says no one-pass exact method
with tiny memory exists for arbitrary data, so the design exploits
the structure of money instead:

Per chunk of fares:
  1. Convert dollars to cents (x100). Fares that are exact cents in
     the normal range $0-$1,000 take the fast path: `np.bincount`
     over 100,001 counters (~800 KB, sized by the CAP, never by the
     largest fare seen — one $335,544 fare in 2024 would otherwise
     demand ~800 MB of counters).
  2. Everything else — negative fares, fares over $1,000, and any
     fare that is not an exact number of cents — goes through
     `np.unique` and is kept exactly, at its exact value.
  3. Both parts merge into one small sparse table: (fare, count)
     pairs, sorted by fare. On TLC data a whole month has only
     ~9k-12k distinct fares, so the table stays tiny.

Chunk tables merge by adding counts for equal fares, so the final
table is exactly the table a single pass over all rows would build.
Percentiles are then read off it with DuckDB's `quantile_cont`
rule: idx = p * (N - 1), interpolating between the two neighbouring
order statistics — including when they are different fare values.

Fallback (kernels.select_kth_int64, radix selection on int64 cents,
synthetically tested): if a bucket's distinct fares ever exploded
past ~2M, the sparse table would grow too big and ingest would have
to spill raw cents to disk for a selection pass instead. Measured
TLC distinct counts (~12k/month) are two orders of magnitude below
that trigger, so the fallback is a tested kernel, not a hot path.
"""
from __future__ import annotations

import numpy as np

CAP_CENTS = 100_000  # $1,000.00 — the fast path covers 0..CAP_CENTS
_CENT_TOL = 1e-6  # in cents; a real non-cent fare is >= 0.1 cent away


def chunk_sparse_table(fares_dollars: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """One chunk of fares -> sparse (fare_cents, count) table, sorted.

    Keys are float64 cents: exact integers for cent fares, and the
    exact fare*100 value for non-cent fares, so nothing is rounded.
    """
    cents = fares_dollars.astype(np.float64) * 100.0
    rounded = np.round(cents)
    is_cent = np.abs(cents - rounded) <= _CENT_TOL
    fast = is_cent & (rounded >= 0) & (rounded <= CAP_CENTS)
    keys_parts: list[np.ndarray] = []
    counts_parts: list[np.ndarray] = []
    if fast.any():
        dense = np.bincount(rounded[fast].astype(np.int64), minlength=CAP_CENTS + 1)
        nz = np.nonzero(dense)[0]
        keys_parts.append(nz.astype(np.float64))
        counts_parts.append(dense[nz].astype(np.int64))
    rest = cents[~fast]
    if rest.size:
        uniq, cnts = np.unique(rest, return_counts=True)
        keys_parts.append(uniq.astype(np.float64))
        counts_parts.append(cnts.astype(np.int64))
    if not keys_parts:
        return np.empty(0, dtype=np.float64), np.empty(0, dtype=np.int64)
    return merge_sparse(
        (np.concatenate(keys_parts), np.concatenate(counts_parts)),
        (np.empty(0, dtype=np.float64), np.empty(0, dtype=np.int64)),
    )


def merge_sparse(
    a: tuple[np.ndarray, np.ndarray], b: tuple[np.ndarray, np.ndarray]
) -> tuple[np.ndarray, np.ndarray]:
    """Merge two sparse tables: same fare -> counts add. Exact."""
    keys = np.concatenate([a[0], b[0]])
    counts = np.concatenate([a[1], b[1]])
    if keys.size == 0:
        return keys, counts
    uniq, inv = np.unique(keys, return_inverse=True)
    merged = np.bincount(inv, weights=counts, minlength=uniq.size).astype(np.int64)
    return uniq, merged


def _value_at_rank(keys: np.ndarray, cum_counts: np.ndarray, rank: int) -> float:
    """The fare (in cents) sitting at position `rank` (0-based) in
    the sorted multiset the sparse table describes."""
    i = int(np.searchsorted(cum_counts, rank, side="right"))
    return float(keys[i])


def quantile_from_sparse(keys: np.ndarray, counts: np.ndarray, p: float) -> float:
    """One quantile in DOLLARS, DuckDB quantile_cont semantics:
    idx = p * (N - 1), linear interpolation between neighbours."""
    n = int(counts.sum())
    if n == 0:
        return float("nan")
    if n == 1:
        return float(keys[0]) / 100.0
    cum = np.cumsum(counts)
    idx = p * (n - 1)
    lo = int(np.floor(idx))
    hi = int(np.ceil(idx))
    v_lo = _value_at_rank(keys, cum, lo)
    if hi == lo:
        return v_lo / 100.0
    v_hi = _value_at_rank(keys, cum, hi)
    return (v_lo + (v_hi - v_lo) * (idx - lo)) / 100.0


def percentiles_from_sparse(
    keys: np.ndarray, counts: np.ndarray, ps=(0.5, 0.9, 0.99)
) -> dict[float, float]:
    return {p: quantile_from_sparse(keys, counts, p) for p in ps}
