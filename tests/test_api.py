"""API tests (M4): meta, the pruning plan, a full query job over
HTTP, the result cache answering the second time, the SSE progress
stream, and error handling. Uses one real (small) query per test so
the whole file stays fast.
"""
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.app import app

REPO_ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _wait_done(client, job_id, timeout_s=60):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        body = client.get(f"/api/jobs/{job_id}").json()
        if body["status"] in ("done", "error"):
            return body
        time.sleep(0.2)
    raise AssertionError("job did not finish in time")


def test_meta(client):
    # Meta must report the partition index as it actually is — the
    # archive grows (freshness appends, new eras), so the expected
    # values come from the index itself, never a frozen snapshot.
    index = json.loads(
        (REPO_ROOT / "data" / "partitioned" / "partitions.json").read_text(
            encoding="utf-8"
        )
    )
    years = sorted({int(p["month"][:4]) for p in index["partitions"]})
    body = client.get("/api/meta").json()
    assert body["years"] == years
    assert body["total_rows"] == index["total_rows"]
    assert body["partitions"] == len(index["partitions"])
    assert body["cache"]["budget_bytes"] == 128 * 1024 * 1024


def test_plan_shows_pruning(client):
    body = client.get("/api/plan", params={"query": "q3", "year": 2024}).json()
    selected = [p for p in body["partitions"] if p["selected"]]
    assert len(selected) == 12
    assert all(p["borough"] == "Manhattan" for p in selected)
    assert body["stats"]["partitions_pruned"] > 0


def test_query_flow_and_cache(client):
    started = client.post("/api/query", json={"query": "q2", "year": 2025}).json()
    assert started["cached"] is False
    body = _wait_done(client, started["job_id"])
    assert body["status"] == "done"
    assert body["stats"]["under_ceiling"] is True
    assert any(r["payment_type"] == 1 for r in body["result"]["rows"])
    again = client.post("/api/query", json={"query": "q2", "year": 2025}).json()
    assert again["cached"] is True
    assert again["result"]["rows"] == body["result"]["rows"]


def test_events_stream_progress_then_done(client):
    started = client.post("/api/query", json={"query": "q3", "year": 2024}).json()
    assert started["cached"] is False
    seen = []
    with client.stream("GET", f"/api/jobs/{started['job_id']}/events") as resp:
        assert resp.headers["content-type"].startswith("text/event-stream")
        for line in resp.iter_lines():
            if line.startswith("data:"):
                seen.append(line)
            if '"done"' in line:
                break
    assert seen, "no SSE events received"
    assert '"done"' in seen[-1]


def test_live_records_only_real_runs(client):
    # q2/2024 is exercised by no other test in this module, so its
    # live record starts absent and every step below is exact.
    before = client.get("/api/live").json()
    assert "q2" not in before.get("2024", {})

    started = client.post("/api/query", json={"query": "q2", "year": 2024}).json()
    assert started["cached"] is False
    body = _wait_done(client, started["job_id"])
    assert body["status"] == "done"

    live = client.get("/api/live").json()
    rec = live["2024"]["q2"]
    assert rec["runs"] == 1
    assert rec["wall_seconds"] > 0
    assert rec["rows_scanned"] == body["stats"]["rows_scanned"] == 3_892_990
    assert rec["files_read"] == 24

    # A cache hit is not a run: the record must not move.
    again = client.post("/api/query", json={"query": "q2", "year": 2024}).json()
    assert again["cached"] is True
    live = client.get("/api/live").json()
    assert live["2024"]["q2"]["runs"] == 1
    assert live["2024"]["q2"]["wall_seconds"] == rec["wall_seconds"]

    # A fresh run bypasses the cache: it really executes, and
    # the live record moves to 2.
    fresh = client.post(
        "/api/query", json={"query": "q2", "year": 2024, "fresh": True}
    ).json()
    assert fresh["cached"] is False
    body = _wait_done(client, fresh["job_id"])
    assert body["status"] == "done"
    live = client.get("/api/live").json()
    assert live["2024"]["q2"]["runs"] == 2


def test_errors(client):
    assert client.post("/api/query", json={"query": "q9", "year": 2024}).status_code == 400
    assert client.post("/api/query", json={"query": "q1", "year": 1999}).status_code == 400
    assert client.get("/api/jobs/nope").status_code == 404
