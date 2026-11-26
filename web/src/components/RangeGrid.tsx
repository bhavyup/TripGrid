import { useEffect, useState } from "react";

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
  /** A query is running: shortcuts, expander and month cells go inert. */
  locked: boolean;
  /** Start with the month map open (used by the builder's Time Span petal). */
  defaultExpanded?: boolean;
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
  locked,
  defaultExpanded,
}: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(!!defaultExpanded);
  // Month/year picker popover for the readout dates ("start" or "end" open, null closed).
  const [picker, setPicker] = useState<"start" | "end" | null>(null);
  // The year the popover is browsing; separate from the selection, so stepping years never selects.
  const [pickerYear, setPickerYear] = useState<number>(() =>
    Number((effectiveRange?.[0] ?? months[0] ?? "2017-01").slice(0, 4))
  );
  // Which view the popover shows: the month grid, or the year grid (opened by clicking the year).
  const [pickerView, setPickerView] = useState<"month" | "year">("month");
  // First year of the 12-year page shown in the year view (2017-2028, 2029-2040, ...).
  const [yearPage, setYearPage] = useState<number>(() =>
    Number((effectiveRange?.[0] ?? months[0] ?? "2017-01").slice(0, 4))
  );

  // Close the picker on Escape, and if a run starts while it is open.
  useEffect(() => {
    if (picker === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picker]);
  useEffect(() => {
    if (locked) setPicker(null);
  }, [locked]);

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

  // The range the pickers edit: the effective span, or the whole archive when it is null.
  const curSpan: [string, string] =
    activeSpan ??
    (months.length ? [months[0], months[months.length - 1]] : ["2017-01", "2017-01"]);
  // What the readout shows: the effective span, or the whole archive span when it is null.
  // (The dates are pickers in both cases, so "All" still shows two clickable dates.)
  const displaySpan: [string, string] | null =
    activeSpan ??
    (rangeMonths.length > 0
      ? [rangeMonths[0], rangeMonths[rangeMonths.length - 1]]
      : null);
  const firstYear = Number(years[0] ?? "2017");
  const lastYear = Number(years[years.length - 1] ?? "2017");
  // The 12-year page containing a year: pages start at the first archive year (2017-2028, ...).
  const pageFor = (y: number) => firstYear + Math.floor((y - firstYear) / 12) * 12;
  // Clicking the year in the month view opens the year grid on the page holding that year.
  const openYearPicker = () => {
    setYearPage(pageFor(pickerYear));
    setPickerView("year");
  };

  // Open a picker for one end; the popover browses that end's year. Clicking the same date again closes it.
  const openPicker = (side: "start" | "end") => {
    if (isAudit || locked) return;
    setPickerYear(Number((side === "start" ? curSpan[0] : curSpan[1]).slice(0, 4)));
    setPickerView("month");
    setPicker((prev) => (prev === side ? null : side));
  };

  // Pick a month for one end; the other end is clamped so the range stays valid. Picking creates an explicit range.
  const applyPicker = (side: "start" | "end", m: string) => {
    setPicker(null);
    setPending(null);
    if (isAudit) return;
    if (side === "start") {
      onChange([m, m > curSpan[1] ? m : curSpan[1]]);
    } else {
      onChange([m < curSpan[0] ? m : curSpan[0], m]);
    }
  };

  // The popover, rendered inside the wrapper of whichever date opened it, so it drops below that date.
  // Month view: year stepper + 12-month grid; clicking the year opens the year view.
  // Year view: a 12-year page (2017-2028, ...) with paging; picking a year returns to the month view.
  const pickerPopover =
    picker === null ? null : (
      <div
        className="range-picker"
        role="dialog"
        aria-label={picker === "start" ? "Choose start month" : "Choose end month"}
      >
        {pickerView === "month" ? (
          <>
            <div className="range-picker-kicker">
              {picker === "start" ? "Start month" : "End month"}
            </div>
            <div className="range-picker-year">
              <button
                type="button"
                className="range-picker-year-btn"
                disabled={pickerYear <= firstYear}
                aria-label="Previous year"
                onClick={() => setPickerYear((y) => Math.max(firstYear, y - 1))}
              >
                ‹
              </button>
              <button
                type="button"
                className="range-picker-year-val"
                title="Choose a year"
                aria-label="Choose a year"
                onClick={openYearPicker}
              >
                {pickerYear}
              </button>
              <button
                type="button"
                className="range-picker-year-btn"
                disabled={pickerYear >= lastYear}
                aria-label="Next year"
                onClick={() => setPickerYear((y) => Math.min(lastYear, y + 1))}
              >
                ›
              </button>
            </div>
            <div className="range-picker-months">
              {MONTHS.map((label, idx) => {
                const m = `${pickerYear}-${String(idx + 1).padStart(2, "0")}`;
                const disabled = !present.has(m);
                const selected = m === (picker === "start" ? curSpan[0] : curSpan[1]);
                return (
                  <button
                    key={label}
                    type="button"
                    className={`range-picker-month${selected ? " on" : ""}`}
                    disabled={disabled}
                    onClick={() => applyPicker(picker, m)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </>
        ) : (
          <>
            <div className="range-picker-kicker">
              {picker === "start" ? "Start year" : "End year"}
            </div>
            <button
              type="button"
              className="range-picker-back"
              onClick={() => setPickerView("month")}
            >
              ‹ Months
            </button>
            <div className="range-picker-year">
              <button
                type="button"
                className="range-picker-year-btn"
                disabled={yearPage <= firstYear}
                aria-label="Previous 12 years"
                onClick={() => setYearPage((p) => Math.max(firstYear, p - 12))}
              >
                ‹
              </button>
              <span className="range-picker-year-val">
                {yearPage} – {yearPage + 11}
              </span>
              <button
                type="button"
                className="range-picker-year-btn"
                disabled={yearPage + 12 > lastYear}
                aria-label="Next 12 years"
                onClick={() => setYearPage((p) => p + 12)}
              >
                ›
              </button>
            </div>
            <div className="range-picker-months">
              {Array.from({ length: 12 }, (_, i) => yearPage + i).map((y) => {
                const disabled = !years.includes(String(y));
                const selected = y === pickerYear;
                return (
                  <button
                    key={y}
                    type="button"
                    className={`range-picker-month${selected ? " on" : ""}`}
                    disabled={disabled}
                    onClick={() => {
                      setPickerYear(y);
                      setPickerView("month");
                    }}
                  >
                    {y}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    );

  const has2020 = months.some((m) => m.startsWith("2020-"));
  const has2025 = months.some((m) => m.startsWith("2025-"));
  const has2024 = months.some((m) => m.startsWith("2024-"));

  return (
    <div
      className={`archive-strip${locked ? " locked" : ""}`}
      inert={locked}
    >
      <div className={`archive-head${mode === "builder" ? " archive-head-builder" : ""}`}>
        <div className="archive-head-left">
          <span className="archive-readout">
            {pending ? (
              <span className="amber">
                Start {pending} — pick end month
              </span>
            ) : displaySpan ? (
              <>
                <span className="range-date-wrap">
                  <button
                    type="button"
                    className={`range-date-btn${value ? " amber" : ""}`}
                    disabled={isAudit}
                    title="Change start month"
                    aria-haspopup="dialog"
                    aria-expanded={picker === "start"}
                    onClick={() => openPicker("start")}
                  >
                    {displaySpan[0]}
                  </button>
                  {picker === "start" && pickerPopover}
                </span>
                <span className="range-swap" aria-hidden="true">
                  <svg width="28" height="14" viewBox="0 0 28 14" fill="none" aria-hidden="true">
                    <path d="M2 4h17" stroke="currentColor" strokeWidth="2" />
                    <path d="M19 1l6 3-6 3Z" fill="currentColor" />
                    <path d="M26 10H9" stroke="currentColor" strokeWidth="2" />
                    <path d="M9 7L3 10l6 3Z" fill="currentColor" />
                  </svg>
                </span>
                <span className="range-date-wrap">
                  <button
                    type="button"
                    className={`range-date-btn${value ? " amber" : ""}`}
                    disabled={isAudit}
                    title="Change end month"
                    aria-haspopup="dialog"
                    aria-expanded={picker === "end"}
                    onClick={() => openPicker("end")}
                  >
                    {displaySpan[1]}
                  </button>
                  {picker === "end" && pickerPopover}
                </span>
              </>
            ) : (
              <span>Whole archive</span>
            )}
          </span>
          {picker !== null && (
            <div
              className="range-picker-backdrop"
              onClick={() => setPicker(null)}
              aria-hidden="true"
            />
          )}
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

        <div className={`archive-controls${mode === "builder" ? " archive-controls-builder" : ""}`}>
          {!isAudit && (
            <div className={`range-shortcuts ${!expanded && mode === "builder" ? "range-shortcuts-expanded" : ""}`} role="group" aria-label="Quick time ranges">
              <button
                type="button"
                className={`rshort${value === null ? " on" : ""}`}
                aria-pressed={value === null}
                onClick={() => applyShortcut(null)}
              >
                {mode === "builder" ? "All" : "Preset default"}
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
            <div className={`rgrid-v2${mode === "builder" ? " rgrid-v2-builder" : ""}`}>
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
            
            <div className="legend-v2">
              <span>
                <i className="sw read" />
                Selected
              </span>
              <span>
                <i className="sw muted" />
                Out of range
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
