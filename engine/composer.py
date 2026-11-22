"""The composer: runs a spec (engine/spec.py) over the partitioned
dataset and returns grouped rows.

One generic scan replaces what would otherwise be a hand-written
function per question. For each partition file the planner selects,
a worker streams batches (never whole files), applies the spec's
filters as a mask, packs the surviving trips' dimension values
into a single mixed-radix integer key, and accumulates with
np.bincount — counts and weighted sums in one linear pass per
batch, exactly like the hand-written kernels. Partials merge by
addition. Percentile measures take the Q4 path instead: a sparse
fare table per group, merged with engine.percentile.

Peak memory stays bounded because the gate (engine.spec) has
already priced the recipe: the accumulators are sized by the
bucket count, never by the number of trips scanned.
"""
from __future__ import annotations

import numpy as np
import pyarrow.parquet as pq

from engine import kernels, percentile, planner, zones
from engine.executor import (
    DEFAULT_CEILING_MB,
    DEFAULT_WORKERS,
    POOL_BATCH_ROWS,
    REPO_ROOT,
    _run_pool,
)
from engine.spec import (
    PRESETS,
    SANE_DIST_MAX_MI,
    SANE_DIST_MIN_MI,
    SANE_DUR_MAX_S,
    SANE_DUR_MIN_S,
    Spec,
)

WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
CARD_PAYMENT_TYPE = 1
_EMPTY_SPARSE = (np.empty(0, dtype=np.float64), np.empty(0, dtype=np.int64))


class _Plan:
    """Everything a worker needs, built once per run."""

    def __init__(self, spec: Spec):
        self.spec = spec
        self.columns = spec.needed_columns()
        self.buckets = spec.buckets
        self.cards = [spec.cardinality(d) for d in spec.dimensions]
        self.month_code = {m: i for i, m in enumerate(spec.months)}
        years = sorted({m[:4] for m in spec.months})
        self.year_code = {y: i for i, y in enumerate(years)}
        self.years = [int(y) for y in years]

        zone_map = zones.load_zones()
        self.zone_map = zone_map
        universe = sorted({z["borough"] for z in zone_map.values()} | {"Unknown"})
        self.borough_code = {b: i for i, b in enumerate(universe)}
        self.borough_names = universe
        do_codes = np.full(266, self.borough_code["Unknown"], dtype=np.int64)
        for zid, z in zone_map.items():
            if 0 <= zid < 266:
                do_codes[zid] = self.borough_code[z["borough"]]
        self.do_borough_code = do_codes
        self.airports = np.array(sorted(zones.airport_ids(zone_map)), dtype=np.int64)

        f = spec.filters
        self.f_pu_borough_labels = (
            {b.replace("/", "-") for b in f["pu_boroughs"]}
            if "pu_boroughs" in f
            else None
        )
        self.f_do_borough_codes = (
            np.array(
                sorted(self.borough_code[b] for b in f["do_boroughs"]),
                dtype=np.int64,
            )
            if "do_boroughs" in f
            else None
        )
        self.f_pu_zones = _int_set(f.get("pu_zones"))
        self.f_do_zones = _int_set(f.get("do_zones"))
        self.f_hours = _int_set(f.get("hours"))
        self.f_weekdays = _int_set(f.get("weekdays"))
        self.f_payments = _int_set(f.get("payment_types"))
        af = f.get("airport")
        self.f_airport = (
            None
            if af is None
            else (self.airports if af == "any" else _int_set(af))
        )

        m = set(spec.measures)
        self.need_fare_sum = bool(m & {"sum_fare", "avg_fare", "tip_pct"})
        self.need_tip_sum = bool(m & {"sum_tip", "avg_tip", "tip_pct"})
        self.need_card_sums = "tip_pct_card" in m
        self.need_total_sum = "sum_total" in m
        self.need_dist_sum = bool(m & {"sum_distance", "avg_distance"})
        self.need_pax_sum = bool(m & {"sum_passengers", "avg_passengers"})
        self.need_sane = bool(m & {"avg_duration", "avg_speed"})
        self.has_percentiles = bool(spec.percentile_measures)

    def pu_borough_code_of(self, partition_label: str) -> int:
        if partition_label in self.borough_code:
            return self.borough_code[partition_label]
        restored = partition_label.replace("-", "/")
        if restored in self.borough_code:
            return self.borough_code[restored]
        return self.borough_code["Unknown"]


def _int_set(values) -> np.ndarray | None:
    if values is None:
        return None
    return np.array(sorted(int(v) for v in values), dtype=np.int64)


