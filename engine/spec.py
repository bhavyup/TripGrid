"""What a question IS, as data — the recipe every TripGrid 2.0
question is made of, preset or hand-built in the builder.

A spec names:
  range      the months to read, "YYYY-MM" .. "YYYY-MM" inclusive
             (or "all" — resolved against the partition index)
  measures   what to compute per group (trips, avg_fare, p50_fare…)
  dimensions what to group by (month, pu_zone, hour…); the values
             are packed into ONE integer key per trip, mixed-radix
  filters    which trips count at all (boroughs, hours, sane…)
  top_k      keep only the K biggest groups, by the first measure
  sort       "key" (group order) or "measure" (biggest first)

Nothing in this module touches data. Validation lives here, and so
does the CARDINALITY GATE: before a single row is read, the recipe
is priced — buckets = the product of the dimension cardinalities —
and refused if the counting array would endanger the 2 GB ceiling.
Percentile measures get a stricter gate of their own: they keep a
fare table per group, not a counter, so their group budget is far
smaller. A refusal names the combination and the budget, in plain
words, so the builder UI can show exactly what to drop.

Definitions that are part of a question's MEANING live here too,
so the engine and the DuckDB reference can never drift apart:
  SANE trips — duration 60..14400 s AND distance 0.1..200 miles.
  avg_speed and avg_duration are computed over sane trips only
  (a 6-day "trip" is a data error, not a duration), and avg_speed
  is total sane distance / total sane time (the traffic
  engineer's space-mean speed), never a mean of per-trip ratios.
"""
from __future__ import annotations

import re

# ------------------------------------------------------------------
# The sanity rule (shared by measures, the sane_only filter, and
# every DuckDB reference query — one definition, three readers).
SANE_DUR_MIN_S = 60
SANE_DUR_MAX_S = 14_400  # 4 hours
SANE_DIST_MIN_MI = 0.1
SANE_DIST_MAX_MI = 200.0

ZONE_COUNT = 266  # location ids 0..265 (264 Unknown, 265 Outside)
PAYMENT_COUNT = 8  # payment_type values 0..6 in practice
BOROUGH_COUNT = 8  # Bronx, Brooklyn, EWR, Manhattan, Queens,
#                    Staten Island, Unknown, N/A

MAX_BUCKETS = 500_000  # counting-array budget for ordinary measures
MAX_PCTL_GROUPS = 128  # fare-table budget for percentile measures

_YM_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")


class SpecError(ValueError):
    """A recipe that is malformed or over budget. The message is
    written for the user, not the log."""


# name -> gate cardinality; None means "depends on the range"
DIMENSIONS: dict[str, int | None] = {
    "year": None,  # years inside the range
    "month": None,  # year-months inside the range
    "month_of_year": 12,
    "pu_borough": BOROUGH_COUNT,
    "do_borough": BOROUGH_COUNT,
    "pu_zone": ZONE_COUNT,
    "do_zone": ZONE_COUNT,
    "route": ZONE_COUNT * ZONE_COUNT,
    "hour": 24,
    "weekday": 7,
    "hour_weekday": 24 * 7,
    "payment_type": PAYMENT_COUNT,
    "airport": 2,
}

# Columns each dimension needs read from the parquet files.
DIM_COLUMNS: dict[str, tuple[str, ...]] = {
    "year": (),
    "month": (),
    "month_of_year": (),
    "pu_borough": (),  # the partition itself — free
    "do_borough": ("do_location_id",),
    "pu_zone": ("pu_location_id",),
    "do_zone": ("do_location_id",),
    "route": ("pu_location_id", "do_location_id"),
    "hour": ("pickup_datetime",),
    "weekday": ("pickup_datetime",),
    "hour_weekday": ("pickup_datetime",),
    "payment_type": ("payment_type",),
    "airport": ("pu_location_id",),
}

MEASURES = {
    "trips",
    "sum_fare", "avg_fare",
    "sum_tip", "avg_tip", "tip_pct", "tip_pct_card",
    "sum_total",
    "sum_distance", "avg_distance",
    "sum_passengers", "avg_passengers",
    "avg_duration", "avg_speed",
    "p50_fare", "p90_fare", "p99_fare",
}

