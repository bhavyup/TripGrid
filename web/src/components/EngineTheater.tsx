import { useMemo } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { SpecDict, SpecJobPayload, ValidateResult, ZoneMap } from "../api";
import { formatCompactNumber } from "../utils/instrument";
import type { ChoreographyFrame, HudAct } from "../utils/spring";
import StencilNycMap from "./StencilNycMap";

interface Props {
  phase: "ready" | "scanning" | "done";
  title: string;
  months: string[];
  effectiveRange: [string, string] | null;
  effectiveSpec: SpecDict | null;
  zones: ZoneMap;
  isAudit: boolean;
  gate: ValidateResult | null;
  gateBlocked: boolean;
  filesDone: number;
  filesTotal: number;
  payload: SpecJobPayload | null;
  choreography?: ChoreographyFrame | null;
  onRun?: () => void;
  // The answer node (SpecResults), present only once a run lands;
  // the theater swaps it in where the month matrix was.
  results?: ReactNode;
  onRunAgain?: () => void;
}

const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

const PIPELINE_STEPS = [
  { num: "01", label: "Prune" },
  { num: "02", label: "Analog" },
  { num: "03", label: "Digital 8T" },
  { num: "04", label: "Parity" },
];

/**
 * Central HUD Execution Core Theater:
 * Visually progresses through Act I (Mechanical) -> Act II (Analog) -> Act III (Digital)
 * with NYC Cartographic Stencil pen-tracing, 10×12 partition sweep, dual-channel
 * analog oscilloscope, and 8-thread digital kernel lane synthesizer.
 */
