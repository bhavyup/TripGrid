"""TripGrid API: the engine as a small web server.

Design rules, all in service of the 2 GB ceiling:
- ONE shared ThreadPoolExecutor for the whole server, created at
  startup. Requests never create their own pools.
- Heavy queries are serialised behind a single-slot semaphore:
  two visitors clicking at once queue cleanly instead of running
  two ~800 MB scans side by side and breaching the ceiling.
- Results are cached in a byte-budgeted LRU (128 MB of serialized
  JSON), so the cache itself can never eat the headroom.
- Progress reaches the SSE stream through
  loop.call_soon_threadsafe — engine worker threads never touch
  the asyncio queue directly.

Endpoints:
  GET  /api/meta                 years, months, questions, archive
                                 size, freshness status, cache info
  GET  /api/plan?query&year      which partitions a question will read/skip
  POST /api/query {query, year}  start a job (or answer from cache)
  GET  /api/presets              the eleven preset questions (2.0)
  GET  /api/builder              the builder catalogue: measures,
                                 dimensions, filters, budgets (2.0)
  POST /api/spec/validate {spec} price a recipe without running it
  POST /api/spec/run {spec}      run a hand-built recipe as a job
  POST /api/preset/run {name}    run a preset (range overridable)
  GET  /api/jobs/{id}            job status / result
  GET  /api/jobs/{id}/events     live progress (Server-Sent Events)
  GET  /api/benchmarks           the latest suite results, if present
  GET  /api/live                 real console runs this session,
                                 latest per query+year (cache hits
                                 are not runs and are never recorded)

Freshness: a background task checks the city's feed shortly after
startup and then daily — new months are downloaded, converted and
indexed by ingest.freshness, and months the city re-published are
replaced. The latest status rides along in /api/meta. Set
TRIPGRID_FRESHNESS=off to disable (tests do not need the network).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from engine import composer, executor, planner, zones
from engine.spec import (
    DIMENSIONS,
    MAX_BUCKETS,
    MAX_PCTL_GROUPS,
    PERCENTILE_MEASURES,
    PRESETS,
    Spec,
    SpecError,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_BUDGET_BYTES = 128 * 1024 * 1024
MAX_JOBS_KEPT = 50
FRESHNESS_INTERVAL_S = 24 * 3600

QUERIES = {
    "q1": {
        "title": "Trips per pickup zone, per month",
        "description": "How many rides started in each of the 265 zones, for each month.",
    },
    "q2": {
        "title": "Airport pickups: average fare and tip by payment type",
        "description": "Rides starting at JFK, LaGuardia or Newark, grouped by how people paid.",
    },
    "q3": {
        "title": "Friday-evening Manhattan: top 20 drop-off zones",
        "description": "Where rides that start in Manhattan on a Friday evening (17:00-23:59) end up.",
    },
    "q4": {
        "title": "Exact fare percentiles per borough",
        "description": "The p50 / p90 / p99 fare for each pickup borough — exact, no approximation.",
    },
}


class ResultCache:
    """LRU cache budgeted by serialized byte size, not entry count."""

    def __init__(self, budget_bytes: int):
        self.budget = budget_bytes
        self._items: OrderedDict[str, bytes] = OrderedDict()
        self._bytes = 0

    def get(self, key: str) -> dict | None:
        raw = self._items.get(key)
        if raw is None:
            return None
        self._items.move_to_end(key)
        return json.loads(raw)

    def put(self, key: str, payload: dict) -> None:
        raw = json.dumps(payload).encode()
        if len(raw) > self.budget:
            return  # a single result bigger than the whole budget: don't cache
        if key in self._items:
            self._bytes -= len(self._items.pop(key))
        while self._bytes + len(raw) > self.budget and self._items:
            _, evicted = self._items.popitem(last=False)
            self._bytes -= len(evicted)
        self._items[key] = raw
        self._bytes += len(raw)

    def stats(self) -> dict:
        return {"entries": len(self._items), "bytes": self._bytes, "budget_bytes": self.budget}


class Job:
    """One unit of engine work. kind is "legacy" (the original four
    questions), "preset" (a named 2.0 recipe) or "spec" (a recipe
    built by hand in the Question Builder)."""

    def __init__(
        self,
        query: str,
        year: int | None,
        kind: str = "legacy",
        title: str = "",
        spec_dict: dict | None = None,
        preset: str | None = None,
        range_override=None,
        cache_key: str | None = None,
    ):
        self.id = uuid.uuid4().hex[:12]
        self.query = query
        self.year = year
        self.kind = kind
        self.title = title
        self.spec_dict = spec_dict
        self.preset = preset
        self.range_override = range_override
        self.cache_key = cache_key
        self.status = "queued"  # queued | running | done | error
        self.queue: asyncio.Queue = asyncio.Queue()
        self.payload: dict | None = None
        self.error: str | None = None


STATE: dict = {}


def _archive_bytes() -> int:
    """Total size of the partitioned archive on disk."""
    root = REPO_ROOT / "data" / "partitioned"
    if not root.exists():
        return 0
    return sum(f.stat().st_size for f in root.rglob("*.parquet"))


async def _freshness_loop() -> None:
    """Check the city's feed shortly after startup, then daily.
    Failures are recorded in STATE, never raised — a dead network
    must not take the server down with it."""
    if os.environ.get("TRIPGRID_FRESHNESS") == "off":
        return
    await asyncio.sleep(20)
    while True:
        try:
            from ingest import freshness

            status = await asyncio.get_running_loop().run_in_executor(
                STATE["pool"], lambda: freshness.check_and_update()
            )
            STATE["freshness"] = status
            STATE["archive_bytes"] = _archive_bytes()
        except Exception as exc:  # recorded, never swallowed silently
            STATE["freshness"] = {
                "error": f"{type(exc).__name__}: {exc}",
                "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
        await asyncio.sleep(FRESHNESS_INTERVAL_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    STATE["pool"] = ThreadPoolExecutor(
        max_workers=executor.DEFAULT_WORKERS, thread_name_prefix="tripgrid"
    )
    STATE["semaphore"] = asyncio.Semaphore(1)
    STATE["cache"] = ResultCache(CACHE_BUDGET_BYTES)
    STATE["jobs"] = {}
    STATE["live"] = {}  # (year, query) -> latest real run's record
    STATE["freshness"] = None  # latest freshness status, once checked
    STATE["archive_bytes"] = _archive_bytes()
    STATE["freshness_task"] = asyncio.create_task(_freshness_loop())
    yield
    STATE["freshness_task"].cancel()
    STATE["pool"].shutdown(wait=False)


app = FastAPI(title="TripGrid", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


def _years_available() -> list[int]:
    index = planner.load_index()
    return sorted({int(p["month"][:4]) for p in index})


def _index_months() -> list[str]:
    return sorted({p["month"] for p in planner.load_index()})


def _months_of(year: int) -> set[str]:
    return {f"{year}-{m:02d}" for m in range(1, 13)}


def _boroughs_for(query: str) -> set[str] | None:
    if query == "q2":
        zone_map = zones.load_zones()
        return {zone_map[i]["borough"].replace("/", "-") for i in zones.airport_ids(zone_map)}
    if query == "q3":
        return {"Manhattan"}
    return None


def _run_engine(query: str, year: int, pool, progress) -> dict:
    """Runs in a pool thread. Shapes the result exactly like the
    benchmark runners do, so API answers and suite answers agree."""
    kw = dict(workers=executor.DEFAULT_WORKERS, pool=pool, progress=progress)
    if query == "q1":
        counts, stats = executor.run_q1(year, **kw)
        result = {"total": int(counts.sum()), "matrix": counts.tolist()}
    elif query == "q2":
        rows, stats = executor.run_q2(year, **kw)
        result = {"rows": rows}
    elif query == "q3":
        rows, stats = executor.run_q3(year, **kw)
        result = {"rows": rows}
    else:
        rows, stats = executor.run_q4(year, **kw)
        result = {"rows": rows}
    # Pool jobs are one file each, so files read == partitions selected.
    stats = {**stats, "files_read": stats["partitions_selected"]}
    return {"result": result, "stats": stats}


def _run_composer(job: Job, pool, progress) -> dict:
    """Runs in a pool thread. Runs a preset or a hand-built recipe
    through the composer and normalises its stats into the same
    shape the legacy runners produce, so the console's run-stats
    strip works unchanged for every kind of question."""
    kw = dict(workers=executor.DEFAULT_WORKERS, pool=pool, progress=progress)
    if job.kind == "preset":
        rows, stats = composer.run_preset(
            job.preset, range_override=job.range_override, **kw
        )
        kind = stats.get("kind", "preset")
        title = stats.get("title") or job.title
    else:
        rows, stats = composer.run_spec(job.spec_dict, **kw)
        kind = "spec"
        title = job.title or "Custom question"
    peak = float(stats.get("peak_rss_mb", 0.0))
    norm = {
        "partitions_total": int(stats.get("partitions_total", 0)),
        "partitions_selected": int(stats.get("partitions_selected", 0)),
        "partitions_pruned": int(stats.get("partitions_pruned", 0)),
        "rows_total": int(stats.get("rows_total", 0)),
        "rows_selected": int(stats.get("rows_selected", 0)),
        "rows_scanned": int(stats.get("rows_scanned", 0)),
        "files_read": int(stats.get("partitions_selected", 0)),
        "wall_seconds": float(stats.get("wall_s", stats.get("wall_seconds", 0.0))),
        "peak_rss_mb": peak,
        "ceiling_mb": executor.DEFAULT_CEILING_MB,
        "under_ceiling": peak <= executor.DEFAULT_CEILING_MB,
        "workers": executor.DEFAULT_WORKERS,
    }
    result = {
        "kind": kind,
        "title": title,
        "rows": rows,
        "spec": stats.get("spec"),
        "gate": stats.get("gate"),
    }
    return {"result": result, "stats": norm}


# Four of the presets ARE the original four questions, re-expressed
# as recipes. When one of them runs over exactly one calendar year,
# the run is the same question over the same data the Evidence
# section races — so it counts as that question's live run, with
# the composer's own measured stats. Anything else (other ranges,
# other presets, audits, hand-built recipes) is not recorded: the
# Live view only ever shows like-for-like runs.
LEGACY_OF_PRESET = {
    "zone_month_trips": "q1",
    "airport_payments": "q2",
    "friday_manhattan": "q3",
    "fare_percentiles": "q4",
}


def _record_live_from_preset(job: Job, payload: dict) -> None:
    query = LEGACY_OF_PRESET.get(job.preset or "")
    if query is None:
        return
    spec_out = (payload.get("result") or {}).get("spec") or {}
    rng = spec_out.get("range") or []
    if len(rng) != 2:
        return
    start, end = rng
    if start[5:] != "01" or end[5:] != "12" or start[:4] != end[:4]:
        return  # not exactly one calendar year — not like-for-like
    year = int(start[:4])
    stats = payload["stats"]
    key = (year, query)
    prev = STATE["live"].get(key)
    STATE["live"][key] = {
        "wall_seconds": stats["wall_seconds"],
        "peak_rss_mb": stats["peak_rss_mb"],
        "rows_scanned": stats["rows_scanned"],
        "files_read": stats["files_read"],
        "partitions_selected": stats["partitions_selected"],
        "runs": (prev["runs"] + 1) if prev else 1,
        "last_run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


async def _run_job(job: Job) -> None:
    loop = asyncio.get_running_loop()
    async with STATE["semaphore"]:
        job.status = "running"

        def progress(done: int, total: int) -> None:
            # Called from engine threads — bridge safely to the loop.
            loop.call_soon_threadsafe(
                job.queue.put_nowait, {"type": "progress", "done": done, "total": total}
            )

        try:
            if job.kind == "legacy":
                payload = await loop.run_in_executor(
                    STATE["pool"],
                    lambda: _run_engine(job.query, job.year, STATE["pool"], progress),
                )
            else:
                payload = await loop.run_in_executor(
                    STATE["pool"], lambda: _run_composer(job, STATE["pool"], progress)
                )
            job.payload = payload
            job.status = "done"
            if job.cache_key:
                STATE["cache"].put(job.cache_key, payload)
            if job.kind == "preset":
                _record_live_from_preset(job, payload)
            if job.kind == "legacy":
                # Record the run for the Evidence section's Live view.
                # This is the only place runs are recorded, and cache
                # hits never reach it — they return inside the start
                # endpoints — so a "live run" always means the engine
                # really ran.
                stats = payload["stats"]
                key = (job.year, job.query)
                prev = STATE["live"].get(key)
                STATE["live"][key] = {
                    "wall_seconds": stats["wall_seconds"],
                    "peak_rss_mb": stats["peak_rss_mb"],
                    "rows_scanned": stats["rows_scanned"],
                    "files_read": stats["files_read"],
                    "partitions_selected": stats["partitions_selected"],
                    "runs": (prev["runs"] + 1) if prev else 1,
                    "last_run_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
            job.queue.put_nowait({"type": "done"})
        except Exception as exc:  # surfaced to the client, never swallowed
            job.status = "error"
            job.error = f"{type(exc).__name__}: {exc}"
            job.queue.put_nowait({"type": "error", "error": job.error})


def _register_job(job: Job) -> None:
    jobs: dict = STATE["jobs"]
    jobs[job.id] = job
    while len(jobs) > MAX_JOBS_KEPT:  # keep memory bounded; drop oldest finished jobs
        oldest = next((j for j in jobs.values() if j.status in ("done", "error")), None)
        if oldest is None:
            break
        jobs.pop(oldest.id)
    asyncio.create_task(_run_job(job))


class QueryRequest(BaseModel):
    query: str
    year: int
    # fresh=True skips the result cache: the engine really runs,
    # and the run is recorded in the live evidence.
    fresh: bool = False


class SpecRequest(BaseModel):
    spec: dict
    fresh: bool = False


class PresetRequest(BaseModel):
    name: str
    range: list[str] | None = None
    fresh: bool = False


@app.get("/api/health")
def health():
    return {"ok": True, "name": "TripGrid API"}


@app.get("/api/zones")
def zones_list():
    """id -> {borough, zone} for the frontend's result views."""
    return {str(i): z for i, z in zones.load_zones().items()}


