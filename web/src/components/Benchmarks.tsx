import { useState } from "react";
import type { BenchSuite, LiveRun } from "../api";

const CEILING = 2048;

const QUERY_TITLES: Record<string, string> = {
  q1: "Trips per pickup zone, per month",
  q2: "Airport pickups — fare & tip by payment",
  q3: "Friday-evening Manhattan — top 20 drop-offs",
  q4: "Exact fare percentiles per borough",
};

/* The four explanations under Cold. To force a line to end at an
 * exact spot, put \n there — the page breaks exactly where the \n
 * sits, nowhere else. These notes print at full section width
 * (.bnote.lines), so a hand-set line stays on one line.
 * Inline formatting, same idea — wrap the words in markers:
 * **word** bold, *word* serif italic, __word__ underlined.
 * One style per word; markers don't nest. */
const NOTES: Record<string, string> = {
  q1: "TripGrid leads. The whole group-by is two counting passes over packed integer keys — no sorting, no hash table \nA C++ engine has nothing to beat it with here.",
  q2: "DuckDB leads, and this page says so. On a small, heavily filtered scan its C++ vectorised reader beats Python orchestration. TripGrid's answer is still exact and still under a third of the ceiling.",
  q3: "DuckDB leads again. Most of a year's rides start in Manhattan, so pruning can only soften this scan, not skip it — the honest cost of a row-at-a-time filter in Python.",
  q4: "The reason TripGrid exists. Exact percentiles from sparse fare tables, nothing sorted, nothing approximated — while DuckDB sorts the year in memory and breaks the 2 GB ceiling doing it.",
};

/** The one-line "why" per question, reused by the live notes. */
const WHY: Record<string, string> = {
  q1: "Two counting passes over packed integer keys leave a C++ engine nothing to beat here",
  q2: "On a small, heavily filtered scan, DuckDB's C++ vectorised reader beats Python orchestration",
  q3: "Most of a year's rides start in Manhattan, so pruning can only soften this scan, not skip it",
  q4: "Exact percentiles come from sparse fare tables, nothing sorted, nothing approximated — DuckDB has to sort the year in memory to answer at all",
};

const ENGINES: { id: string; label: string }[] = [
  { id: "tripgrid", label: "TripGrid" },
  { id: "duckdb", label: "DuckDB" },
  { id: "pandas", label: "pandas" },
];

const fmt = (n: number) => n.toLocaleString("en-US");

/** One line of note text with its inline formatting applied:
 * **bold**, *serif italic*, __underlined__. */
function richLine(line: string, keyBase: string) {
  const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*|__[^_]+__)/g);
  return parts.map((p, i) => {
    const k = `${keyBase}-${i}`;
    if (p.length > 4 && p.startsWith("**") && p.endsWith("**")) {
      return (
        <strong className="nbold" key={k}>
          {p.slice(2, -2)}
        </strong>
      );
    }
    if (p.length > 4 && p.startsWith("__") && p.endsWith("__")) {
      return (
        <span className="nunder" key={k}>
          {p.slice(2, -2)}
        </span>
      );
    }
    if (p.length > 2 && p.startsWith("*") && p.endsWith("*")) {
      return (
        <em className="nital" key={k}>
          {p.slice(1, -1)}
        </em>
      );
    }
    return p;
  });
}

/** Renders note text with hard line breaks: every \n in the
 * string becomes the start of a new printed line. */
function NoteText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <span className="nline" key={i}>
          {richLine(line, `l${i}`)}
        </span>
      ))}
    </>
  );
}

/** One engine's line in a chart. Undefined numbers render as an
 * empty bar and an em dash — a run that hasn't happened yet. */
interface Row {
  id: string;
  label: string;
  wall?: number;
  peak?: number;
}

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
        <ColdView suite={suite} />
      ) : (
        <LiveView suite={suite} runs={live[year] ?? {}} />
      )}
    </div>
  );
}

