# TripGrid — Out-of-Core Analytics Engine + Full-Stack Platform

**Purpose.** A query engine that runs analytical queries over the NYC TLC Yellow Taxi
dataset — ~49M trips/year, ~1.5B rows across its full history — on a machine where the
data does not fit in RAM, wrapped in a full-stack product (FastAPI + React/TS) that makes
the engineering visible. Pandas/NumPy are the engine room: every kernel is vectorised
NumPy, Pandas appears only at the edges (small result frames, the baseline we benchmark
against). Built to roster standard alongside DBShield, PrivateGPT and Helios-Grid:
an engine with guarantees, measured, and demoable.

**Working name:** TripGrid (rename freely). **Home:** `d:/codes/tripgrid` on the PC.
**Status:** v2 design, 21 Nov 2026 — full-stack layer added, five engineering traps
from design review folded in (see "Traps accounted for"). Query 4 percentile
design LOCKED as the exact hybrid in Traps C. No code written yet.

## The problem it solves

A year of TLC data is ~800 MB of Parquet that becomes several GB in memory. Naive
`pd.read_parquet` on multi-year data OOMs or swaps. TripGrid's contract:

1. **Memory ceiling is hard.** The engine runs under a configured RAM budget
   (default 2 GB) and never crosses it — it chunks, prunes and schedules instead.
   The ceiling is measured across the *entire process tree* (see Traps, B).
2. **Results are provably right.** Every benchmark query is also run on DuckDB as the
   reference engine; TripGrid's output must match within float tolerance
   (`np.isclose`), or the benchmark fails. No fast-but-wrong numbers. This is
   differential testing, the way real query engines are tested.
3. **Throughput is measured, not claimed.** Rows/sec and peak RSS are recorded per
   query, per engine (TripGrid / pandas / DuckDB), on identical hardware and data.

## Why the full-stack layer (added v2)

A pure CLI engine is impressive to a database engineer, but a recruiter skimming a
resume sees "NYC Taxi data" and reads "beginner analytics project". The product layer
exists to make invisible engineering visible — it is a thin shell, not the project:

- **FastAPI service:** async query jobs over the engine, progress streamed via
  SSE/WebSocket, result caching, clean REST contracts for the query spec.
- **React/TS frontend (hand-built, not a BI tool):** declarative query builder,
  a partition-pruning visualiser (partitions scanned vs skipped, with manifest
  min/max stats), live RSS/latency during a run, and a benchmark comparison view
  (TripGrid vs pandas vs DuckDB: wall time, peak RSS, rows scanned vs pruned).
- **Strict rule: engine-first.** M0 → M1 → M2 (ingest, kernels, pruning/parallelism,
  correctness gate) are validated in Python before any React is written. The UI
  never eats the engine's time.

This bridges both target tracks: Backend/Full-Stack SDE (async jobs, streaming,
caching, REST, React/TS) and Data/ML Engineering (columnar Parquet/PyArrow,
predicate pushdown/pruning, vectorised NumPy layouts, schema drift handling).

## Dataset

- Source: NYC TLC trip records (public domain), monthly Parquet files from the TLC
  CDN — e.g. `yellow_tripdata_2024-01.parquet` (~48 MB, ~3.0M trips).
- Working set: **2024 + 2025 first (~95M trips)**, then a 3-year scale run.
  Full history (2009–2025, ~1.5B rows) is the stretch goal.
- Schema and data drift are real (see Traps, D): ingestion normalises columns by
  name, lowercases to snake_case, quarantines garbage rows, and records what it
  saw per file in the manifest.

## Architecture

```
tripgrid/
  ingest/     downloader + partitioner + manifest + quarantine
  engine/     kernels.py    vectorised filter / group-by / join / top-k (NumPy)
              executor.py   chunked execution, worker pool, memory budget
              query.py      declarative query spec -> execution plan
  api/        FastAPI app: job submission, SSE progress, result cache
  web/        React/TS: query builder, pruning visualiser, benchmark view
  bench/      benchmark harness (TripGrid vs pandas vs DuckDB) + correctness gate
  tests/      kernel unit tests; end-to-end correctness on one sampled month
  data/       raw/ (monthly files)  partitioned/ (engine layout)  [gitignored]
```

- **Partitioned layout.** Ingestion repartitions monthly files by pickup month ×
  borough into a local Parquet layout and writes a **manifest**: per-partition row
  counts and min/max stats per column, plus per-file quarantine counts.