@app.get("/api/meta")
def meta():
    index = planner.load_index()
    months = sorted({p["month"] for p in index})
    month_rows: dict[str, int] = {}
    for p in index:
        month_rows[p["month"]] = month_rows.get(p["month"], 0) + p["rows"]
    return {
        "years": _years_available(),
        "months": months,
        "month_rows": month_rows,
        "newest_month": months[-1] if months else None,
        "queries": [{"id": q, **info} for q, info in QUERIES.items()],
        "partitions": len(index),
        "total_rows": sum(p["rows"] for p in index),
        "archive_bytes": STATE.get("archive_bytes", 0),
        "freshness": STATE.get("freshness"),
        "ceiling_mb": executor.DEFAULT_CEILING_MB,
        "workers": executor.DEFAULT_WORKERS,
        "cache": STATE["cache"].stats(),
    }


@app.get("/api/plan")
def plan(query: str, year: int):
    if query not in QUERIES:
        raise HTTPException(400, f"unknown query {query!r}; expected one of {sorted(QUERIES)}")
    index = planner.load_index()
    selected, stats = planner.select_partitions(
        index, months=_months_of(year), boroughs=_boroughs_for(query)
    )
    chosen = {p["path"] for p in selected}
    return {
        "query": query,
        "year": year,
        "stats": stats,
        "partitions": [
            {**p, "selected": p["path"] in chosen} for p in index if p["month"][:4] == str(year)
        ],
    }