PERCENTILE_MEASURES = {"p50_fare", "p90_fare", "p99_fare"}

# Columns each measure needs.
MEASURE_COLUMNS: dict[str, tuple[str, ...]] = {
    "trips": (),
    "sum_fare": ("fare_amount",),
    "avg_fare": ("fare_amount",),
    "sum_tip": ("tip_amount",),
    "avg_tip": ("tip_amount",),
    "tip_pct": ("tip_amount", "fare_amount"),
    "tip_pct_card": ("tip_amount", "fare_amount", "payment_type"),
    "sum_total": ("total_amount",),
    "sum_distance": ("trip_distance",),
    "avg_distance": ("trip_distance",),
    "sum_passengers": ("passenger_count",),
    "avg_passengers": ("passenger_count",),
    "avg_duration": ("pickup_datetime", "dropoff_datetime", "trip_distance"),
    "avg_speed": ("pickup_datetime", "dropoff_datetime", "trip_distance"),
    "p50_fare": ("fare_amount",),
    "p90_fare": ("fare_amount",),
    "p99_fare": ("fare_amount",),
}

# Columns each filter needs (borough filters prune via the index).
FILTER_COLUMNS: dict[str, tuple[str, ...]] = {
    "pu_boroughs": (),
    "do_boroughs": ("do_location_id",),
    "pu_zones": ("pu_location_id",),
    "do_zones": ("do_location_id",),
    "hours": ("pickup_datetime",),
    "weekdays": ("pickup_datetime",),
    "payment_types": ("payment_type",),
    "airport": ("pu_location_id",),
    "sane_only": ("pickup_datetime", "dropoff_datetime", "trip_distance"),
    "fare_min": ("fare_amount",),
    "fare_max": ("fare_amount",),
    "dist_min": ("trip_distance",),
    "dist_max": ("trip_distance",),
    "dur_min": ("pickup_datetime", "dropoff_datetime"),
    "dur_max": ("pickup_datetime", "dropoff_datetime"),
    "min_passengers": ("passenger_count",),
}

FILTERS = set(FILTER_COLUMNS)


def months_between(start: str, end: str) -> list[str]:
    """Every "YYYY-MM" from start to end inclusive, in order."""
    if not _YM_RE.match(start) or not _YM_RE.match(end):
        raise SpecError(f"range bounds must look like YYYY-MM, got {start!r}..{end!r}")
    y0, m0 = int(start[:4]), int(start[5:7])
    y1, m1 = int(end[:4]), int(end[5:7])
    if (y1, m1) < (y0, m0):
        raise SpecError(f"range end {end} is before its start {start}")
    out = []
    y, m = y0, m0
    while (y, m) <= (y1, m1):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