def _durations_s(cols: dict) -> np.ndarray:
    delta = cols["dropoff_datetime"] - cols["pickup_datetime"]
    return delta.astype("timedelta64[s]").astype(np.int64)


def _sane_mask(cols: dict) -> np.ndarray:
    dur = _durations_s(cols)
    dist = cols["trip_distance"].astype(np.float64)
    return (
        (dur >= SANE_DUR_MIN_S)
        & (dur <= SANE_DUR_MAX_S)
        & (dist >= SANE_DIST_MIN_MI)
        & (dist <= SANE_DIST_MAX_MI)
    )


def _batch_mask(cols: dict, plan: _Plan, derived: dict) -> np.ndarray | None:
    """The filter mask for one batch, or None when nothing is
    filtered out. Derived weekday/hour values are cached in
    `derived` — the key packing below needs them too."""
    f = plan.spec.filters
    mask: np.ndarray | None = None

    def keep(m: np.ndarray):
        nonlocal mask
        mask = m if mask is None else (mask & m)

    if plan.f_do_borough_codes is not None:
        keep(np.isin(plan.do_borough_code[cols["do_location_id"]], plan.f_do_borough_codes))
    if plan.f_pu_zones is not None:
        keep(np.isin(cols["pu_location_id"], plan.f_pu_zones))
    if plan.f_do_zones is not None:
        keep(np.isin(cols["do_location_id"], plan.f_do_zones))
    if plan.f_hours is not None or plan.f_weekdays is not None:
        wd, hr = kernels.weekday_and_hour(cols["pickup_datetime"])
        derived["weekday"], derived["hour"] = wd, hr
        if plan.f_hours is not None:
            keep(np.isin(hr, plan.f_hours))
        if plan.f_weekdays is not None:
            keep(np.isin(wd, plan.f_weekdays))
    if plan.f_payments is not None:
        keep(np.isin(cols["payment_type"], plan.f_payments))
    if plan.f_airport is not None:
        keep(np.isin(cols["pu_location_id"], plan.f_airport))
    if f.get("sane_only"):
        keep(_sane_mask(cols))
    if "fare_min" in f:
        keep(cols["fare_amount"] >= float(f["fare_min"]))
    if "fare_max" in f:
        keep(cols["fare_amount"] <= float(f["fare_max"]))
    if "dist_min" in f:
        keep(cols["trip_distance"] >= float(f["dist_min"]))
    if "dist_max" in f:
        keep(cols["trip_distance"] <= float(f["dist_max"]))
    if "dur_min" in f or "dur_max" in f:
        dur = _durations_s(cols)
        if "dur_min" in f:
            keep(dur >= int(f["dur_min"]))
        if "dur_max" in f:
            keep(dur <= int(f["dur_max"]))
    if "min_passengers" in f:
        keep(cols["passenger_count"] >= int(f["min_passengers"]))
    return mask


def _dim_codes(dim: str, cols: dict, derived: dict, plan: _Plan,
               month_str: str, pu_borough_label: str, n: int) -> np.ndarray:
    """One dimension's codes for the (already masked) rows."""
    spec = plan.spec
    if dim == "year":
        return np.full(n, plan.year_code[month_str[:4]], dtype=np.int64)
    if dim == "month":
        return np.full(n, plan.month_code[month_str], dtype=np.int64)
    if dim == "month_of_year":
        return np.full(n, int(month_str[5:7]) - 1, dtype=np.int64)
    if dim == "pu_borough":
        return np.full(n, plan.pu_borough_code_of(pu_borough_label), dtype=np.int64)
    if dim == "pu_zone":
        v = derived["pu"]
        _check_range(v, 266, "pu_location_id")
        return v
    if dim == "do_zone":
        v = derived["do"]
        _check_range(v, 266, "do_location_id")
        return v
    if dim == "do_borough":
        return plan.do_borough_code[derived["do"]]
    if dim == "route":
        pu, do = derived["pu"], derived["do"]
        _check_range(pu, 266, "pu_location_id")
        _check_range(do, 266, "do_location_id")
        return pu * 266 + do
    if dim == "hour":
        return derived["hour"]
    if dim == "weekday":
        return derived["weekday"]
    if dim == "hour_weekday":
        return derived["hour"] * 7 + derived["weekday"]
    if dim == "payment_type":
        v = cols["payment_type"].astype(np.int64)
        _check_range(v, 8, "payment_type")
        return v
    if dim == "airport":
        return np.isin(derived["pu"], plan.airports).astype(np.int64)
    raise AssertionError(f"unhandled dimension {dim}")  # spec validated