- **Partition pruning.** The planner reads the manifest first and skips partitions
  that cannot match the query's filters — most queries should touch a fraction of
  the data.
- **Vectorised kernels.** Filter = boolean-mask kernels; group-by = sort-based
  segmented reduction (`np.lexsort` + `np.reduceat`) and `np.bincount` for
  low-cardinality / composite keys; join = hash join against the 265-row zone
  lookup; top-k = `np.argpartition`. No Python row loops anywhere in a hot path.
- **Executor.** Streams partitions in chunks sized to the memory budget
  (PyArrow `iter_batches()` with explicit `batch_size`), fans out across a
  *conservative* multiprocessing pool (2–3 workers on Windows, see Traps, B),
  merges partial aggregates (sum/count merge trivially; mean via sum+count;
  percentiles are NOT mergeable — see Traps, C).
- **Query layer.** A small declarative spec (filters, group-by keys, aggregations,
  top-k) — enough to express the benchmark suite, not a SQL parser. The same spec
  is what the API accepts and the frontend builds.

## Benchmark suite (the proof)

Fixed query set, run identically on all three engines, same machine:

1. Trips per pickup zone per month (group-by, 2 keys).
2. Average fare and tip % by payment type, filtered to airport trips (filter + agg).
3. Top-20 drop-off zones for Friday-evening pickups in Manhattan (filter + join + top-k).
4. Fare distribution percentiles by trip-distance bucket (the hard one — Traps, C).
5. Full-year revenue rollup with every fee column (wide aggregation, no pruning).

Recorded per run: wall time, peak RSS (whole process tree), rows scanned vs rows
pruned, and the correctness verdict vs DuckDB. Results land in `bench/results/`
as CSV + a chart, and are surfaced in the web benchmark view.

## Traps accounted for (design review, 21 Nov 2026)

### A. Timeline is 1.5–2 weeks of focused work, not five sittings
Vectorised group-bys, out-of-core joins, partial-aggregate merging, SSE streaming
and a React frontend do not fit one sitting per milestone. Milestones below are
*phases*, sequenced engine-first. Do not rush M1/M2 to get to the UI.

### B. Windows multiprocessing (`spawn`) + the 2 GB ceiling
Windows uses `spawn`, not `fork`: every worker is a fresh interpreter loading
NumPy + PyArrow DLLs at ~100–150 MB baseline before reading a row. 6 workers +
Uvicorn would burn ~1 GB on overhead alone. Therefore:
- Worker pool capped at 2–3; chunk size set explicitly via `iter_batches(batch_size=...)`.
- Peak RSS measured with `psutil` over `Process().children(recursive=True)`,
  never just the main PID — in the engine, the API, and the benchmark harness.

### C. Query 4 percentiles are holistic — DECISION LOCKED (21 Nov 2026): exact hybrid
Partials cannot be averaged, and no method is one-pass + tiny-memory + exact for
arbitrary data (Munro–Paterson: exact single-pass selection needs
Ω(N^(1/p)) memory). Rejected: the sketch (t-digest/DDSketch — approximate, breaks
the uniform DuckDB gate), the pure two-pass partition (exact but slow), and the
dense cent-bucket array sized to the max fare seen (one dirty $999,999 row =
~100M counters ≈ 800 MB per distance bucket — a production failure mode caught
in design review). **Locked design: sparse value-count histograms with a radix
selection fallback, both exact, per chunk, merged by adding counts.**

Per chunk, per distance bucket:
1. **`np.bincount` fast path, O(M), no sorting.** Convert fares to int64 cents.
   Mask the normal range $0.00–$1,000.00 (0–100,000 cents) and `np.bincount` it:
   a flat 100,001-counter array (~800 KB per bucket) handles ~99.99% of rows in
   one linear pass. The array is sized by the *cap*, never by the max fare seen,
   so outliers cannot blow it up.
2. **Outlier slice via `np.unique`.** Only rows < $0 or > $1,000 (a tiny slice)
   go through `np.unique` (sort-based, O(M log M) — acceptable at that size).
   Nothing is dropped by the kernel: negative fares (disputed/refunded rides)
   are counted exactly here.
3. **Merge into a sparse `(fare, count)` table.** Non-zero bincount entries and
   the outlier uniques merge into one sparse table per chunk; tables from all
   chunks/workers merge by adding counts. Real TLC data has only ~20k–50k
   distinct fare values (< 1 MB sparse), so merged state stays tiny. M0 must
   measure the real distinct count and the real fare range before M3 relies on
   this — if distinct counts ever explode past threshold (~1–2M per bucket),
   the fallback below takes over.
