import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchBenchmarks,
  fetchBuilder,
  fetchLive,
  fetchMeta,
  fetchPresets,
  fetchZones,
  runPreset,
  runSpec,
  validateSpec,
  type BenchSuite,
  type BuilderCatalogue,
  type LiveRun,
  type Meta,
  type PresetInfo,
  type SpecDict,
  type SpecJobPayload,
  type ValidateResult,
  type ZoneMap,
} from "./api";
import {
  DEFAULT_DRAFT,
  type BuilderDraft,
} from "./components/BuilderPanel";
import InstrumentConsole from "./components/InstrumentConsole";
import Benchmarks from "./components/Benchmarks";
import { useInView } from "./utils/motion";

const fmt = (n: number) => n.toLocaleString("en-US");

export default function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [zones, setZones] = useState<ZoneMap>({});
  const [suites, setSuites] = useState<Record<string, BenchSuite>>({});
  const [live, setLive] = useState<Record<string, Record<string, LiveRun>>>({});
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [catalogue, setCatalogue] = useState<BuilderCatalogue | null>(null);

  const [mode, setMode] = useState<"presets" | "builder">("presets");
  const [presetId, setPresetId] = useState("congestion_verdict");
  const [range, setRange] = useState<[string, string] | null>(null);
  const [draft, setDraft] = useState<BuilderDraft>({ ...DEFAULT_DRAFT });
  const [gate, setGate] = useState<ValidateResult | null>(null);
  const [running, setRunning] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [filesDone, setFilesDone] = useState(0);
  const [filesTotal, setFilesTotal] = useState(0);
  const [status, setStatus] = useState("Idle — pick a question and run it");
  const [payload, setPayload] = useState<SpecJobPayload | null>(null);
  const cacheRef = useRef(new Map<string, SpecJobPayload>());
  const methodRef = useRef<HTMLDivElement>(null);
  const methodInView = useInView(methodRef, 0.14);

  const refreshLive = useCallback(() => {
    fetchLive().then(setLive).catch(() => undefined);
  }, []);

  useEffect(() => {
    fetchMeta().then(setMeta).catch(() => undefined);
    fetchZones().then(setZones).catch(() => undefined);
    fetchBenchmarks().then(setSuites).catch(() => undefined);
    fetchPresets().then(setPresets).catch(() => undefined);
    fetchBuilder().then(setCatalogue).catch(() => undefined);
    refreshLive();
  }, [refreshLive]);

  const activePreset = presets.find((p) => p.id === presetId);
  const isAudit = mode === "presets" && activePreset?.kind === "audit";

  /** The recipe the current controls describe — a preset with the
   * map's range laid over it, or the builder's draft. The audit
   * has no single recipe (four small counts), so it has none. */
  const effectiveSpec: SpecDict | null = useMemo(() => {
    if (mode === "builder") {
      return {
        range: range ?? "all",
        measures: draft.measures,
        dimensions: draft.dimensions,
        filters: draft.filters,
        top_k: draft.top_k,
        sort: draft.sort,
      };
    }
    if (!activePreset || isAudit || !activePreset.spec) return null;
    return { ...activePreset.spec, range: range ?? activePreset.spec.range };
  }, [mode, draft, range, activePreset, isAudit]);

  const signature =
    mode === "builder"
      ? `spec:${JSON.stringify(effectiveSpec)}`
      : `preset:${presetId}:${range ? range.join("..") : "default"}`;

  // Price the current recipe as the controls move — the gate meter
  // in the command bar reflects this verdict live.
  useEffect(() => {
    if (!effectiveSpec) {
      setGate(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      validateSpec(effectiveSpec)
        .then((g) => {
          if (alive) setGate(g);
        })
        .catch(() => undefined);
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [effectiveSpec]);

  // Show a remembered answer instantly when switching back.
  useEffect(() => {
    const remembered = cacheRef.current.get(signature);
    setPayload(remembered ?? null);
    setFilesDone(remembered ? (remembered.stats.files_read ?? 0) : 0);
    setFilesTotal(remembered ? remembered.stats.partitions_selected : 0);
    setStatus(
      remembered
        ? "Answered from memory — the engine keeps recent answers"
        : "Idle — pick a question and run it",
    );
  }, [signature]);

  const run = useCallback(async () => {
    if (running) return;
    if (mode === "presets" && !activePreset) return;
    if (mode === "builder" && !effectiveSpec) return;
    if (!isAudit && gate && !gate.ok) return;
    setRunning(true);
    setPayload(null);
    setFilesDone(0);
    setFilesTotal(0);
    setStatus("Reading — the engine is scanning the selected files");
    const prog = (done: number, total: number) => {
      setFilesDone(done);
      setFilesTotal(total);
    };
    try {
      const result =
        mode === "builder"
          ? await runSpec(effectiveSpec as SpecDict, prog, fresh)
          : await runPreset(presetId, isAudit ? null : range, prog, fresh);
      cacheRef.current.set(signature, result);
      setPayload(result);
      // A real preset execution may have landed in the Evidence
      // section's Live view (the four original questions, run over
      // exactly one year, count as live runs there).
      if (!result.cached && mode === "presets") refreshLive();
      setFilesDone(result.stats.files_read ?? 0);
      setFilesTotal(result.stats.partitions_selected);
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
  }, [running, mode, activePreset, effectiveSpec, gate, presetId, isAudit, range, fresh, signature, refreshLive]);

  const freshness = meta?.freshness;
  const freshnessLine = !freshness
    ? null
    : freshness.error
      ? "Freshness — the last check could not reach the city feed"
      : freshness.checked_at
        ? `Freshness — checked ${new Date(freshness.checked_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })} · ${
            freshness.updated && freshness.updated.length > 0
              ? `${freshness.updated.length} month${freshness.updated.length > 1 ? "s" : ""} brought up to date`
              : "archive up to date"
          }`
        : null;

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
        <div className="topmeta">
          NYC TLC Yellow — {meta ? `${meta.years[0]} / ${meta.years[meta.years.length - 1]}` : "2017 / 2026"}
        </div>
      </header>

      {/* ---------- hero ---------- */}
      <div className="hero">
        <p className="label" style={{ marginBottom: 22 }}>
          An out-of-core analytical engine — New York City taxi trips
        </p>
        <div className="hero-grid">
          <h1 className="display">
            Half a billion
            <br />
            trips.
            <br />
            <span className="serif-i">
              2 GB <span className="amber">Memory</span>,
            </span>
            <br />
            <span className="hl">zero</span> approximation.
          </h1>
          <aside className="hero-side">
            <span className="label">What this is</span>
            <p>
              TripGrid answers questions over <strong>half a billion taxi trips</strong> —
              every yellow-cab ride the city has published since 2017 — while never
              holding more than <strong>2 GB in memory</strong>, a ceiling a standard
              engine breaks on the hardest question. Every answer is{" "}
              <strong>checked against DuckDB</strong> before it is believed, and where
              DuckDB is faster, this page says so.
            </p>
          </aside>
        </div>
        <div className="statstrip">
          <div className="stat">
            <span className="label">Trips indexed</span>
            <div className="v">{meta ? fmt(meta.total_rows) : "—"}</div>
          </div>
          <div className="stat">
            <span className="label">Partitions</span>
            <div className="v">{meta ? `${meta.partitions} files` : "—"}</div>
          </div>
          <div className="stat">
            <span className="label">Memory ceiling</span>
            <div className="v">2,048 MB</div>
          </div>
          <div className="stat">
            <span className="label">Preset questions</span>
            <div className="v">{presets.length || 11}</div>
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

        <InstrumentConsole
          meta={meta}
          zones={zones}
          presets={presets}
          catalogue={catalogue}
          mode={mode}
          onModeChange={setMode}
          presetId={presetId}
          onSelectPreset={setPresetId}
          range={range}
          onRangeChange={setRange}
          draft={draft}
          onDraftChange={setDraft}
          effectiveSpec={effectiveSpec}
          gate={gate}
          running={running}
          fresh={fresh}
          onToggleFresh={() => setFresh((f) => !f)}
          filesDone={filesDone}
          filesTotal={filesTotal}
          status={status}
          payload={payload}
          onRun={run}
        />
      </section>

      {/* ---------- benchmarks ---------- */}
      <section id="evidence">
        <div className="section-head">
          <span className="idx">02</span>
          <h2>The Evidence</h2>
          <div className="rule" />
          <span className="tail">TripGrid vs DuckDB vs pandas — same files, same machine</span>
        </div>
        <Benchmarks suites={suites} live={live} onShowLive={refreshLive} />
      </section>

      {/* ---------- method ---------- */}
      <section id="method">
        <div className="section-head">
          <span className="idx">03</span>
          <h2>The Method</h2>
          <div className="rule" />
          <span className="tail">Four moves, no magic</span>
        </div>
        <div ref={methodRef} className={`steps steps-motion${methodInView ? " in" : ""}`}>
          <div className="step">
            <span className="n">STEP — 01</span>
            <h3>Partition</h3>
            <p>
              Every month of trips the city publishes is cut into files by pickup
              borough, in a slim exact format, with a small index recording each
              file's row count and fare range. Nothing is ever loaded whole.
            </p>
          </div>
          <div className="step">
            <span className="n">STEP — 02</span>
            <h3>Prune</h3>
            <p>
              Before reading a single row, the planner consults only the index and crosses
              out every file the question cannot need. Most questions never open most of
              the city.
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
        {meta && (
          <span className="label">
            Archive — {(meta.archive_bytes / 1e9).toFixed(1)} GB on disk ·{" "}
            {fmt(meta.total_rows)} trips · {meta.months[0]} → {meta.newest_month} ·
            grows ≈ 0.5 GB a year
          </span>
        )}
        {freshnessLine && <span className="label">{freshnessLine}</span>}
      </footer>
    </div>
  );
}