def _check_range(values: np.ndarray, limit: int, name: str) -> None:
    if values.size and (values.min() < 0 or values.max() >= limit):
        raise ValueError(f"{name} out of range [0, {limit}): "
                         f"{values.min()}..{values.max()}")


def _partial(plan: _Plan, job) -> tuple[dict, dict, int]:
    path, month_str, pu_borough_label = job
    spec = plan.spec
    buckets = plan.buckets
    acc = {"count": np.zeros(buckets, dtype=np.int64)}
    if plan.need_fare_sum:
        acc["fare_sum"] = np.zeros(buckets)
    if plan.need_tip_sum:
        acc["tip_sum"] = np.zeros(buckets)
    if plan.need_card_sums:
        acc["card_fare_sum"] = np.zeros(buckets)
        acc["card_tip_sum"] = np.zeros(buckets)
    if plan.need_total_sum:
        acc["total_sum"] = np.zeros(buckets)
    if plan.need_dist_sum:
        acc["dist_sum"] = np.zeros(buckets)
    if plan.need_pax_sum:
        acc["pax_sum"] = np.zeros(buckets)
    if plan.need_sane:
        acc["sane_count"] = np.zeros(buckets, dtype=np.int64)
        acc["sane_dist_sum"] = np.zeros(buckets)
        acc["sane_dur_sum"] = np.zeros(buckets)
    sparse: dict[int, tuple[np.ndarray, np.ndarray]] = {}
    scanned = 0

    pf = pq.ParquetFile(path)
    # A pure-count recipe needs no columns at all; iter_batches
    # still needs one to report row counts, so read the cheapest
    # stand-in (always present in the canonical schema).
    read_columns = plan.columns or ["pu_location_id"]
    for batch in pf.iter_batches(batch_size=POOL_BATCH_ROWS, columns=read_columns):
        cols = {
            name: batch.column(i).to_numpy(zero_copy_only=False)
            for i, name in enumerate(plan.columns)
        }
        scanned += batch.num_rows
        derived: dict = {}
        mask = _batch_mask(cols, plan, derived)
        if mask is not None:
            if not mask.any():
                continue
            idx = np.nonzero(mask)[0]
            cols = {k: v[idx] for k, v in cols.items()}
            derived = {k: v[idx] for k, v in derived.items()}
        n = len(next(iter(cols.values()))) if cols else batch.num_rows
        if "pu_location_id" in cols:
            derived["pu"] = cols["pu_location_id"].astype(np.int64)
        if "do_location_id" in cols:
            derived["do"] = cols["do_location_id"].astype(np.int64)
        if ("hour" in spec.dimensions or "weekday" in spec.dimensions
                or "hour_weekday" in spec.dimensions) and "hour" not in derived:
            wd, hr = kernels.weekday_and_hour(cols["pickup_datetime"])
            derived["weekday"], derived["hour"] = wd, hr

        key = np.zeros(n, dtype=np.int64)
        for dim, card in zip(spec.dimensions, plan.cards):
            codes = _dim_codes(dim, cols, derived, plan, month_str,
                               pu_borough_label, n)
            key = key * card + codes

        acc["count"] += np.bincount(key, minlength=buckets)
        if plan.need_fare_sum:
            acc["fare_sum"] += np.bincount(
                key, weights=cols["fare_amount"].astype(np.float64),
                minlength=buckets)
        if plan.need_tip_sum:
            acc["tip_sum"] += np.bincount(
                key, weights=cols["tip_amount"].astype(np.float64),
                minlength=buckets)
        if plan.need_card_sums:
            card = cols["payment_type"] == CARD_PAYMENT_TYPE
            if card.any():
                acc["card_fare_sum"] += np.bincount(
                    key[card],
                    weights=cols["fare_amount"][card].astype(np.float64),
                    minlength=buckets)
                acc["card_tip_sum"] += np.bincount(
                    key[card],
                    weights=cols["tip_amount"][card].astype(np.float64),
                    minlength=buckets)
        if plan.need_total_sum:
            acc["total_sum"] += np.bincount(
                key, weights=cols["total_amount"].astype(np.float64),
                minlength=buckets)
        if plan.need_dist_sum:
            acc["dist_sum"] += np.bincount(
                key, weights=cols["trip_distance"].astype(np.float64),
                minlength=buckets)
        if plan.need_pax_sum:
            acc["pax_sum"] += np.bincount(
                key, weights=cols["passenger_count"].astype(np.float64),
                minlength=buckets)
        if plan.need_sane:
            sane = _sane_mask(cols)
            if sane.any():
                skey = key[sane]
                acc["sane_count"] += np.bincount(skey, minlength=buckets)
                acc["sane_dist_sum"] += np.bincount(
                    skey,
                    weights=cols["trip_distance"][sane].astype(np.float64),
                    minlength=buckets)
                acc["sane_dur_sum"] += np.bincount(
                    skey,
                    weights=_durations_s(cols)[sane].astype(np.float64),
                    minlength=buckets)
        if plan.has_percentiles:
            fares = cols["fare_amount"].astype(np.float64)
            ukeys, inv = np.unique(key, return_inverse=True)
            for gi, g in enumerate(ukeys):
                t = percentile.chunk_sparse_table(fares[inv == gi])
                sparse[int(g)] = percentile.merge_sparse(
                    sparse.get(int(g), _EMPTY_SPARSE), t)
    return acc, sparse, scanned


