import type { Plan } from "../api";

const BOROUGHS = [
  "Manhattan",
  "Brooklyn",
  "Queens",
  "Bronx",
  "Staten Island",
  "EWR",
  "N-A",
  "Unknown",
];

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

interface Props {
  plan: Plan | null;
  year: number;
  filesDone: number;
  running: boolean;
}

/**
 * The partition map: one cell per data file (month × borough).
 * Amber intensity is proportional to the file's row count. Files
 * the planner skips are struck through; during a run, files flip
 * to solid amber as they finish reading.
 */
export default function PartitionGrid({ plan, year, filesDone, running }: Props) {
  const byKey = new Map<string, { rows: number; selected: boolean }>();
  let maxRows = 1;
  if (plan) {
    for (const p of plan.partitions) {
      byKey.set(`${p.month}|${p.borough}`, { rows: p.rows, selected: p.selected });
      if (p.selected && p.rows > maxRows) maxRows = p.rows;
    }
  }
  // Reading order = render order of the selected cells.
  let selectedSeen = 0;
  const cellFor = (monthIdx: number, borough: string) => {
    const month = `${year}-${String(monthIdx + 1).padStart(2, "0")}`;
    const cell = byKey.get(`${month}|${borough}`);
    if (!cell) return <div className="cell" key={month} style={{ opacity: 0.25 }} />;
    if (!cell.selected) {
      return <div className="cell pruned" key={month} title={`${borough} ${month} — skipped by the planner`} />;
    }
    const myIndex = selectedSeen++;
    const read = filesDone > myIndex;
    const alpha = 0.1 + 0.72 * (cell.rows / maxRows);
    return (
      <div
        className={`cell sel${read ? " read" : ""}`}
        key={month}
        title={`${borough} ${month} — ${cell.rows.toLocaleString("en-US")} rows${read ? " — read" : ""}`}
        style={{
          background: read
            ? "var(--amber)"
            : `rgba(255, 178, 36, ${alpha.toFixed(3)})`,
        }}
      />
    );
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label" style={{ color: "var(--bone-dim)" }}>
          Partition map — {year}
        </span>
        <div className="legend">
          <span>
            <i className="sw read" />
            Read
          </span>
          <span>
            <i className="sw sel" />
            Queued
          </span>
          <span>
            <i className="sw pruned" />
            Pruned
          </span>
        </div>
      </div>
      <div className="pgrid-scroll">
        <div className="pgrid">
          {running && <div className="scanbeam" />}
          <div className="prow head">
            <div className="blabel">Borough \ Month</div>
            {MONTHS.map((m) => (
              <div className="mlabel" key={m}>
                {m}
              </div>
            ))}
          </div>
          {BOROUGHS.map((borough) => (
            <div className="prow" key={borough}>
              <div className="blabel">{borough}</div>
              {MONTHS.map((_, i) => cellFor(i, borough))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