function Charts({ rows }: { rows: Row[] }) {
  const walls = rows.map((r) => r.wall).filter((v): v is number => v !== undefined);
  const peaks = rows.map((r) => r.peak).filter((v): v is number => v !== undefined);
  const maxTime = walls.length ? Math.max(...walls) : 1;
  const maxMem = Math.max(CEILING, ...peaks) * 1.06;
  // Gold is earned per chart: the lowest present value wins it.
  // A missing value (a live run that hasn't happened) never can.
  const minWall = walls.length ? Math.min(...walls) : Infinity;
  const minPeak = peaks.length ? Math.min(...peaks) : Infinity;
  return (
    <div className="bcharts">
      <div className="bchart">
        <span className="label">Wall time — seconds, lower wins</span>
        {rows.map((r) => (
          <div
            className={`brow${r.wall !== undefined && r.wall === minWall ? " win" : ""}`}
            key={r.id}
          >
            <div className="eng">{r.label}</div>
            <div className="track">
              <div
                className="fill"
                style={{ width: r.wall !== undefined ? `${(r.wall / maxTime) * 100}%` : "0%" }}
              />
            </div>
            <div className="val">{r.wall !== undefined ? `${r.wall.toFixed(2)}s` : "—"}</div>
          </div>
        ))}
      </div>
      <div className="bchart">
        <span className="label">Peak memory — MB, ceiling 2,048</span>
        {rows.map((r) => {
          const over = r.peak !== undefined && r.peak > CEILING;
          return (
            <div
              className={`brow${r.peak !== undefined && r.peak === minPeak ? " win" : ""}`}
              key={r.id}
            >
              <div className="eng">{r.label}</div>
              <div className="track">
                <div
                  className={`fill${over ? " over" : ""}`}
                  style={{ width: r.peak !== undefined ? `${(r.peak / maxMem) * 100}%` : "0%" }}
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
                {r.peak !== undefined ? (
                  <>
                    {Math.round(r.peak).toLocaleString("en-US")}
                    {over && <span className="over-tag">Over ceiling</span>}
                  </>
                ) : (
                  "—"
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ColdView({ suite }: { suite: BenchSuite | undefined }) {
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
        const rows: Row[] = ENGINES.map((e) => {
          const run = suite.runs[`${e.id}/${q}`];
          return {
            id: e.id,
            label: e.label,
            wall: run?.wall_seconds,
            peak: run?.peak_rss_mb,
          };
        });
        if (rows.every((r) => r.wall === undefined)) return null;
        const gate = suite.gates_vs_duckdb[`tripgrid/${q}`];
        return (
          <div className="bquery" key={q}>
            <div className="bquery-head">
              <span className="bq">{q.toUpperCase()}</span>
              <h3>{QUERY_TITLES[q]}</h3>
              <span className="headtags">
                {gate !== undefined && (
                  <span className="gate">
                    DuckDB correctness gate — {gate ? "Pass" : "Fail"}
                  </span>
                )}
              </span>
            </div>
            <p className="bnote lines">
              <NoteText text={NOTES[q]} />
            </p>
            <Charts rows={rows} />
          </div>
        );
      })}
    </div>
  );
}

/** Who won the live comparison, why, and what the warm server
 * did to the number — written from the actual figures. */
function liveNote(
  q: string,
  live: LiveRun | undefined,
  tgCold: number | undefined,
  ddCold: number | undefined,
): string {
  if (!live) {
    return "Not run live yet — DuckDB and pandas are showing their cold times as the reference. Run this question in the console and TripGrid's line fills in with its warm-server time.";
  }
  if (tgCold === undefined || ddCold === undefined) return NOTES[q];
  const tg = live.wall_seconds.toFixed(2);
  const gap =
    live.wall_seconds < tgCold
      ? `The warm server shaved it from ${tgCold.toFixed(2)}s cold to ${tg}s`
      : `This run came in slower than TripGrid's own ${tgCold.toFixed(2)}s cold time — a single live run carries the machine's mood with it`;
  const scanned = `It scanned ${fmt(live.rows_scanned)} rows in ${live.files_read} files.`;
  if (live.wall_seconds < ddCold) {
    return `On the warm server, TripGrid takes this one — ${tg}s live against DuckDB's cold ${ddCold.toFixed(2)}s. ${WHY[q]}. ${gap}, though the cold race stays the fair comparison. ${scanned}`;
  }
  return `DuckDB keeps this one even against the warm server — ${ddCold.toFixed(2)}s cold against TripGrid's ${tg}s live. ${WHY[q]}. ${gap}. ${scanned}`;
}

function LiveView({
  suite,
  runs,
}: {
  suite: BenchSuite | undefined;
  runs: Record<string, LiveRun>;
}) {
  if (!suite) {
    return <p className="bnote">Benchmark results have not been generated on this machine yet.</p>;
  }
  return (
    <div>
      <p className="bnote mode-note">
        Live — the same charts, but TripGrid&rsquo;s line is the latest real run on this
        warm server. DuckDB and pandas keep their cold times as the reference, peak
        memory for a live run is the whole server&rsquo;s, and answers served from the
        cache don&rsquo;t count — only genuine executions land here.
      </p>
      {["q1", "q2", "q3", "q4"].map((q) => {
        const live = runs[q];
        const rows: Row[] = ENGINES.map((e) => {
          if (e.id === "tripgrid") {
            return {
              id: e.id,
              label: e.label,
              wall: live?.wall_seconds,
              peak: live?.peak_rss_mb,
            };
          }
          const run = suite.runs[`${e.id}/${q}`];
          return {
            id: e.id,
            label: e.label,
            wall: run?.wall_seconds,
            peak: run?.peak_rss_mb,
          };
        });
        const gate = suite.gates_vs_duckdb[`tripgrid/${q}`];
        const when =
          live &&
          new Date(live.last_run_at).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          });
        return (
          <div className="bquery" key={q}>
            <div className="bquery-head">
              <span className="bq">{q.toUpperCase()}</span>
              <h3>{QUERY_TITLES[q]}</h3>
              <span className="headtags">
                {live && (
                  <span className="livemeta">
                    {live.runs} live run{live.runs === 1 ? "" : "s"} · latest {when}
                  </span>
                )}
                {gate !== undefined && (
                  <span className="gate">
                    DuckDB correctness gate — {gate ? "Pass" : "Fail"}
                  </span>
                )}
              </span>
            </div>
            <p className="bnote">
              {liveNote(
                q,
                live,
                suite.runs[`tripgrid/${q}`]?.wall_seconds,
                suite.runs[`duckdb/${q}`]?.wall_seconds,
              )}
            </p>
            <Charts rows={rows} />
          </div>
        );
      })}
    </div>
  );
}
