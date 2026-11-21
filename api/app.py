"""TripGrid API (M4): the engine as a small web server.

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
  GET  /api/meta                 years, questions, dataset + cache info
  GET  /api/plan?query&year      which partitions a question will read/skip
  POST /api/query {query, year}  start a job (or answer from cache)
  GET  /api/jobs/{id}            job status / result
  GET  /api/jobs/{id}/events     live progress (Server-Sent Events)
  GET  /api/benchmarks           the latest suite results, if present
  GET  /api/live                 real console runs this session,
                                 latest per query+year (cache hits
                                 are not runs and are never recorded)
"""
from __future__ import annotations

import asyncio
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

from engine import executor, planner, zones

REPO_ROOT = Path(__file__).resolve().parent.parent
CACHE_BUDGET_BYTES = 128 * 1024 * 1024
MAX_JOBS_KEPT = 50

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
    def __init__(self, query: str, year: int):
        self.id = uuid.uuid4().hex[:12]
        self.query = query
        self.year = year
        self.status = "queued"  # queued | running | done | error
        self.queue: asyncio.Queue = asyncio.Queue()
        self.payload: dict | None = None
        self.error: str | None = None


STATE: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    STATE["pool"] = ThreadPoolExecutor(
        max_workers=executor.DEFAULT_WORKERS, thread_name_prefix="tripgrid"
    )
    STATE["semaphore"] = asyncio.Semaphore(1)
    STATE["cache"] = ResultCache(CACHE_BUDGET_BYTES)
    STATE["jobs"] = {}
    STATE["live"] = {}  # (year, query) -> latest real run's record
    yield
    STATE["pool"].shutdown(wait=False)


app = FastAPI(title="TripGrid", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


def _years_available() -> list[int]:
    index = planner.load_index()
    return sorted({int(p["month"][:4]) for p in index})


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
            payload = await loop.run_in_executor(
                STATE["pool"], lambda: _run_engine(job.query, job.year, STATE["pool"], progress)
            )
            job.payload = payload
            job.status = "done"
            STATE["cache"].put(f"{job.query}:{job.year}", payload)
            # Record the run for the Evidence section's Live view.
            # This is the only place runs are recorded, and cache
            # hits never reach it — they return inside start_query —
            # so a "live run" always means the engine really ran.
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


class QueryRequest(BaseModel):
    query: str
    year: int
    # fresh=True skips the result cache: the engine really runs,
    # and the run is recorded in the live evidence.
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
    return {
        "years": _years_available(),
        "queries": [{"id": q, **info} for q, info in QUERIES.items()],
        "partitions": len(index),
        "total_rows": sum(p["rows"] for p in index),
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
    cached = None if req.fresh else STATE["cache"].get(f"{req.query}:{req.year}")
    if cached is not None:
        return {"cached": True, "job_id": None, **cached}
    job = Job(req.query, req.year)
    jobs: dict = STATE["jobs"]
    jobs[job.id] = job
    while len(jobs) > MAX_JOBS_KEPT:  # keep memory bounded; drop oldest finished jobs
        oldest = next((j for j in jobs.values() if j.status in ("done", "error")), None)
        if oldest is None:
            break
        jobs.pop(oldest.id)
    asyncio.create_task(_run_job(job))
    return {"cached": False, "job_id": job.id, "status": job.status}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = STATE["jobs"].get(job_id)
    if job is None:
        raise HTTPException(404, "unknown job")
    out = {"id": job.id, "query": job.query, "year": job.year, "status": job.status}
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
