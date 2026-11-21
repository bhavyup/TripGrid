import { useState } from "react";
import type { BenchSuite, LiveRun } from "../api";

const CEILING = 2048;

const QUERY_TITLES: Record<string, string> = {
  q1: "Trips per pickup zone, per month",
  q2: "Airport pickups — fare & tip by payment",
  q3: "Friday-evening Manhattan — top 20 drop-offs",
  q4: "Exact fare percentiles per borough",
};

const NOTES: Record<string, string> = {
  q1: "TripGrid leads. The whole group-by is two counting passes over packed integer keys — no sorting, no hash table — so a C++ engine has nothing to beat it with here.",
  q2: "DuckDB leads, and this page says so. On a small, heavily filtered scan its C++ vectorised reader beats Python orchestration. TripGrid's answer is still exact and still under a third of the ceiling.",
  q3: "DuckDB leads again. Most of a year's rides start in Manhattan, so pruning can only soften this scan, not skip it — the honest cost of a row-at-a-time filter in Python.",
  q4: "The reason TripGrid exists. Exact percentiles from sparse fare tables, nothing sorted, nothing approximated — while DuckDB sorts the year in memory and breaks the 2 GB ceiling doing it.",
};

const ENGINES: { id: string; label: string; us?: boolean }[] = [
  { id: "tripgrid", label: "TripGrid", us: true },
  { id: "duckdb", label: "DuckDB" },
  { id: "pandas", label: "pandas" },
];

const fmt = (n: number) => n.toLocaleString("en-US");

interface Props {
  suites: Record<string, BenchSuite>;
  live: Record<string, Record<string, LiveRun>>;
  onShowLive: () => void;
}

export default function Benchmarks({ suites, live, onShowLive }: Props) {
  const years = [...new Set([...Object.keys(suites), ...Object.keys(live)])].sort();
  const [picked, setYear] = useState("");
  const [mode, setMode] = useState<"cold" | "live">("cold");
  // The suites arrive after first render, so the picked year must
  // fall back to the latest available until the user chooses one.
  const year = picked && years.includes(picked) ? picked : (years[years.length - 1] ?? "");
  const suite = suites[year];

  const pickMode = (m: "cold" | "live") => {
    setMode(m);
    if (m === "live") onShowLive();
  };

  return (
    <div>
      <div className="btabs-row">
        <div className="btabs">
          {years.map((y) => (
            <button key={y} className={y === year ? "on" : ""} onClick={() => setYear(y)}>
              {y}
            </button>
          ))}
        </div>
        <div className="btabs">
          <button className={mode === "cold" ? "on" : ""} onClick={() => pickMode("cold")}>
            Cold
          </button>
          <button className={mode === "live" ? "on" : ""} onClick={() => pickMode("live")}>
            Live
          </button>
        </div>
      </div>

      {mode === "cold" ? (
        <ColdView suite={suite} year={year} suites={suites} />
      ) : (
        <LiveView runs={live[year] ?? {}} year={year} />
      )}
    </div>
  );
}

