"""The fused weekday+hour kernel must agree with the two separate
kernels everywhere — it is a speed rewrite, not a new definition.
"""
import numpy as np

from engine import kernels


def test_weekday_and_hour_known_dates():
    dt = np.array(
        ["2024-01-01T00:05", "2024-01-05T17:30", "2024-01-07T23:59"],
        dtype="datetime64[m]",
    ).astype("datetime64[us]")
    weekday, hour = kernels.weekday_and_hour(dt)
    assert weekday.tolist() == [0, 4, 6]  # Mon, Fri, Sun
    assert hour.tolist() == [0, 17, 23]


def test_weekday_and_hour_matches_separate_kernels():
    rng = np.random.default_rng(3)
    base = np.datetime64("2024-01-01T00:00", "m")
    dt = (base + rng.integers(0, 366 * 24 * 60, size=20_000).astype("timedelta64[m]")).astype(
        "datetime64[us]"
    )
    weekday, hour = kernels.weekday_and_hour(dt)
    assert np.array_equal(weekday, kernels.weekday_of(dt))
    assert np.array_equal(hour, kernels.hour_of(dt))
