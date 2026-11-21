import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchBenchmarks,
  fetchMeta,
  fetchPlan,
  fetchZones,
  runQuery,
  type BenchSuite,
  type JobPayload,
  type Meta,
  type Plan,
  type ZoneMap,
} from "./api";
import PartitionGrid from "./components/PartitionGrid";
import Results from "./components/Results";
import Benchmarks from "./components/Benchmarks";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [zones, setZones] = useState<ZoneMap>({});
  const [suites, setSuites] = useState<Record<string, BenchSuite>>({});
  const [query, setQuery] = useState("q3");
  const [year, setYear] = useState(2025);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [running, setRunning] = useState(false);
  const [filesDone, setFilesDone] = useState(0);
  const [status, setStatus] = useState("Idle — pick a question and run it");
  const [payload, setPayload] = useState<JobPayload | null>(null);
  const cacheRef = useRef(new Map<string, JobPayload>());

  useEffect(() => {
    fetchMeta().then(setMeta).catch(() => undefined);
    fetchZones().then(setZones).catch(() => undefined);
    fetchBenchmarks().then(setSuites).catch(() => undefined);
  }, []);

  useEffect(() => {
    let live = true;
    setPlan(null);
    fetchPlan(query, year)
      .then((p) => {
        if (live) setPlan(p);
      })
      .catch(() => undefined);
    // Show a remembered answer instantly when switching back.
    const remembered = cacheRef.current.get(`${query}:${year}`);
    setPayload(remembered ?? null);
    setFilesDone(remembered ? (remembered.stats.files_read ?? 0) : 0);
    setStatus(
      remembered
        ? "Answered from memory — the engine keeps recent answers"
        : "Idle — pick a question and run it",
    );
    return () => {
      live = false;
    };
  }, [query, year]);

  const run = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setPayload(null);
    setFilesDone(0);
    setStatus("Reading — the engine is scanning the selected files");
    try {
      const result = await runQuery(query, year, (done) => setFilesDone(done));
      cacheRef.current.set(`${query}:${year}`, result);
      setPayload(result);
      setFilesDone(result.stats.files_read ?? 0);
      setStatus(
        result.cached
          ? "Answered from memory — no file was re-read"
          : `Done — ${fmt(result.stats.rows_scanned)} rows scanned in ${result.stats.wall_seconds.toFixed(2)}s`,
      );
    } catch (err) {
      setStatus(`Failed — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  }, [query, year, running]);

  const stats = payload?.stats;
  const queries = meta?.queries ?? [];
  const activeQuery = queries.find((q) => q.id === query);

  return (
    <div className="frame">
      {/* ---------- top bar ---------- */}
      <header className="topbar">
        <div className="brand">
          TRIPGRID<sup>EST. 2026</sup>
        </div>
        <nav className="navlinks">
          <a href="#console">Console</a>
          <a href="#evidence">Evidence</a>
          <a href="#method">Method</a>
        </nav>
        <div className="topmeta">NYC TLC Yellow — 2024 / 2025</div>
      </header>

      {/* ---------- hero ---------- */}
      <div className="hero">
        <p className="label" style={{ marginBottom: 22 }}>
          An out-of-core analytical engine — New York City taxi trips
        </p>
        <div className="hero-grid">
          <h1 className="display">
            Ninety million
            <br />
            trips.
            <br />
            <span className="serif-i">
              2 GB <span className="hl">Memory</span>,
            </span>
            <br />
            <span className="amber">zero</span> approximation.
          </h1>
          <aside className="hero-side">
            <span className="label">What this is</span>
            <p>
              TripGrid answers questions over <strong>89.9 million taxi trips</strong> while
              never holding more than <strong>2 GB in memory</strong> — a ceiling a standard
              engine breaks on the hardest question. Every answer is{" "}
              <strong>checked against DuckDB</strong> before it is believed, and where DuckDB
              is faster, this page says so.
            </p>
          </aside>
        </div>
        <div className="statstrip">
          <div className="stat">
            <span className="label">Trips indexed</span>
            <div className="v">{meta ? fmt(meta.total_rows) : "89,891,688"}</div>
          </div>
          <div className="stat">
            <span className="label">Partitions</span>
            <div className="v">{meta ? meta.partitions : 192} files</div>
          </div>
          <div className="stat">
            <span className="label">Memory ceiling</span>
            <div className="v">2,048 MB</div>
          </div>
          <div className="stat">
            <span className="label">Questions</span>
            <div className="v">04</div>
          </div>
          <div className="stat">
            <span className="label">Engines raced</span>
            <div className="v">03</div>
          </div>
        </div>
      </div>

      {/* ---------- console ---------- */}
      <section id="console">
        <div className="section-head">
          <span className="idx">01</span>
          <h2>The Instrument</h2>
          <div className="rule" />
          <span className="tail">Ask — watch it read — believe the receipt</span>
        </div>

        <div className="console">
          <div>
            <div className="qlist">
              {queries.map((q, i) => (
                <button
                  key={q.id}
                  className={`qitem${q.id === query ? " active" : ""}`}
                  onClick={() => setQuery(q.id)}
                >
                  <span className="qnum">{String(i + 1).padStart(2, "0")}</span>
                  <span>
                    <span className="qtitle">{q.title}</span>
                    <span className="qdesc" style={{ display: "block" }}>
                      {q.description}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            <div className="rail-block">
              <span className="label">Year</span>
              <div className="yearseg">
                {(meta?.years ?? [2024, 2025]).map((y) => (
                  <button key={y} className={y === year ? "on" : ""} onClick={() => setYear(y)}>
                    {y}
                  </button>
                ))}
              </div>
            </div>

            <button className="runbtn" onClick={run} disabled={running}>
              {running ? "Reading…" : "Run the question"}
            </button>
            <p className="runstatus">
              {running && <span className="dot" />}
              {status}
            </p>
            {plan && (
              <p className="runstatus" style={{ color: "var(--bone-faint)" }}>
                Plan — reads {plan.stats.partitions_selected} of {plan.stats.partitions_total}{" "}
                files · skips {fmt(plan.stats.rows_total - plan.stats.rows_selected)} rows
                without opening them
              </p>
            )}
          </div>

          <div className="stage">
            <PartitionGrid plan={plan} year={year} filesDone={filesDone} running={running} />
            <div className="runstats">
              <div className="stat">
                <span className="label">Wall time</span>
                <div className="v">{stats ? `${stats.wall_seconds.toFixed(2)}s` : "—"}</div>
              </div>
              <div className="stat">
                <span className="label">Peak memory</span>
                <div className="v">{stats ? `${Math.round(stats.peak_rss_mb)} MB` : "—"}</div>
                <div className="gauge">
                  <div
                    className="fill"
                    style={{ width: stats ? `${(stats.peak_rss_mb / 2048) * 100}%` : "0%" }}
                  />
                  <div className="ceil" />
                </div>
              </div>
              <div className="stat">
                <span className="label">Rows scanned</span>
                <div className="v">{stats ? fmt(stats.rows_scanned) : "—"}</div>
              </div>
              <div className="stat">
                <span className="label">Files read</span>
                <div className="v">
                  {running
                    ? `${filesDone} / ${plan?.stats.partitions_selected ?? "—"}`
                    : stats
                      ? `${stats.files_read} / ${stats.partitions_selected}`
                      : "—"}
                </div>
              </div>
              <div className="stat">
                <span className="label">Throughput</span>
                <div className="v">
                  {stats && stats.wall_seconds > 0
                    ? `${(stats.rows_scanned / stats.wall_seconds / 1_000_000).toFixed(1)}M /s`
                    : "—"}
                </div>
              </div>
            </div>

            {payload && activeQuery && (
              <div className="result">
                <div className="result-head">
                  <span className="idx mono" style={{ color: "var(--amber)", fontSize: 12 }}>
                    {query.toUpperCase()}
                  </span>
                  <h3>{activeQuery.title}</h3>
                  {payload.cached && <span className="fromcache">From memory</span>}
                </div>
                <Results payload={payload} zones={zones} />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ---------- benchmarks ---------- */}
      <section id="evidence">
        <div className="section-head">
          <span className="idx">02</span>
          <h2>The Evidence</h2>
          <div className="rule" />
          <span className="tail">TripGrid vs DuckDB vs pandas — same files, same machine</span>
        </div>
        <Benchmarks suites={suites} />
      </section>

      {/* ---------- method ---------- */}
      <section id="method">
        <div className="section-head">
          <span className="idx">03</span>
          <h2>The Method</h2>
          <div className="rule" />
          <span className="tail">Four moves, no magic</span>
        </div>
        <div className="steps">
          <div className="step">
            <span className="n">STEP — 01</span>
            <h3>Partition</h3>
            <p>
              Two years of trips are cut into 192 files by month and pickup borough, with a
              small index recording each file's size and shape. Nothing is ever loaded whole.
            </p>
          </div>
          <div className="step">
            <span className="n">STEP — 02</span>
            <h3>Prune</h3>
            <p>
              Before reading a single row, the planner consults only the index and crosses
              out every file the question cannot need. Most questions never open most of the
              city.
            </p>
          </div>
          <div className="step">
            <span className="n">STEP — 03</span>
            <h3>Compute</h3>
            <p>
              Surviving files stream through counting kernels in quarter-million-row
              batches across eight threads — group-bys as single counting passes over
              packed integer keys, percentiles from sparse fare tables. Exact, always.
            </p>
          </div>
          <div className="step">
            <span className="n">STEP — 04</span>
            <h3>Prove</h3>
            <p>
              Every answer is re-derived by DuckDB from the same files and compared, digit
              by digit. A benchmark suite re-races all three engines on every change. If the
              numbers disagree, the answer does not ship.
            </p>
          </div>
        </div>
      </section>

      <footer className="footer">
        <span className="label">TripGrid — an engine that answers to a ceiling</span>
        <span className="label">Data — NYC TLC Yellow Taxi trip records, public</span>
        <span className="label">Designed & built by Bhavya Upreti — measured, not claimed</span>
      </footer>
    </div>
  );
}