@app.post("/api/query")
async def start_query(req: QueryRequest):
    if req.query not in QUERIES:
        raise HTTPException(400, f"unknown query {req.query!r}; expected one of {sorted(QUERIES)}")
    if req.year not in _years_available():
        raise HTTPException(400, f"no data for year {req.year}")
    cache_key = f"{req.query}:{req.year}"
    cached = None if req.fresh else STATE["cache"].get(cache_key)
    if cached is not None:
        return {"cached": True, "job_id": None, **cached}
    job = Job(
        req.query,
        req.year,
        title=QUERIES[req.query]["title"],
        cache_key=cache_key,
    )
    _register_job(job)
    return {"cached": False, "job_id": job.id, "status": job.status}


# ------------------------------------------------------------------
# TripGrid 2.0: presets, the Question Builder catalogue, and recipe
# runs. A recipe is validated (and priced by the cardinality gate)
# before a job exists, so a refusal is a clean 400 with the gate's
# own plain-words message — never a failed job.

MEASURE_LABELS: dict[str, tuple[str, str]] = {
    # id -> (label, unit) — the unit tells the frontend how to
    # format a value: usd, pct, mi, mph, duration_s, count, plain.
    "trips": ("Trips", "count"),
    "sum_fare": ("Total fare", "usd"),
    "avg_fare": ("Average fare", "usd"),
    "sum_tip": ("Total tip", "usd"),
    "avg_tip": ("Average tip", "usd"),
    "tip_pct": ("Tip % of fare", "pct"),
    "tip_pct_card": ("Tip % — card trips only", "pct"),
    "sum_total": ("Total charged", "usd"),
    "sum_distance": ("Total distance", "mi"),
    "avg_distance": ("Average distance", "mi"),
    "sum_passengers": ("Total passengers", "count"),
    "avg_passengers": ("Average passengers", "plain"),
    "avg_duration": ("Average duration", "duration_s"),
    "avg_speed": ("Average speed", "mph"),
    "p50_fare": ("Median fare (p50)", "usd"),
    "p90_fare": ("Fare p90", "usd"),
    "p99_fare": ("Fare p99", "usd"),
}