class Spec:
    """A validated recipe. Build with Spec.from_dict; the gate runs
    inside from_dict once the range is concrete."""

    def __init__(self, raw: dict, index_months: list[str] | None = None):
        raw = dict(raw or {})
        self.measures: list[str] = list(raw.get("measures") or [])
        self.dimensions: list[str] = list(raw.get("dimensions") or [])
        self.filters: dict = dict(raw.get("filters") or {})
        self.top_k: int | None = raw.get("top_k")
        self.sort: str = raw.get("sort") or ("measure" if self.top_k else "key")

        rng = raw.get("range") or "all"
        if rng == "all":
            if not index_months:
                raise SpecError('range "all" needs the partition index to resolve')
            self.range = (index_months[0], index_months[-1])
        elif isinstance(rng, (list, tuple)) and len(rng) == 2:
            self.range = (str(rng[0]), str(rng[1]))
        else:
            raise SpecError(f"range must be 'all' or [start, end], got {rng!r}")
        self.months = months_between(*self.range)
        self._validate()
        self.buckets = self._gate()

    # ----------------------------------------------------------
    def _validate(self) -> None:
        if not self.measures:
            raise SpecError("a question needs at least one measure")
        for m in self.measures:
            if m not in MEASURES:
                raise SpecError(
                    f"unknown measure {m!r}; valid: {', '.join(sorted(MEASURES))}"
                )
        if len(set(self.dimensions)) != len(self.dimensions):
            raise SpecError(f"duplicate dimensions: {self.dimensions}")
        for d in self.dimensions:
            if d not in DIMENSIONS:
                raise SpecError(
                    f"unknown dimension {d!r}; valid: {', '.join(sorted(DIMENSIONS))}"
                )
        for f in self.filters:
            if f not in FILTERS:
                raise SpecError(
                    f"unknown filter {f!r}; valid: {', '.join(sorted(FILTERS))}"
                )
        if self.top_k is not None and (
            not isinstance(self.top_k, int) or self.top_k <= 0
        ):
            raise SpecError(f"top_k must be a positive integer, got {self.top_k!r}")
        if self.sort not in ("key", "measure"):
            raise SpecError(f"sort must be 'key' or 'measure', got {self.sort!r}")
        hrs = self.filters.get("hours")
        if hrs is not None and any(not (0 <= int(h) <= 23) for h in hrs):
            raise SpecError(f"hours must be within 0..23, got {hrs}")
        wds = self.filters.get("weekdays")
        if wds is not None and any(not (0 <= int(w) <= 6) for w in wds):
            raise SpecError(f"weekdays must be within 0..6 (Mon=0), got {wds}")

    def cardinality(self, dim: str) -> int:
        if dim == "year":
            return len({m[:4] for m in self.months})
        if dim == "month":
            return len(self.months)
        return int(DIMENSIONS[dim])

    def _gate(self) -> int:
        """Price the recipe. Returns the bucket count; raises
        SpecError with the full breakdown when over budget."""
        buckets = 1
        parts = []
        for d in self.dimensions:
            c = self.cardinality(d)
            buckets *= c
            parts.append(f"{d}({c})")
        shape = " × ".join(parts) if parts else "no grouping"
        if self.percentile_measures:
            if buckets > MAX_PCTL_GROUPS:
                raise SpecError(
                    f"percentile questions keep a fare table per group: "
                    f"{shape} = {buckets:,} groups is over the "
                    f"{MAX_PCTL_GROUPS:,}-group budget. Group by fewer, "
                    f"wider things (borough, month, payment type)."
                )
        elif buckets > MAX_BUCKETS:
            raise SpecError(
                f"{shape} = {buckets:,} buckets is over the "
                f"{MAX_BUCKETS:,}-bucket working-memory budget. "
                f"Drop a grouping or narrow the range."
            )
        return buckets

    # ----------------------------------------------------------
    @property
    def percentile_measures(self) -> list[str]:
        return [m for m in self.measures if m in PERCENTILE_MEASURES]

    def needed_columns(self) -> list[str]:
        cols: set[str] = set()
        for d in self.dimensions:
            cols.update(DIM_COLUMNS[d])
        for m in self.measures:
            cols.update(MEASURE_COLUMNS[m])
        for f in self.filters:
            cols.update(FILTER_COLUMNS[f])
        return sorted(cols)

    def gate_report(self) -> dict:
        return {
            "buckets": self.buckets,
            "budget": MAX_PCTL_GROUPS if self.percentile_measures else MAX_BUCKETS,
            "shape": " × ".join(
                f"{d}({self.cardinality(d)})" for d in self.dimensions
            )
            or "no grouping",
        }

    def to_dict(self) -> dict:
        return {
            "range": list(self.range),
            "measures": self.measures,
            "dimensions": self.dimensions,
            "filters": self.filters,
            "top_k": self.top_k,
            "sort": self.sort,
        }