4. **Radix selection fallback.** If the sparse table grows past threshold, switch
   to radix selection: 256 piles by digit, locate the pile holding the target
   rank, recurse/load only that pile, `np.partition` it. Bounded memory, exact
   for any range or precision, at the cost of an extra pass over a ~1/256 slice.
   - **IEEE-754 trap (mandatory):** never bucket by the top byte of raw float64 —
     sign-magnitude means negative floats sort backwards. Radix operates on
     int64 cents (the engine's normal representation); if a raw-float path is
     ever used, first map float64 → order-preserving uint64 (flip the sign bit
     for positives, flip all bits for negatives).
   - **Not dead code:** the fallback will never trigger naturally on TLC data
     (~20k–50k distinct fares), so `tests/` MUST include a synthetic test with
     `np.random.uniform` floats that forces the fallback path.

**Correctness gate — `quantile_cont` interpolation (mandatory).** DuckDB's
`quantile_cont(p)` does NOT return the value where cumulative count crosses
p·N (that is a discrete quantile and will fail the gate on boundary cases).
It computes `idx = p × (N − 1)` and linearly interpolates between the order
statistics at ⌊idx⌋ and ⌈idx⌉. The walker over the merged `(fare, count)` table
must do the same: locate both neighbouring order statistics — including when
⌊idx⌋ is the last row of fare v_i and ⌈idx⌉ is the first row of v_{i+1} — and
return `v_i + (idx − ⌊idx⌋) × (v_{i+1} − v_i)`. Only then does Query 4 pass
the same `np.isclose`-vs-DuckDB gate as the other queries.

### D. Dirty TLC data, beyond `cbd_congestion_fee`
- **Casing drift:** `Airport_fee` vs `airport_fee` varies by year/month —
  normalise every column name to lowercase snake_case on ingest.
- **Garbage rows:** files routinely contain pickup timestamps from 2001/2008/2099,
  negative fares, and 0-mile trips. Partitioning blindly by `pickup_datetime`
  would create garbage partitions and wreck min/max pruning stats. Ingest
  validates ranges, quarantines out-of-range rows to a separate partition, and
  records quarantine counts per file in the manifest.

### E. Deployment needs real RAM
Do NOT deploy the backend to a 512 MB free PaaS container — it OOMs on multi-GB
Parquet scans. Deploy to a VM with 4–8 GB RAM (e.g. Oracle Cloud ARM), with the
2 GB ceiling genuinely enforced via Docker `--memory=2g` plus application-level
memory guards.

## Milestones (phases, engine-first; ~1.5–2 weeks focused total)

- **M0 — Ingest.** Downloader, normaliser (casing + schema drift), partitioner,
  quarantine, manifest for 2024; one query end-to-end the naive pandas way
  (the baseline that later numbers beat).
- **M1 — Kernels + chunked executor.** Filter + group-by kernels over a full year
  under the 2 GB ceiling (tree-RSS verified); unit tests green.
- **M2 — Pruning + parallelism + join/top-k.** Manifest-driven pruning, worker
  pool, zone join, queries 1–3 running as engine queries.
- **M3 — Benchmark + correctness gate.** Full suite vs pandas/DuckDB, 2024+2025
  (~95M rows), percentile decision (Traps, C) implemented for query 4.
- **M4 — API.** FastAPI job submission, SSE progress, result cache over the
  frozen engine API.
- **M5 — Frontend.** React/TS query builder, pruning visualiser, benchmark view.
- **M6 — Scale run + write-up.** 3-year run, deployment per Traps E, README with
  measured results and honest failure notes (where DuckDB wins, and why).
  CV bullet drafted from the measured numbers only.

## Stack

Python · NumPy · Pandas (edges + baseline) · PyArrow (Parquet IO) · DuckDB
(reference + benchmark only, never in the engine path) · FastAPI (service layer) ·
React + TypeScript (frontend) · psutil (tree-RSS measurement) · PyTest ·
matplotlib (bench charts). No other dependencies without a reason.

## Rules of the build

- Built *with* Bhavya, not for him: he directs design calls, reviews every module,
  and must be able to defend every line.
- Engine-first: no React until M0–M2 are validated.
- No number goes in the README or CV that wasn't measured on this machine.
- Where DuckDB beats TripGrid, the README says so and explains why.
