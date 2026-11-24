import { useState } from "react";

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];
const fmt = (n: number) => n.toLocaleString("en-US");

interface Props {
  /** Every "YYYY-MM" present in the archive, sorted. */
  months: string[];
  monthRows: Record<string, number>;
  /** User's explicit range override, or null for preset default / all. */
  value: [string, string] | null;
  /** The effective highlighted span (override or preset's own range), or null = whole archive. */
  effectiveRange: [string, string] | null;
  mode: "presets" | "builder";
  isAudit: boolean;
  onChange: (range: [string, string] | null) => void;
}

/**
 * The Archive Map & Range Selector: one cell per month of data
 * the city has published, years as rows. Click any year label to
 * select that full calendar year, or click two months for a custom
 * span. Collapsible so users can reclaim vertical space for results.
 */
export default function RangeGrid({
  months,
  monthRows,
  value,
  effectiveRange,
  mode,
  isAudit,
  onChange,
}: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const present = new Set(months);
  const years = [...new Set(months.map((m) => m.slice(0, 4)))].sort();
  const maxRows = Math.max(1, ...months.map((m) => monthRows[m] ?? 0));

  const last12: [string, string] | null =
    months.length >= 12
      ? [months[months.length - 12], months[months.length - 1]]
      : null;

  const isSameRange = (a: [string, string] | null, b: [string, string] | null) =>
    a !== null && b !== null && a[0] === b[0] && a[1] === b[1];

  const activeSpan = isAudit ? null : effectiveRange;

  const inRange = (m: string) =>
    (activeSpan && m >= activeSpan[0] && m <= activeSpan[1]) ||
    m === pending ||
    (!activeSpan && !pending);

  const rangeMonths = activeSpan
    ? months.filter((m) => m >= activeSpan[0] && m <= activeSpan[1])
    : months;

  const pick = (m: string) => {
    if (isAudit) return;
    if (!pending) {
      setPending(m);
      return;
    }
    const [a, b] = pending <= m ? [pending, m] : [m, pending];
    setPending(null);
    onChange([a, b]);
  };

  const pickYear = (y: string) => {
    if (isAudit) return;
    const yearMonths = months.filter((m) => m.startsWith(`${y}-`));
    if (yearMonths.length === 0) return;
    setPending(null);
    onChange([yearMonths[0], yearMonths[yearMonths.length - 1]]);
  };

  const applyShortcut = (target: [string, string] | null) => {
    setPending(null);
    onChange(target);
  };

  const has2020 = months.some((m) => m.startsWith("2020-"));
  const has2025 = months.some((m) => m.startsWith("2025-"));
  const has2024 = months.some((m) => m.startsWith("2024-"));

  return (
    <div className="archive-strip">
      <div className="archive-head">
        <div className="archive-head-left">
          <span className="archive-readout">
            {pending ? (
              <span className="amber">
                Start {pending} — pick end month
              </span>
            ) : activeSpan ? (
              <>
                <span className={value ? "amber" : ""}>
                  {activeSpan[0]} → {activeSpan[1]}
                </span>
              </>
            ) : (
              <>
                {rangeMonths.length > 0 ? (
                  <span>
                    {rangeMonths[0]} → {rangeMonths[rangeMonths.length - 1]}
                  </span>
                ) : (
                  <span>Whole archive</span>
                )}
              </>
            )}
          </span>
        </div>

        {/* Inline compact 10-year visual timeline (always visible, clickable per year) */}
        {!expanded && years.length > 0 && (
          <div className="mini-timeline" aria-label="Archive years">
            {years.map((y) => {
              const yMonths = months.filter((m) => m.startsWith(`${y}-`));
              const activeCount = yMonths.filter((m) => inRange(m)).length;
              const full = activeCount === yMonths.length && yMonths.length > 0;
              const partial = activeCount > 0 && !full;
              return (
                <button
                  key={y}
                  type="button"
                  disabled={isAudit}
                  className={`mini-yr${full ? " on" : partial ? " part" : ""}`}
                  title={isAudit ? `${y} (audit reads all)` : `Select all of ${y}`}
                  onClick={() => pickYear(y)}
                >
                  <span className="mini-yr-bar" />
                  <span className="mini-yr-lbl">{y.slice(2)}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="archive-controls">
          {!isAudit && (
            <div className="range-shortcuts" role="group" aria-label="Quick time ranges">
              <button
                type="button"
                className={`rshort${value === null ? " on" : ""}`}
                aria-pressed={value === null}
                onClick={() => applyShortcut(null)}
              >
                {mode === "builder" ? "All years" : "Preset default"}
              </button>
              {last12 && (
                <button
                  type="button"
                  className={`rshort${isSameRange(value, last12) ? " on" : ""}`}
                  aria-pressed={isSameRange(value, last12)}
                  onClick={() => applyShortcut(last12)}
                >
                  Last 12m
                </button>
              )}
              {has2025 && (
                <button
                  type="button"
                  className={`rshort${isSameRange(value, ["2025-01", "2025-12"]) ? " on" : ""}`}
                  aria-pressed={isSameRange(value, ["2025-01", "2025-12"])}
                  onClick={() => applyShortcut(["2025-01", "2025-12"])}
                >
                  2025
                </button>
              )}
              {has2024 && has2025 && (
                <button
                  type="button"
                  className={`rshort${isSameRange(value, ["2024-01", months[months.length - 1]]) ? " on" : ""}`}
                  aria-pressed={isSameRange(value, ["2024-01", months[months.length - 1]])}
                  onClick={() => applyShortcut(["2024-01", months[months.length - 1]])}
                >
                  2024+
                </button>
              )}
              {has2020 && (
                <button
                  type="button"
                  className={`rshort${isSameRange(value, ["2020-01", "2020-12"]) ? " on" : ""}`}
                  aria-pressed={isSameRange(value, ["2020-01", "2020-12"])}
                  onClick={() => applyShortcut(["2020-01", "2020-12"])}
                >
                  COVID 2020
                </button>
              )}
            </div>
          )}

          <button
            type="button"
            className="archive-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
          >
            {expanded ? "Hide map −" : "Month map +"}
          </button>
        </div>
      </div>

      {expanded && (
        <>
          <div className="pgrid-scroll">
            <div className="rgrid-v2">
              <div className="prow-v2 head">
                <div className="blabel">Year</div>
                {MONTHS.map((m) => (
                  <div className="mlabel" key={m}>
                    {m}
                  </div>
                ))}
              </div>
              {years.map((y) => {
                const yearFull =
                  activeSpan !== null &&
                  activeSpan[0] === `${y}-01` &&
                  activeSpan[1].startsWith(`${y}-`);
                return (
                  <div className="prow-v2" key={y}>
                    <button
                      type="button"
                      className={`yrbtn${yearFull ? " on" : ""}`}
                      disabled={isAudit}
                      title={
                        isAudit
                          ? "Audit always scans the whole archive"
                          : `Select all of ${y}`
                      }
                      onClick={() => pickYear(y)}
                    >
                      {y}
                    </button>
                    {MONTHS.map((_, i) => {
                      const m = `${y}-${String(i + 1).padStart(2, "0")}`;
                      if (!present.has(m)) {
                        return (
                          <div
                            className="cell-v2 absent"
                            key={m}
                            title={`${m} — not published`}
                          />
                        );
                      }
                      const rows = monthRows[m] ?? 0;
                      const ratio = rows / maxRows;
                      const active = inRange(m);
                      const isPending = m === pending;
                      const bg = active
                        ? `rgba(255, 178, 36, ${(0.35 + 0.65 * ratio).toFixed(3)})`
                        : `rgba(167, 158, 141, ${(0.07 + 0.16 * ratio).toFixed(3)})`;
                      return (
                        <button
                          type="button"
                          className={`cell-v2 rcell${active ? " inrange" : ""}${isPending ? " pending" : ""}`}
                          key={m}
                          disabled={isAudit}
                          aria-label={`${m}, ${fmt(rows)} trips`}
                          onClick={() => pick(m)}
                          onMouseEnter={() => setHovered(m)}
                          onMouseLeave={() =>
                            setHovered((curr) => (curr === m ? null : curr))
                          }
                          title={`${m} — ${fmt(rows)} trips${pending && m !== pending ? " (click to complete range)" : ""}`}
                          style={{ background: bg }}
                        />
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="archive-foot">
            <span className="archive-hint">
              {hovered
                ? `${hovered} · ${fmt(monthRows[hovered] ?? 0)} trips`
                : isAudit
                  ? "The junk audit reads every partition in the archive."
                  : "Click any year to isolate it, or click two months for a custom span."}
            </span>
            <div className="legend-v2">
              <span>
                <i className="sw read" />
                Selected
              </span>
              <span>
                <i className="sw muted" />
                Outside range
              </span>
              <span>
                <i className="sw pruned" />
                Unpublished
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
