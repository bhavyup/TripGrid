"""Step 1 gates for the spec engine (engine/spec.py + composer.py).

Two kinds of proof:
1. EQUIVALENCE — the four original questions, re-expressed as
   recipes, reproduce the hand-written engine's answers exactly
   (counts and percentiles) or to float-summation tolerance (means).
2. DUCKDB — the new presets (demand clock, busiest routes, city
   speed, tip behaviour, junk audit) match an independent DuckDB
   reference over the same partitioned parquet. The reference SQL
   reads the v2 stored columns directly (fare_c cents, pickup_off_s
   offsets) — it shares no code with the engine's storage layer —
   and the sane-trip rule is written out in SQL from the same
   definition.

All scans run on the real 2024 partition set (41,169,300 trips).
"""
from pathlib import Path

import duckdb
import numpy as np
import pytest

from engine import executor
from engine.composer import run_preset, run_spec
from engine.spec import Spec, SpecError

ROOT = Path(__file__).resolve().parent.parent
GLOB_2024 = str(ROOT / "data" / "partitioned" / "2024-*" / "*" / "*.parquet")
ZONES_CSV = str(ROOT / "data" / "raw" / "taxi_zone_lookup.csv")
RANGE_2024 = ["2024-01", "2024-12"]


def _duck(sql: str):
    con = duckdb.connect()
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


# ------------------------------------------------------------ gate

def test_gate_rejects_zone_pair_clock():
    with pytest.raises(SpecError) as e:
        Spec({
            "range": RANGE_2024,
            "measures": ["trips"],
            "dimensions": ["pu_zone", "do_zone", "hour", "month"],
        })
    assert "20,377,728" in str(e.value)


def test_gate_rejects_percentile_by_zone():
    with pytest.raises(SpecError) as e:
        Spec({
            "range": RANGE_2024,
            "measures": ["p50_fare"],
            "dimensions": ["pu_zone"],
        })
    assert "128" in str(e.value)


def test_gate_accepts_route_and_clock():
    s = Spec({"range": RANGE_2024, "measures": ["trips"],
              "dimensions": ["route"]})
    assert s.buckets == 266 * 266
    s = Spec({"range": RANGE_2024, "measures": ["trips"],
              "dimensions": ["hour_weekday"]})
    assert s.buckets == 168


def test_unknown_names_rejected():
    for bad in (
        {"measures": ["nope"], "dimensions": [], "range": RANGE_2024},
        {"measures": ["trips"], "dimensions": ["nope"], "range": RANGE_2024},
        {"measures": ["trips"], "dimensions": [],
         "filters": {"nope": 1}, "range": RANGE_2024},
    ):
        with pytest.raises(SpecError):
            Spec(bad)


# ------------------------------------------------- equivalence Q1-4

def test_q1_equivalence_2024():
    counts, _ = executor.run_q1(2024, workers=8)
    rows, stats = run_preset("zone_month_trips", range_override=RANGE_2024)
    assert stats["gate"]["buckets"] == 12 * 266
    seen = 0
    for r in rows:
        m = int(r["month"][5:7]) - 1
        assert int(counts[m][r["pu_zone"]]) == r["trips"]
        seen += 1
    assert seen == int((counts[:, :266] > 0).sum())
    assert int(counts[:, 266:].sum()) == 0


def test_q2_equivalence_2024():
    expected, _ = executor.run_q2(2024, workers=8)
    rows, _ = run_preset("airport_payments", range_override=RANGE_2024)
    by_pay = {r["payment_type"]: r for r in rows}
    assert set(by_pay) == {r["payment_type"] for r in expected}
    for e in expected:
        r = by_pay[e["payment_type"]]
        assert r["trips"] == e["trips"]
        assert r["avg_fare"] == pytest.approx(e["avg_fare"], rel=1e-9)
        assert r["tip_pct"] == pytest.approx(e["tip_pct"], rel=1e-9)


def test_q3_equivalence_2024():
    expected, _ = executor.run_q3(2024, workers=8)
    rows, _ = run_preset("friday_manhattan", range_override=RANGE_2024)
    assert len(rows) == 20
    assert {(r["do_zone"], r["trips"]) for r in rows} == {
        (r["do_location_id"], r["trips"]) for r in expected
    }
    assert rows[0]["trips"] == expected[0]["trips"]


def test_q4_equivalence_2024():
    expected, _ = executor.run_q4(2024, workers=8)
    rows, _ = run_preset("fare_percentiles", range_override=RANGE_2024)
    canon = {r["borough"].replace("-", "/"): r for r in expected}
    assert {r["pu_borough"] for r in rows} == set(canon)
    for r in rows:
        e = canon[r["pu_borough"]]
        assert r["trips"] == e["trips"]
        for mine, theirs in (("p50_fare", "p50"), ("p90_fare", "p90"),
                             ("p99_fare", "p99")):
            assert r[mine] == pytest.approx(e[theirs], abs=1e-9)


def test_range_year_totals():
    rows, _ = run_spec({
        "range": ["2024-01", "2025-12"],
        "measures": ["trips"],
        "dimensions": ["year"],
    })
    assert {r["year"]: r["trips"] for r in rows} == {
        2024: 41_169_300,
        2025: 48_722_388,
    }


