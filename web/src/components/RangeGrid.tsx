import { useState } from "react";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const fmt = (n: number) => n.toLocaleString("en-US");

interface Props {
  /** Every "YYYY-MM" present in the archive, sorted. */
  months: string[];
  monthRows: Record<string, number>;
  /** The picked range, or null for "no override". */
  value: [string, string] | null;
  onChange: (range: [string, string]) => void;
}

/**
 * The archive map, and the range picker in one: one cell per
 * month of data the city has published, years as rows. Amber
 * intensity is the month's trip count. Click one month, then
 * another, and the span between them becomes the range every
 * question runs over.
 */
export default function RangeGrid({ months, monthRows, value, onChange }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const present = new Set(months);
  const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort();
  const maxRows = Math.max(1, ...months.map((m) => monthRows[m] ?? 0));

  const inRange = (m: string) =>
    (value && m >= value[0] && m <= value[1]) || m === pending;

  const rangeTrips = value
    ? months
        .filter((m) => m >= value[0] && m <= value[1])
        .reduce((a, m) => a + (monthRows[m] ?? 0), 0)
    : months.reduce((a, m) => a + (monthRows[m] ?? 0), 0);

  const pick = (m: string) => {
    if (!pending) {
      setPending(m);
      return;
    }
    const [a, b] = pending <= m ? [pending, m] : [m, pending];
    setPending(null);
    onChange([a, b]);
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="label" style={{ color: "var(--bone-dim)" }}>
          Archive map — one cell per month · click two months to set the range
        </span>
        <div className="legend">
          <span>
            <i className="sw read" />
            In range
          </span>
          <span>
            <i className="sw sel" />
            In archive
          </span>
          <span>
            <i className="sw pruned" />
            Not published
          </span>
        </div>
      </div>
      <div className="pgrid-scroll">
        <div className="rgrid">
          <div className="prow head">
            <div className="blabel">Year \ Month</div>
            {MONTHS.map((m) => (
              <div className="mlabel" key={m}>
                {m}
              </div>
            ))}
          </div>
          {years.map((y) => (
            <div className="prow" key={y}>
              <div className="blabel">{y}</div>
              {MONTHS.map((_, i) => {
                const m = `${y}-${String(i + 1).padStart(2, "0")}`;
                if (!present.has(m)) {
                  return <div className="cell absent" key={m} title={`${m} — not published yet`} />;
                }
                const rows = monthRows[m] ?? 0;
                const alpha = 0.1 + 0.72 * (rows / maxRows);
                const active = inRange(m);
                return (
                  <button
                    className={`cell rcell${active ? " inrange" : ""}${m === pending ? " pending" : ""}`}
                    key={m}
                    onClick={() => pick(m)}
                    title={`${m} — ${fmt(rows)} trips${pending && m !== pending ? " — click to complete the range" : ""}`}
                    style={{
                      background: active
                        ? "var(--amber)"
                        : `rgba(255, 178, 36, ${alpha.toFixed(3)})`,
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="rangeline">
        {value
          ? `${value[0]} → ${value[1]} · ${fmt(rangeTrips)} trips in range`
          : pending
            ? `Range starts ${pending} — click the end month`
            : `Whole archive in range · ${fmt(rangeTrips)} trips`}
      </p>
    </div>
  );
}