export default function EngineTheater({
  phase,
  title,
  months,
  effectiveRange,
  effectiveSpec,
  zones,
  isAudit,
  gate,
  gateBlocked,
  filesDone,
  filesTotal,
  payload,
  choreography,
  onRun,
  results,
  onRunAgain,
}: Props) {
  const monthSet = useMemo(() => new Set(months), [months]);
  const years = useMemo(() => {
    const s = new Set(months.map((m) => Number(m.slice(0, 4))));
    const arr = Array.from(s).sort((a, b) => a - b);
    return arr.length > 0
      ? arr
      : [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
  }, [months]);

  const selectedMonths = useMemo(() => {
    return months.filter((ym) => {
      if (!effectiveRange) return true;
      return ym >= effectiveRange[0] && ym <= effectiveRange[1];
    });
  }, [months, effectiveRange]);

  const selectedIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    selectedMonths.forEach((ym, i) => map.set(ym, i));
    return map;
  }, [selectedMonths]);

  const progress = useMemo(() => {
    if (phase === "done") return 1;
    if (phase === "ready") return 0;
    if (choreography) return choreography.progress;
    if (filesTotal > 0) return Math.min(1, filesDone / filesTotal);
    return 0.14;
  }, [phase, choreography, filesDone, filesTotal]);

  const hudAct: HudAct =
    phase === "done"
      ? "locked"
      : phase === "ready"
        ? "locked"
        : choreography?.act ?? "analog";

  const mechanicalPct =
    phase === "done"
      ? 1
      : phase === "ready"
        ? 0
        : choreography?.mechanicalPct ?? Math.min(1, progress * 3);

  // The pen traces the map at exactly the query's own pace (raw file
  // fraction), so it finishes with the month matrix and the query itself.
  // Two traps, both measured: the choreography's Act II window finished
  // the trace at ~64% of the files, and the choreography's `progress` is
  // easeInOutCubic, so it still ran ~0.1 ahead of the files past halfway.
  // The carrier and synth below still keep the 3-act pacing.
  const rawProgress =
    phase === "done" ? 1 : filesTotal > 0 ? Math.min(1, filesDone / filesTotal) : 0;
  const tracePct =
    phase === "done" ? 1 : phase === "ready" ? 1 : rawProgress;

  const analogPct =
    phase === "done"
      ? 1
      : phase === "ready"
        ? 0
        : choreography?.analogPct ?? progress;

  const scanPct =
    phase === "done"
      ? 1
      : phase === "ready"
        ? 0
        : choreography
          ? choreography.scanPct
          : progress;

  const digitalPct =
    phase === "done"
      ? 1
      : phase === "ready"
        ? 0
        : choreography?.digitalPct ?? Math.max(0, (progress - 0.55) / 0.45);

  const scopePct =
    phase === "done"
      ? 1
      : phase === "ready"
        ? 1
        : choreography
          ? choreography.scopePct
          : progress;

  const activePipelineIdx =
    phase === "done"
      ? 4
      : phase === "ready"
        ? 0
        : choreography
          ? choreography.stageIndex
          : progress < 0.24
            ? 0
            : progress < 0.65
              ? 1
              : progress < 0.9
                ? 2
                : 3;

  const scannedCount = Math.round(scanPct * selectedMonths.length);
  const headWidth = Math.max(2, Math.min(6, Math.ceil(selectedMonths.length * 0.08)));

  const displayDone =
    phase === "scanning" && choreography
      ? Math.max(filesDone, Math.round(scanPct * (filesTotal || selectedMonths.length)))
      : filesDone;
  const displayTotal = filesTotal || selectedMonths.length;

  // The matrix -> answer swap glides; reduced-motion users get
  // the swap instantly, with no slide or fade.
  const reduceMotion = useReducedMotion();

  // Dual-channel Analog Carrier Oscilloscope + Memory Redline
  const memTrace = useMemo(() => {
    const peakMb = payload?.stats.peak_rss_mb ?? (phase === "scanning" ? 360 : 310);
    const ceiling = 2048;
    const w = 220;
    const h = 44;
    const ceilingY = 6;
    const baseY = h - 5;
    const span = baseY - ceilingY;
    const steps = 32;
    const activeSteps =
      phase === "ready" || phase === "done"
        ? steps
        : Math.max(4, Math.round(scopePct * steps));

    const primaryPts: string[] = [];
    const carrierPts: string[] = [];
    const carrierPhase = analogPct * Math.PI * 6;
    const modAmp =
      phase === "scanning"
        ? hudAct === "mechanical"
          ? 2.2
          : hudAct === "analog"
            ? 7.5
            : 4.0
        : phase === "ready"
          ? 1.8
          : 2.0;

    for (let i = 0; i <= activeSteps; i++) {
      const t = i / steps;
      const x = t * w;
      let mb: number;
      if (phase === "ready") {
        mb = 148 + Math.sin(i * 0.75) * 8;
      } else {
        const ramp = Math.min(1, i / 5);
        const harmonic =
          Math.sin(i * 1.1 + carrierPhase) * (16 + modAmp * 2) +
          Math.cos(i * 0.55 - carrierPhase * 0.5) * 11;
        mb = Math.max(120, peakMb * ramp + harmonic * (phase === "done" && i === steps ? 0.15 : 0.75));
      }
      const y = baseY - (Math.min(mb, ceiling) / ceiling) * span;
      primaryPts.push(`${x.toFixed(1)},${y.toFixed(1)}`);

      // Secondary analog carrier envelope centered at mid-band
      const cy =
        23 +
        Math.sin(i * 0.85 + carrierPhase * 1.4) * modAmp +
        Math.cos(i * 1.7 - carrierPhase) * (modAmp * 0.45);
      carrierPts.push(`${x.toFixed(1)},${Math.max(9, Math.min(h - 4, cy)).toFixed(1)}`);
    }

    return {
      primary: primaryPts.join(" "),
      carrier: carrierPts.join(" "),
      ceilingY,
      peakLabel:
        phase === "ready"
          ? "Idle ~148 / 2,048 MB"
          : phase === "done" && payload
            ? `Peak ${Math.round(payload.stats.peak_rss_mb)} / 2,048 MB`
            : `Live ~${Math.round(210 + scopePct * 155)} / 2,048 MB`,
    };
  }, [phase, payload, scopePct, analogPct, hudAct]);

  // 8-Thread Digital Kernel Synthesis Matrix (Act III)
  const k8Threads = useMemo(() => {
    const out: { id: string; level: number }[] = [];
    for (let i = 0; i < 8; i++) {
      let level = 0.14;
      if (phase === "done") {
        level = 1;
      } else if (phase === "scanning") {
        if (hudAct === "mechanical") {
          level = Math.max(0.18, mechanicalPct * (0.25 + ((i * 7) % 5) * 0.05));
        } else if (hudAct === "analog") {
          const wave = 0.5 + 0.5 * Math.sin(analogPct * 10 + i * 0.9);
          level = 0.34 + analogPct * 0.36 + wave * 0.18;
        } else {
          // Digital Act III surges every lane smoothly toward 100% locked
          const stagger = Math.min(1, Math.max(0, (digitalPct - i * 0.045) / 0.62));
          level = 0.65 + stagger * 0.35;
        }
      }
      out.push({ id: `T${i}`, level: Math.min(1, Math.max(0.12, level)) });
    }
    return out;
  }, [phase, hudAct, mechanicalPct, analogPct, digitalPct]);

  const targetRowsEst =
    payload?.stats.rows_scanned ??
    gate?.rows_in_range ??
    (isAudit ? 90_000_000 : selectedMonths.length * 3_100_000);
  const liveRowsOdometer =
    phase === "ready"
      ? 0
      : phase === "done"
        ? targetRowsEst
        : Math.round(
            targetRowsEst *
              Math.min(1, scanPct * 0.55 + digitalPct * 0.45),
          );

  // The two readouts, rendered at two sites: under the month matrix
  // until the run lands, and under the map once it does. One definition,
  // so the two places can never drift apart.
  const carrierEl = (
    <div className="mem-scope">
      <div className="mem-scope-head">
        <span className="theater-kicker">ANALOG CARRIER · 2 GB CEIL</span>
        <span className="mem-scope-val">{memTrace.peakLabel}</span>
      </div>
      <svg
        className="mem-svg"
        viewBox="0 0 220 44"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          x1="0"
          y1={memTrace.ceilingY}
          x2="220"
          y2={memTrace.ceilingY}
          className="mem-ceil-line"
        />
        {memTrace.carrier && (
          <polyline
            points={memTrace.carrier}
            className="mem-carrier-wave"
          />
        )}
        {memTrace.primary && (
          <polyline
            points={memTrace.primary}
            className={`mem-trace${phase === "ready" ? " idle" : phase === "scanning" ? " live" : ""}`}
          />
        )}
      </svg>
    </div>
  );

  const synthEl = (
    <div className="k8-synth">
      <div className="mem-scope-head">
        <span className="theater-kicker">DIGITAL 8T SYNTHESIS</span>
        <span className="mem-scope-val mono">
          {phase === "ready"
            ? "8 LANES ARMED"
            : `${formatCompactNumber(liveRowsOdometer)} ROWS`}
        </span>
      </div>
      <div className="k8-lanes" aria-hidden="true">
        {k8Threads.map((t) => (
          <div key={t.id} className="k8-lane">
            <div className="k8-track">
              <i
                className={
                  phase === "done"
                    ? "locked"
                    : hudAct === "digital"
                      ? "synthesizing"
                      : ""
                }
                style={{ height: `${Math.round(t.level * 100)}%` }}
              />
            </div>
            <span className="k8-lbl">{t.id}</span>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div
      className={`theater theater-${phase} act-stage-${hudAct}`}
      data-testid="engine-theater"
      data-progress={Math.round(progress * 100)}
      data-act={hudAct}
    >
      <div className="theater-grid">
        {/* LEFT: NYC Cartographic Stencil Map with live pen-tracing contours */}
        <div className="theater-map-pane">
          <StencilNycMap
            phase={phase}
            effectiveSpec={effectiveSpec}
            zones={zones}
            isAudit={isAudit}
            tracePct={tracePct}
            progress={progress}
          />
          {/* Step 7 fix — before the run lands, the carrier + synth stay
              in the right pane where they were. Only once the run lands
              do they move here: carrier full-width first, then synth
              left + Run again right. */}
          <AnimatePresence initial={false}>
            {results && (
              <motion.div
                className="theater-done-deck"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={{ duration: reduceMotion ? 0 : 0.3, delay: reduceMotion ? 0 : 0.2, ease: [0.16, 1, 0.3, 1] }}
              >
                {carrierEl}
                <div className="theater-done-row">
                  {synthEl}
                  {onRunAgain && (
                    <button
                      type="button"
                      className="run-again"
                      onClick={onRunAgain}
                    >
                      Run again →
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* RIGHT: 4-Stage Pipeline + 10×12 Matrix + Analog Oscilloscope + Digital 8T Matrix */}
        <div className="theater-scan-pane">
          {/* 4-Stage Pipeline Stepper — gone once the answer lands,
              so the right pane is just the results. */}
          {!results && (
            <div className="pipe-steps" aria-label="Execution pipeline">
              {PIPELINE_STEPS.map((st, idx) => {
                const state =
                  phase === "done" || idx < activePipelineIdx
                    ? "done"
                    : phase === "scanning" && idx === activePipelineIdx
                      ? "active"
                      : "idle";
                return (
                  <div className={`pipe-step ${state}`} key={st.num}>
                    <span className="pipe-num">{st.num}</span>
                    <span className="pipe-lbl">{st.label}</span>
                  </div>
                );
              })}
            </div>
          )}
          {/* Live 10-Year × 12-Month Partition Matrix — swapped for the
              answer (framer-motion) once the run lands. */}
          <AnimatePresence mode="wait" initial={false}>
            {results ? (
              <motion.div
                key="results"
                className="theater-results-wrap"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
              >
                {results}
              </motion.div>
            ) : (
              <motion.div
                key="matrix"
                className="pmatrix-wrap"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: reduceMotion ? 0 : 0.25, ease: "easeOut" }}
              >
              <div className="theater-pane-head">
                <span className="theater-kicker">
                  {phase === "scanning"
                    ? `STREAMING ARCHIVE · ${displayDone}/${displayTotal} FILES`
                    : phase === "done"
                      ? `SCAN RECEIPT · ${selectedMonths.length} MONTHS READ`
                      : `PARTITION PLAN · ${selectedMonths.length} MONTHS SELECTED`}
                </span>
                <span className="theater-badge">
                  {effectiveRange
                    ? `${effectiveRange[0]} → ${effectiveRange[1]}`
                    : "WHOLE ARCHIVE"}
                </span>
              </div>

              <div className="pmatrix" aria-label="Partition scan matrix">
                <div className="pm-row pm-head" aria-hidden="true">
                  <span className="pm-yr" />
                  <div className="pm-cells">
                    {MONTH_INITIALS.map((m, idx) => (
                      <span className="pm-mhead" key={idx}>
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
                {years.map((yr) => (
                  <div className="pm-row" key={yr}>
                    <span className="pm-yr">{String(yr).slice(2)}</span>
                    <div className="pm-cells">
                      {Array.from({ length: 12 }, (_, i) => {
                        const ym = `${yr}-${String(i + 1).padStart(2, "0")}`;
                        const present = monthSet.size === 0 || monthSet.has(ym);
                        const selIdx = selectedIndexMap.get(ym);
                        let cls = "pm-cell";
                        if (!present) {
                          cls += " absent";
                        } else if (selIdx === undefined) {
                          cls += " pruned";
                        } else if (phase === "ready") {
                          cls += " queued";
                        } else if (phase === "done") {
                          cls += " done";
                        } else {
                          if (selIdx < scannedCount - headWidth) {
                            cls += " done";
                          } else if (selIdx <= scannedCount) {
                            cls += " reading";
                          } else {
                            cls += " queued";
                          }
                        }
                        return <span key={ym} className={cls} title={ym} />;
                      })}
                    </div>
                  </div>
                ))}
              </div>
              </motion.div>
            )}
          </AnimatePresence>
          {/* Before the run lands, the carrier + synth stay here,
              under the month matrix where they have always lived. */}
          <AnimatePresence initial={false}>
            {!results && (
              <motion.div
                className="hud-signal-deck"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: reduceMotion ? 0 : 0.25, ease: "easeOut" }}
              >
                {carrierEl}
                {synthEl}
              </motion.div>
            )}
          </AnimatePresence>
          {/* Ready Execution Strip */}
          {phase === "ready" && onRun && (
            <div className="theater-cta-box">
              <div className="theater-cta-meta">
                <span className="theater-cta-title">{title}</span>
                <span className="theater-cta-sub">
                  {isAudit
                    ? "4 full-archive checks · O(1) memory"
                    : gate?.ok
                      ? `${formatCompactNumber(gate.rows_in_range ?? 0)} rows · ${gate.partitions_in_range ?? 0} files`
                      : gateBlocked
                        ? "Gate blocked — adjust recipe"
                        : "Ready to execute"}
                </span>
              </div>
              <button
                type="button"
                className="ready-run"
                disabled={gateBlocked}
                onClick={onRun}
              >
                Run Query →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
