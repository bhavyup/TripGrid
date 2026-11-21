# TripGrid — Out-of-Core Analytics Engine

**Purpose.** A query engine that runs analytical queries over the NYC TLC Yellow Taxi
dataset — ~49M trips/year, ~1.5B rows across its full history — on a machine where the
data does not fit in RAM. Pandas/NumPy are the engine room: every kernel is vectorised
NumPy, Pandas appears only at the edges (small result frames, the baseline we benchmark
against). Built to roster standard: an engine with guarantees, measured.

**Working name:** TripGrid (rename freely). **Home:** `d:/codes/tripgrid` on the PC.

## The problem it solves

A year of TLC data is ~800 MB of Parquet that becomes several GB in memory. Naive
`pd.read_parquet` on multi-year data OOMs or swaps. TripGrid's contract:

1. **Memory ceiling is hard.** The engine runs under a configured RAM budget
   (default 2 GB) and never crosses it — it chunks, prunes and schedules instead.
2. **Results are provably right.** Every benchmark query is also run on DuckDB as the
   reference engine; TripGrid's output must match within float tolerance, or the
   benchmark fails. No fast-but-wrong numbers.
3. **Throughput is measured, not claimed.** Rows/sec and peak RSS are recorded per
   query, per engine (TripGrid / pandas / DuckDB), on identical hardware and data.

## Dataset

- Source: NYC TLC trip records (public domain), monthly Parquet files from the TLC
  CDN — e.g. `yellow_tripdata_2024-01.parquet` (~48 MB, ~3.0M trips).
- Working set: **2024 + 2025 first (~95M trips)**, then a 3-year scale run.
  Full history (2009–2025, ~1.5B rows) is the stretch goal.
- Schema drift is real (e.g. `cbd_congestion_fee` appears Jan 2025): ingestion
  normalises columns by name and records what it saw per file.

## Architecture

```
tripgrid/
  ingest/     downloader + partitioner + manifest
  engine/     kernels.py    vectorised filter / group-by / join / top-k (NumPy)
              executor.py   chunked execution, worker pool, memory budget
              query.py      declarative query spec -> execution plan
  bench/      benchmark harness (TripGrid vs pandas vs DuckDB) + correctness gate
  tests/      kernel unit tests; end-to-end correctness on one sampled month
  data/       raw/ (monthly files)  partitioned/ (engine layout)  [gitignored]
```

- **Partitioned layout.** Ingestion repartitions monthly files by pickup month ×
  borough into a local Parquet layout and writes a **manifest**: per-partition row
  counts and min/max stats per column.
- **Partition pruning.** The planner reads the manifest first and skips partitions
  that cannot match the query's filters — most queries should touch a fraction of
  the data.
- **Vectorised kernels.** Filter = boolean-mask kernels; group-by = sort-based
  segmented reduction and `np.bincount` for low-cardinality keys; join = hash join
  against the 265-row zone lookup; top-k = `np.argpartition`. No Python row loops
  anywhere in a hot path.
- **Executor.** Streams partitions in chunks sized to the memory budget, fans out
  across a multiprocessing pool, merges partial aggregates (sum/count merge
  trivially; mean via sum+count; percentiles documented as approximate or
  two-pass — a design decision to make explicitly, not stumble into).
- **Query layer.** A small declarative spec (filters, group-by keys, aggregations,
  top-k) — enough to express the benchmark suite, not a SQL parser.

## Benchmark suite (the proof)

Fixed query set, run identically on all three engines, same machine:

1. Trips per pickup zone per month (group-by, 2 keys).
2. Average fare and tip % by payment type, filtered to airport trips (filter + agg).
3. Top-20 drop-off zones for Friday-evening pickups in Manhattan (filter + join + top-k).
4. Fare distribution percentiles by trip-distance bucket (the hard one — forces the
   percentile design decision).
5. Full-year revenue rollup with every fee column (wide aggregation, no pruning).

Recorded per run: wall time, peak RSS, rows scanned vs rows pruned, and the
correctness verdict vs DuckDB. Results land in `bench/results/` as CSV + a chart.

## Milestones (one sitting each, roughly)

- **M0 — Scaffold + ingest.** Repo, downloader, manifest for 2024; one query
  end-to-end the naive pandas way (the baseline that later numbers beat).
- **M1 — Kernels + chunked executor.** Filter + group-by kernels over a full year
  under the 2 GB ceiling; unit tests green.
- **M2 — Pruning + parallelism + join/top-k.** Manifest-driven pruning, worker
  pool, zone join, queries 1–3 running as engine queries.
- **M3 — Benchmark + correctness gate.** Full suite vs pandas/DuckDB, 2024+2025
  (~95M rows), percentile design decision implemented for query 4.
- **M4 — Scale run + write-up.** 3-year run, README with measured results and the
  honest failure notes (where DuckDB wins, and why). CV bullet drafted from the
  measured numbers only.

## Stack

Python · NumPy · Pandas (edges + baseline) · PyArrow (Parquet IO) · DuckDB
(reference + benchmark only, never in the engine path) · PyTest · matplotlib
(bench charts). No other dependencies without a reason.

## Rules of the build

- Built *with* Bhavya, not for him: he directs design calls, reviews every module,
  and must be able to defend every line.
- No number goes in the README or CV that wasn't measured on this machine.
- Where DuckDB beats TripGrid, the README says so and explains why.