def _decode_row(bucket: int, acc: dict, sparse: dict, plan: _Plan) -> dict:
    spec = plan.spec
    row: dict = {}
    codes = []
    rest = bucket
    for card in reversed(plan.cards):
        codes.append(rest % card)
        rest //= card
    codes.reverse()
    for dim, code in zip(spec.dimensions, codes):
        code = int(code)
        if dim == "year":
            row["year"] = plan.years[code]
        elif dim == "month":
            row["month"] = spec.months[code]
        elif dim == "month_of_year":
            row["month_of_year"] = code + 1
        elif dim == "pu_borough":
            row["pu_borough"] = plan.borough_names[code]
        elif dim == "do_borough":
            row["do_borough"] = plan.borough_names[code]
        elif dim == "pu_zone":
            z = plan.zone_map.get(code, {})
            row["pu_zone"] = code
            row["pu_zone_name"] = z.get("zone")
            row["pu_borough"] = z.get("borough")
        elif dim == "do_zone":
            z = plan.zone_map.get(code, {})
            row["do_zone"] = code
            row["do_zone_name"] = z.get("zone")
            row["do_borough"] = z.get("borough")
        elif dim == "route":
            pu, do = divmod(code, 266)
            pz = plan.zone_map.get(pu, {})
            dz = plan.zone_map.get(do, {})
            row["pu_zone"], row["pu_zone_name"] = pu, pz.get("zone")
            row["do_zone"], row["do_zone_name"] = do, dz.get("zone")
        elif dim == "hour":
            row["hour"] = code
        elif dim == "weekday":
            row["weekday"] = code
            row["weekday_name"] = WEEKDAY_NAMES[code]
        elif dim == "hour_weekday":
            hour, wd = divmod(code, 7)
            row["hour"] = hour
            row["weekday"] = wd
            row["weekday_name"] = WEEKDAY_NAMES[wd]
        elif dim == "payment_type":
            row["payment_type"] = code
        elif dim == "airport":
            row["airport"] = bool(code)

    count = int(acc["count"][bucket])
    get = lambda name: float(acc[name][bucket]) if name in acc else 0.0
    for m in spec.measures:
        if m == "trips":
            row["trips"] = count
        elif m == "sum_fare":
            row["sum_fare"] = get("fare_sum")
        elif m == "avg_fare":
            row["avg_fare"] = get("fare_sum") / count if count else None
        elif m == "sum_tip":
            row["sum_tip"] = get("tip_sum")
        elif m == "avg_tip":
            row["avg_tip"] = get("tip_sum") / count if count else None
        elif m == "tip_pct":
            fs = get("fare_sum")
            row["tip_pct"] = 100.0 * get("tip_sum") / fs if fs > 0 else 0.0
        elif m == "tip_pct_card":
            fs = get("card_fare_sum")
            row["tip_pct_card"] = (
                100.0 * get("card_tip_sum") / fs if fs > 0 else 0.0
            )
        elif m == "sum_total":
            row["sum_total"] = get("total_sum")
        elif m == "sum_distance":
            row["sum_distance"] = get("dist_sum")
        elif m == "avg_distance":
            row["avg_distance"] = get("dist_sum") / count if count else None
        elif m == "sum_passengers":
            row["sum_passengers"] = get("pax_sum")
        elif m == "avg_passengers":
            row["avg_passengers"] = get("pax_sum") / count if count else None
        elif m == "avg_duration":
            sc = int(acc["sane_count"][bucket]) if "sane_count" in acc else 0
            row["avg_duration"] = get("sane_dur_sum") / sc if sc else None
        elif m == "avg_speed":
            sd = get("sane_dur_sum")
            row["avg_speed"] = (
                get("sane_dist_sum") / (sd / 3600.0) if sd > 0 else None
            )
        elif m in ("p50_fare", "p90_fare", "p99_fare"):
            table = sparse.get(bucket)
            if table is None:
                row[m] = None
            else:
                qs = percentile.percentiles_from_sparse(table[0], table[1])
                row[m] = qs[{ "p50_fare": 0.5, "p90_fare": 0.9,
                              "p99_fare": 0.99 }[m]]
    if "sane_count" in acc and ("avg_speed" in spec.measures
                                or "avg_duration" in spec.measures):
        row["sane_trips"] = int(acc["sane_count"][bucket])
    return row


