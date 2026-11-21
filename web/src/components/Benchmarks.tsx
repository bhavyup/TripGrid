import { useState } from "react";
import type { BenchSuite } from "../api";

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

interface Props {
  suites: Record<string, BenchSuite>;
}

export default function Benchmarks({ suites }: Props) {
  const years = Object.keys(suites).sort();
  const [year, setYear] = useState(years[years.length - 1] ?? "");
  const suite = suites[year];
  if (!suite) {
    return <p className="bnote">Benchmark results have not been generated on this machine yet.</p>;
  }

  return (
    <div>
      <div className="btabs">
        {years.map((y) => (
          <button key={y} className={y === year ? "on" : ""} onClick={() => setYear(y)}>
            {y}
          </button>
        ))}
      </div>

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
