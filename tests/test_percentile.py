"""Tests for the exact percentile machinery (locked hybrid design).

Hand-checked cases first (the interpolation rule is DuckDB's
quantile_cont: idx = p*(N-1), interpolate between neighbours), then
the merge property against numpy's own percentile on random data,
then the radix-selection fallback on synthetic data — it never
triggers on real TLC fares, so synthetic data is the only way to
test it, exactly as the design requires.
"""
import numpy as np

from engine import kernels, percentile


def _pct(values, p):
    keys, counts = percentile.chunk_sparse_table(np.array(values, dtype=np.float64))
    return percentile.quantile_from_sparse(keys, counts, p)


def test_interpolation_hand_checked():
    # sorted [10, 20, 30, 40]; p50 -> idx 1.5 -> 20 + 0.5*(30-20) = 25
    assert _pct([10, 20, 30, 40], 0.5) == 25.0
    assert _pct([10, 20, 30, 40], 0.0) == 10.0
    assert _pct([10, 20, 30, 40], 1.0) == 40.0
    assert _pct([7.5], 0.9) == 7.5
    assert _pct([10, 20], 0.5) == 15.0


def test_negatives_and_huge_outlier_are_exact():
    # the $335k-style outlier and negative fares ride the sparse path
    assert _pct([-5, 0, 10, 1_000_000], 0.5) == 5.0
    assert _pct([-5, 0, 10, 1_000_000], 1.0) == 1_000_000.0


def test_non_cent_fares_kept_exactly():
    assert _pct([12.345, 12.345, 12.355], 0.5) == 12.345


def test_chunked_merge_matches_numpy_percentile():
    rng = np.random.default_rng(7)
    fares = np.round(rng.uniform(-20, 1500, size=50_000), 2)
    fares[::997] = 335_544.44  # sprinkle the real 2024 outlier shape
    table = (np.empty(0), np.empty(0, dtype=np.int64))
    for start in range(0, fares.size, 8_191):  # uneven chunks on purpose
        table = percentile.merge_sparse(
            table, percentile.chunk_sparse_table(fares[start : start + 8_191])
        )
    for p in (0.5, 0.9, 0.99):
        ours = percentile.quantile_from_sparse(table[0], table[1], p)
        theirs = float(np.percentile(fares, p * 100))  # linear == quantile_cont
        assert np.isclose(ours, theirs, rtol=1e-9, atol=1e-9), (p, ours, theirs)


def test_radix_select_synthetic_uniform():
    # Mandatory synthetic test for the fallback: uniform data shaped
    # like fares, converted to int64 cents, negatives included.
    rng = np.random.default_rng(123)
    for size in (1, 10, 5_000):
        cents = np.round(rng.uniform(-500, 200_000, size=size) * 100).astype(np.int64)
        for k in {0, size // 2, size - 1}:
            expected = int(np.partition(cents, k)[k])
            assert kernels.select_kth_int64(cents, k) == expected


def test_radix_select_full_range_int64():
    rng = np.random.default_rng(99)
    values = rng.integers(np.iinfo(np.int64).min, np.iinfo(np.int64).max, size=2_000)
    for k in (0, 999, 1999):
        assert kernels.select_kth_int64(values, k) == int(np.partition(values, k)[k])