def run_spec(spec_dict: dict, workers: int = DEFAULT_WORKERS,
             ceiling_mb: float = DEFAULT_CEILING_MB,
             pool=None, progress=None) -> tuple[list[dict], dict]:
    """Run one recipe. Returns (rows, stats) — stats carry the
    planner numbers, the rows actually scanned, wall time, peak
    RSS, the gate report, and the spec itself."""
    partitions = planner.load_index()
    index_months = sorted({p["month"] for p in partitions})
    spec = Spec(spec_dict, index_months=index_months)
    plan = _Plan(spec)

    months = set(spec.months)
    boroughs = plan.f_pu_borough_labels
    selected, prune = planner.select_partitions(
        partitions, months=months, boroughs=boroughs)
    if not selected:
        stats = dict(prune)
        stats.update({
            "rows_scanned": 0, "wall_s": 0.0, "peak_rss_mb": 0.0,
            "spec": spec.to_dict(), "gate": spec.gate_report(),
        })
        return [], stats

    jobs = [
        (str(REPO_ROOT / p["path"]), p["month"], p["borough"])
        for p in selected
    ]
    partials, run_stats = _run_pool(
        lambda job: _partial(plan, job), jobs, workers, ceiling_mb,
        est_rows=prune["rows_selected"], pool=pool, progress=progress)

    merged: dict = {}
    sparse: dict = {}
    scanned = 0
    for acc, sp, sc in partials:
        scanned += sc
        for name, arr in acc.items():
            merged[name] = arr if name not in merged else merged[name] + arr
        for g, table in sp.items():
            sparse[g] = percentile.merge_sparse(sparse.get(g, _EMPTY_SPARSE), table)

    present = np.nonzero(merged["count"] > 0)[0]
    rows = [_decode_row(int(b), merged, sparse, plan) for b in present]
    if spec.sort == "measure" or spec.top_k:
        first = spec.measures[0]
        rows.sort(
            key=lambda r: (
                r.get(first) if r.get(first) is not None else float("-inf")
            ),
            reverse=True,
        )
    if spec.top_k:
        rows = rows[: spec.top_k]

    stats = dict(prune)
    stats.update(run_stats)
    stats.update({
        "rows_scanned": scanned,
        "spec": spec.to_dict(),
        "gate": spec.gate_report(),
    })
    return rows, stats


def run_preset(name: str, range_override=None,
               workers: int = DEFAULT_WORKERS,
               ceiling_mb: float = DEFAULT_CEILING_MB,
               pool=None, progress=None) -> tuple[list[dict], dict]:
    """Run one of engine.spec.PRESETS by name. Audit presets run
    their parts and return one labelled row per part."""
    if name not in PRESETS:
        raise KeyError(f"unknown preset {name!r}; "
                       f"valid: {', '.join(sorted(PRESETS))}")
    preset = PRESETS[name]
    if preset.get("kind") == "audit":
        rows: list[dict] = []
        total = {"rows_scanned": 0, "wall_s": 0.0, "peak_rss_mb": 0.0}
        for part in preset["parts"]:
            part_rows, part_stats = run_spec(
                part["spec"], workers=workers, ceiling_mb=ceiling_mb,
                pool=pool, progress=progress)
            row = {"part": part["name"], "label": part["label"]}
            if part_rows:
                row.update(part_rows[0])
            else:
                row["trips"] = 0
            rows.append(row)
            total["rows_scanned"] += part_stats["rows_scanned"]
            total["wall_s"] += part_stats["wall_s"]
            total["peak_rss_mb"] = max(total["peak_rss_mb"],
                                       part_stats["peak_rss_mb"])
        stats = dict(total)
        stats.update({"preset": name, "kind": "audit",
                      "title": preset["title"]})
        return rows, stats

    spec = dict(preset["spec"])
    if range_override is not None:
        spec["range"] = range_override
    rows, stats = run_spec(spec, workers=workers, ceiling_mb=ceiling_mb,
                           pool=pool, progress=progress)
    stats.update({"preset": name, "title": preset["title"]})
    return rows, stats