DIMENSION_LABELS: dict[str, str] = {
    "year": "Year",
    "month": "Month",
    "month_of_year": "Month of year",
    "pu_borough": "Pickup borough",
    "do_borough": "Drop-off borough",
    "pu_zone": "Pickup zone",
    "do_zone": "Drop-off zone",
    "route": "Route — pickup → drop-off",
    "hour": "Hour of day",
    "weekday": "Weekday",
    "hour_weekday": "Hour × weekday",
    "payment_type": "Payment type",
    "airport": "Airport pickup",
}

FILTER_DEFS: list[tuple[str, str, str]] = [
    # id, label, kind — kind tells the frontend which control to
    # draw: boroughs | zones | hours | weekdays | payments |
    # airport | flag | number.
    ("pu_boroughs", "Pickup boroughs", "boroughs"),
    ("do_boroughs", "Drop-off boroughs", "boroughs"),
    ("pu_zones", "Pickup zones", "zones"),
    ("do_zones", "Drop-off zones", "zones"),
    ("hours", "Hours of day", "hours"),
    ("weekdays", "Weekdays", "weekdays"),
    ("payment_types", "Payment types", "payments"),
    ("airport", "Airport pickups", "airport"),
    ("sane_only", "Sane trips only (60s–4h, 0.1–200 mi)", "flag"),
    ("fare_min", "Fare at least ($)", "number"),
    ("fare_max", "Fare at most ($)", "number"),
    ("dist_min", "Distance at least (mi)", "number"),
    ("dist_max", "Distance at most (mi)", "number"),
    ("dur_min", "Duration at least (seconds)", "number"),
    ("dur_max", "Duration at most (seconds)", "number"),
    ("min_passengers", "Passengers at least", "number"),
]