function ColdView({
  suite,
  year,
  suites,
}: {
  suite: BenchSuite | undefined;
  year: string;
  suites: Record<string, BenchSuite>;
}) {
  if (!suite) {
    return <p className="bnote">Benchmark results have not been generated on this machine yet.</p>;
  }
  return (
    <div>
      <p className="bnote mode-note">
        Cold — every engine alone in a fresh process, started from zero, same files, same
        machine. The fair race.
      </p>
      {["q1", "q2", "q3", "q4"].map((q) => {
        const runs = ENGINES.map((e) => suites[year].runs[`${e.id}/${q}`]).filter(Boolean);
        if (runs.length === 0) return null;
        const maxTime = Math.max(...runs.map((r) => r.wall_seconds));
        const maxMem = Math.max(CEILING, ...runs.map((r) => r.peak_rss_mb)) * 1.06;
        const gate = suites[year].gates_vs_duckdb[`tripgrid/${q}`];
        return (
          <div className="bquery" key={q}>
            <div className="bquery-head">
              <span className="bq">{q.toUpperCase()}</span>
              <h3>{QUERY_TITLES[q]}</h3>
              {gate !== undefined && (
                <span className="gate">DuckDB correctness gate — {gate ? "Pass" : "Fail"}</span>
              )}
            </div>
            <p className="bnote">{NOTES[q]}</p>
            <div className="bcharts">
              <div className="bchart">
                <span className="label">Wall time — seconds, lower wins</span>
                {ENGINES.map((e) => {
                  const run = suites[year].runs[`${e.id}/${q}`];
                  if (!run) return null;
                  return (
                    <div className={`brow${e.us ? " us" : ""}`} key={e.id}>
                      <div className="eng">{e.label}</div>
                      <div className="track">
                        <div
                          className="fill"
                          style={{ width: `${(run.wall_seconds / maxTime) * 100}%` }}
                        />
                      </div>
                      <div className="val">{run.wall_seconds.toFixed(2)}s</div>
                    </div>
                  );
                })}
              </div>
              <div className="bchart">
                <span className="label">Peak memory — MB, ceiling 2,048</span>
                {ENGINES.map((e) => {
                  const run = suites[year].runs[`${e.id}/${q}`];
                  if (!run) return null;
                  const over = run.peak_rss_mb > CEILING;
                  return (
                    <div className={`brow${e.us ? " us" : ""}`} key={e.id}>
                      <div className="eng">{e.label}</div>
                      <div className="track">
                        <div
                          className={`fill${over ? " over" : ""}`}
                          style={{ width: `${(run.peak_rss_mb / maxMem) * 100}%` }}
                        />
                        <div
                          style={{
                            position: "absolute",
                            top: -3,
                            bottom: -3,
                            width: 1,
                            background: "var(--bone)",
                            opacity: 0.6,
                            left: `${(CEILING / maxMem) * 100}%`,
                          }}
                        />
                      </div>
                      <div className="val">
                        {Math.round(run.peak_rss_mb).toLocaleString("en-US")}
                        {over && <span className="over-tag">Over ceiling</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function LiveView({ runs, year }: { runs: Record<string, LiveRun>; year: string }) {
  const present = ["q1", "q2", "q3", "q4"].filter((q) => runs[q]);
  return (
    <div>
      <p className="bnote mode-note">
        Live — real runs on this warm server, recorded as they happen. Peak memory is the
        whole server&rsquo;s, not the engine alone, and answers served from the cache
        don&rsquo;t count — only genuine executions land here.
      </p>
      {present.length === 0 && (
        <p className="bnote">
          No live runs for {year} yet. Run a question in the console above and it appears
          here the moment it finishes.
        </p>
      )}
      {present.map((q) => {
        const run = runs[q];
        const maxTime = Math.max(...present.map((k) => runs[k].wall_seconds));
        const maxMem = Math.max(CEILING, run.peak_rss_mb) * 1.06;
        const over = run.peak_rss_mb > CEILING;
        const when = new Date(run.last_run_at).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        return (
          <div className="bquery" key={q}>
            <div className="bquery-head">
              <span className="bq">{q.toUpperCase()}</span>
              <h3>{QUERY_TITLES[q]}</h3>
              <span className="livemeta">
                {run.runs} live run{run.runs === 1 ? "" : "s"} · latest {when}
              </span>
            </div>
            <p className="bnote">
              Latest run scanned {fmt(run.rows_scanned)} rows in {run.files_read} files.
            </p>
            <div className="bcharts">
              <div className="bchart">
                <span className="label">Wall time — seconds, lower wins</span>
                <div className="brow us">
                  <div className="eng">TripGrid</div>
                  <div className="track">
                    <div
                      className="fill"
                      style={{ width: `${(run.wall_seconds / maxTime) * 100}%` }}
                    />
                  </div>
                  <div className="val">{run.wall_seconds.toFixed(2)}s</div>
                </div>
              </div>
              <div className="bchart">
                <span className="label">Peak memory — MB, ceiling 2,048</span>
                <div className="brow us">
                  <div className="eng">TripGrid</div>
                  <div className="track">
                    <div
                      className={`fill${over ? " over" : ""}`}
                      style={{ width: `${(run.peak_rss_mb / maxMem) * 100}%` }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        top: -3,
                        bottom: -3,
                        width: 1,
                        background: "var(--bone)",
                        opacity: 0.6,
                        left: `${(CEILING / maxMem) * 100}%`,
                      }}
                    />
                  </div>
                  <div className="val">
                    {Math.round(run.peak_rss_mb).toLocaleString("en-US")}
                    {over && <span className="over-tag">Over ceiling</span>}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