# ------------------------------------------------------ DuckDB gates

def test_duckdb_demand_clock_2024():
    rows, stats = run_preset("demand_clock", range_override=RANGE_2024)
    assert stats["gate"]["buckets"] == 168
    mine = {(r["weekday"], r["hour"]): r["trips"] for r in rows}
    ref = _duck(f"""
        WITH t AS (
            SELECT CAST(regexp_extract(filename, '(\\d{{4}}-\\d{{2}})', 1) || '-01' AS TIMESTAMP)
                   + pickup_off_s * INTERVAL 1 SECOND AS ts
            FROM read_parquet('{GLOB_2024}', filename = true)
        )
        SELECT (dayofweek(ts) + 6) % 7 AS wd,
               hour(ts) AS hr, count(*) AS n
        FROM t
        GROUP BY wd, hr
    """)
    theirs = {(int(wd), int(hr)): int(n) for wd, hr, n in ref}
    assert mine == theirs


def test_duckdb_busiest_routes_2024():
    rows, _ = run_preset("busiest_routes", range_override=RANGE_2024)
    assert len(rows) == 20
    ref = _duck(f"""
        SELECT pu, "do", count(*) AS n
        FROM read_parquet('{GLOB_2024}')
        GROUP BY 1, 2 ORDER BY n DESC, 1, 2 LIMIT 25
    """)
    theirs = {(int(pu), int(do)): int(n) for pu, do, n in ref}
    for r in rows:
        assert theirs[(r["pu_zone"], r["do_zone"])] == r["trips"]
    # Nothing left outside the engine's top 20 beats its smallest.
    assert min(r["trips"] for r in rows) >= int(ref[20][2])


def test_duckdb_city_speed_2024():
    rows, _ = run_spec({
        "range": RANGE_2024,
        "measures": ["avg_speed", "trips"],
        "dimensions": ["hour"],
    })
    mine = {r["hour"]: r for r in rows}
    sane = "dur_s BETWEEN 60 AND 14400 AND dist_100mi BETWEEN 10 AND 20000"
    ref = _duck(f"""
        WITH t AS (
            SELECT CAST(regexp_extract(filename, '(\\d{{4}}-\\d{{2}})', 1) || '-01' AS TIMESTAMP)
                   + pickup_off_s * INTERVAL 1 SECOND AS ts,
                   dur_s, dist_100mi
            FROM read_parquet('{GLOB_2024}', filename = true)
        )
        SELECT hour(ts) AS hr, count(*) AS trips,
               count(*) FILTER (WHERE {sane}) AS sane_n,
               (sum(dist_100mi) FILTER (WHERE {sane})) / 100.0 AS sd,
               sum(dur_s) FILTER (WHERE {sane}) AS st
        FROM t
        GROUP BY hr
    """)
    assert len(ref) == 24
    for hr, trips, sane_n, sd, st in ref:
        r = mine[int(hr)]
        assert r["trips"] == int(trips)
        assert r["sane_trips"] == int(sane_n)
        assert r["avg_speed"] == pytest.approx(sd / (st / 3600.0), rel=1e-9)


def test_duckdb_tip_behaviour_2024():
    rows, _ = run_spec({
        "range": RANGE_2024,
        "measures": ["tip_pct_card", "trips"],
        "dimensions": ["pu_borough"],
    })
    mine = {r["pu_borough"]: r for r in rows}
    ref = _duck(f"""
        SELECT z.Borough AS borough, count(*) AS trips,
               100.0 * sum(t.tip_c) FILTER (WHERE t.pay = 1)
                     / sum(t.fare_c) FILTER (WHERE t.pay = 1)
                   AS pct
        FROM read_parquet('{GLOB_2024}') t
        JOIN read_csv('{ZONES_CSV}') z ON z.LocationID = t.pu
        GROUP BY borough
    """)
    assert set(mine) == {b for b, _, _ in ref}
    for borough, trips, pct in ref:
        r = mine[borough]
        assert r["trips"] == int(trips)
        assert r["tip_pct_card"] == pytest.approx(float(pct), rel=1e-9)


def test_duckdb_junk_audit_2024():
    neg, _ = run_spec({
        "range": RANGE_2024,
        "measures": ["trips", "sum_fare"],
        "dimensions": [],
        "filters": {"fare_max": -0.01},
    })
    ref = _duck(f"""
        SELECT count(*), sum(fare_c) / 100.0
        FROM read_parquet('{GLOB_2024}') WHERE fare_c <= -1
    """)
    assert neg[0]["trips"] == int(ref[0][0])
    assert neg[0]["sum_fare"] == pytest.approx(float(ref[0][1]), rel=1e-9)

    paid, _ = run_spec({
        "range": RANGE_2024,
        "measures": ["trips", "sum_fare"],
        "dimensions": [],
        "filters": {"dist_max": 0.0, "fare_min": 0.01},
    })
    ref = _duck(f"""
        SELECT count(*), sum(fare_c) / 100.0
        FROM read_parquet('{GLOB_2024}')
        WHERE dist_100mi <= 0 AND fare_c >= 1
    """)
    assert paid[0]["trips"] == int(ref[0][0])
    assert paid[0]["sum_fare"] == pytest.approx(float(ref[0][1]), rel=1e-9)