BOROUGHS = [
    "Manhattan", "Brooklyn", "Queens", "Bronx",
    "Staten Island", "EWR", "N/A", "Unknown",
]

PAYMENT_LABELS = {
    0: "Unknown", 1: "Card", 2: "Cash", 3: "No charge",
    4: "Dispute", 5: "Unknown (5)", 6: "Voided",
}


@app.get("/api/presets")
def presets():
    out = []
    for pid, p in PRESETS.items():
        item = {
            "id": pid,
            "title": p["title"],
            "note": p["note"],
            "kind": p.get("kind", "spec"),
        }
        if item["kind"] == "audit":
            item["parts"] = [
                {"name": part["name"], "label": part["label"]} for part in p["parts"]
            ]
        else:
            item["spec"] = p["spec"]
        out.append(item)
    return out


@app.get("/api/builder")
def builder():
    """Everything the Question Builder needs to draw itself: the
    full toggle surface, with the gate budgets stated up front."""
    return {
        "measures": [
            {
                "id": m,
                "label": label,
                "unit": unit,
                "percentile": m in PERCENTILE_MEASURES,
            }
            for m, (label, unit) in MEASURE_LABELS.items()
        ],
        "dimensions": [
            {"id": d, "label": DIMENSION_LABELS[d], "cardinality": DIMENSIONS[d]}
            for d in DIMENSION_LABELS
        ],
        "filters": [
            {"id": f, "label": label, "kind": kind} for f, label, kind in FILTER_DEFS
        ],
        "boroughs": BOROUGHS,
        "payments": [
            {"id": pid, "label": label} for pid, label in PAYMENT_LABELS.items()
        ],
        "max_buckets": MAX_BUCKETS,
        "max_pctl_groups": MAX_PCTL_GROUPS,
    }