# ------------------------------------------------------------------
# The eleven preset questions, in the agreed real-life relevancy
# order. Every preset is an ordinary recipe — the builder can open
# any of them as a starting point, and the gate prices them like
# any other question. Ranges are defaults; the console lets the
# user narrow or widen them.
PRESETS: dict[str, dict] = {
    "congestion_verdict": {
        "title": "Did congestion pricing work?",
        "note": "Manhattan pickups, month by month, across the "
        "January 2025 start of the congestion charge.",
        "spec": {
            "range": ["2024-01", "2026-12"],
            "measures": ["trips", "avg_fare"],
            "dimensions": ["month"],
            "filters": {"pu_boroughs": ["Manhattan"]},
        },
    },
    "covid_recovery": {
        "title": "The COVID collapse and recovery",
        "note": "Monthly trips from the last normal year through "
        "the collapse and the climb back.",
        "spec": {
            "range": ["2019-01", "2022-12"],
            "measures": ["trips"],
            "dimensions": ["month"],
        },
    },
    "city_speed": {
        "title": "How fast is the city?",
        "note": "Average trip speed by hour of day, over sane "
        "trips only — the traffic pulse of New York.",
        "spec": {
            "range": "all",
            "measures": ["avg_speed", "trips"],
            "dimensions": ["hour"],
        },
    },
    "demand_clock": {
        "title": "The demand clock",
        "note": "Trips by hour × weekday — when the city moves.",
        "spec": {
            "range": "all",
            "measures": ["trips"],
            "dimensions": ["hour_weekday"],
        },
    },
    "busiest_routes": {
        "title": "Busiest routes",
        "note": "The twenty pickup → drop-off zone pairs the "
        "city flows along most.",
        "spec": {
            "range": "all",
            "measures": ["trips"],
            "dimensions": ["route"],
            "top_k": 20,
        },
    },
    "tip_behaviour": {
        "title": "Tip behaviour",
        "note": "Tip % by pickup borough. Card trips only — cash "
        "tips are never recorded, and the number says so.",
        "spec": {
            "range": "all",
            "measures": ["tip_pct_card", "avg_fare", "trips"],
            "dimensions": ["pu_borough"],
        },
    },
    "airport_payments": {
        "title": "Airport pickups — fare & tip by payment",
        "note": "The original Q2: rides that start at an airport, "
        "broken down by how they were paid for.",
        "spec": {
            "range": "all",
            "measures": ["trips", "avg_fare", "tip_pct"],
            "dimensions": ["payment_type"],
            "filters": {"airport": "any"},
        },
    },
    "zone_month_trips": {
        "title": "Trips per pickup zone, per month",
        "note": "The original Q1 — the counting question the "
        "engine was first proven on.",
        "spec": {
            "range": "all",
            "measures": ["trips"],
            "dimensions": ["month", "pu_zone"],
        },
    },
    "friday_manhattan": {
        "title": "Friday-evening Manhattan — top 20 drop-offs",
        "note": "The original Q3: rides that start in Manhattan "
        "on a Friday between 17:00 and 23:59.",
        "spec": {
            "range": "all",
            "measures": ["trips"],
            "dimensions": ["do_zone"],
            "filters": {
                "pu_boroughs": ["Manhattan"],
                "weekdays": [4],
                "hours": [17, 18, 19, 20, 21, 22, 23],
            },
            "top_k": 20,
        },
    },
    "fare_percentiles": {
        "title": "Exact fare percentiles per borough",
        "note": "The original Q4 — exact p50 / p90 / p99 from "
        "sparse fare tables, nothing sorted, nothing estimated.",
        "spec": {
            "range": "all",
            "measures": ["p50_fare", "p90_fare", "p99_fare", "trips"],
            "dimensions": ["pu_borough"],
        },
    },
    "junk_audit": {
        "title": "The junk audit",
        "note": "How much of the official record is impossible: "
        "paid trips that went nowhere, negative fares, trips "
        "that lasted for days. Four small counts, one verdict.",
        "kind": "audit",
        "parts": [
            {
                "name": "paid_but_no_distance",
                "label": "Paid, but went nowhere (distance ≤ 0, fare > 0)",
                "spec": {
                    "range": "all",
                    "measures": ["trips", "sum_fare"],
                    "dimensions": [],
                    "filters": {"dist_max": 0.0, "fare_min": 0.01},
                },
            },
            {
                "name": "negative_fare",
                "label": "Negative fares",
                "spec": {
                    "range": "all",
                    "measures": ["trips", "sum_fare"],
                    "dimensions": [],
                    "filters": {"fare_max": -0.01},
                },
            },
            {
                "name": "marathon_trips",
                "label": "Trips longer than 4 hours",
                "spec": {
                    "range": "all",
                    "measures": ["trips"],
                    "dimensions": [],
                    "filters": {"dur_min": SANE_DUR_MAX_S + 1},
                },
            },
            {
                "name": "negative_duration",
                "label": "Trips that end before they start",
                "spec": {
                    "range": "all",
                    "measures": ["trips"],
                    "dimensions": [],
                    "filters": {"dur_max": -1},
                },
            },
        ],
    },
}