def _validate(raw: dict) -> Spec:
    return Spec(raw, index_months=_index_months())


@app.post("/api/spec/validate")
def validate_spec(req: SpecRequest):
    """Price a recipe without running it: the gate's verdict, the
    months and rows it would touch. The builder calls this as the
    user toggles, so the gate line is always live."""
    index = planner.load_index()
    try:
        spec = _validate(req.spec)
    except SpecError as exc:
        return {"ok": False, "error": str(exc)}
    in_range = set(spec.months)
    return {
        "ok": True,
        "gate": spec.gate_report(),
        "months": len(spec.months),
        "rows_in_range": sum(p["rows"] for p in index if p["month"] in in_range),
        "partitions_in_range": sum(1 for p in index if p["month"] in in_range),
        "spec": spec.to_dict(),
    }


@app.post("/api/spec/run")
async def start_spec_run(req: SpecRequest):
    try:
        spec = _validate(req.spec)
    except SpecError as exc:
        raise HTTPException(400, str(exc))
    cache_key = "spec:" + hashlib.sha256(
        json.dumps(spec.to_dict(), sort_keys=True).encode()
    ).hexdigest()[:20]
    if not req.fresh:
        cached = STATE["cache"].get(cache_key)
        if cached is not None:
            return {"cached": True, "job_id": None, **cached}
    job = Job(
        "spec",
        None,
        kind="spec",
        title="Custom question",
        spec_dict=spec.to_dict(),
        cache_key=cache_key,
    )
    _register_job(job)
    return {"cached": False, "job_id": job.id, "status": job.status}


@app.post("/api/preset/run")
async def start_preset_run(req: PresetRequest):
    if req.name not in PRESETS:
        raise HTTPException(
            400, f"unknown preset {req.name!r}; expected one of {sorted(PRESETS)}"
        )
    preset = PRESETS[req.name]
    is_audit = preset.get("kind") == "audit"
    range_override = None if is_audit else req.range
    try:
        if is_audit:
            for part in preset["parts"]:
                _validate(part["spec"])
        else:
            raw = dict(preset["spec"])
            if range_override is not None:
                raw["range"] = range_override
            _validate(raw)
    except SpecError as exc:
        raise HTTPException(400, str(exc))
    cache_key = f"preset:{req.name}:{range_override or 'default'}"
    if not req.fresh:
        cached = STATE["cache"].get(cache_key)
        if cached is not None:
            return {"cached": True, "job_id": None, **cached}
    job = Job(
        "preset",
        None,
        kind="preset",
        title=preset["title"],
        preset=req.name,
        range_override=range_override,
        cache_key=cache_key,
    )
    _register_job(job)
    return {"cached": False, "job_id": job.id, "status": job.status}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = STATE["jobs"].get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job")
    out = {
        "id": job.id,
        "query": job.query,
        "year": job.year,
        "kind": job.kind,
        "title": job.title,
        "status": job.status,
    }
    if job.payload is not None:
        out.update(job.payload)
    if job.error is not None:
        out["error"] = job.error
    return out


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str):
    job = STATE["jobs"].get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job")

    async def stream():
        if job.status in ("done", "error"):
            yield f"data: {json.dumps({'type': job.status})}\n\n"
            return
        while True:
            event = await job.queue.get()
            yield f"data: {json.dumps(event)}\n\n"
            if event["type"] in ("done", "error"):
                return

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.get("/api/benchmarks")
def benchmarks():
    out = {}
    for year in _years_available():
        path = REPO_ROOT / "bench" / "results" / f"suite_{year}.json"
        if path.exists():
            out[str(year)] = json.loads(path.read_text(encoding="utf-8"))
    return out


@app.get("/api/live")
def live():
    """Latest real run per query+year, recorded this server
    session. A query with no real run yet is simply absent."""
    out: dict = {}
    for (year, query), rec in STATE["live"].items():
        out.setdefault(str(year), {})[query] = rec
    return out


# The built frontend (web/dist) is served by this same process when
# it exists, so the whole product ships as one server. API routes
# above are registered first and always win over the static mount.
_DIST = REPO_ROOT / "web" / "dist"
if _DIST.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=_DIST, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8000")))
