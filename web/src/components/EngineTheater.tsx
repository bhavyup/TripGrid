import { useMemo } from "react";
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
}

const MONTH_INITIALS = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];

const PIPELINE_STEPS = [
  { num: "01", label: "Prune" },
  { num: "02", label: "Analog" },
  { num: "03", label: "Digital 8T" },
  { num: "04", label: "Parity" },
];

const ACT_META: Record<HudAct, { tag: string; title: string }> = {
  mechanical: {
    tag: "ACT I · MECHANICAL",
    title: "Locking vernier ring & arming partition relays",
  },
  analog: {
    tag: "ACT II · ANALOG",
    title: "Pen-tracing borough contours & carrier telemetry",
  },
  digital: {
    tag: "ACT III · DIGITAL",
    title: "Synthesizing 8-thread kernel buckets & parity checksum",
  },
  locked: {
    tag: "ARMED",
    title: "Out-of-core execution core ready under 2,048 MB",
  },
};

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

  const tracePct =
    phase === "done"
      ? 1
      : phase === "ready"
        ? 1
        : choreography
          ? choreography.tracePct
          : Math.min(1, progress * 1.3);

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

  // The act strip is shown only before a run. Kept as a plain boolean so
  // TypeScript does not narrow `phase` to "ready" inside the strip itself.
  const showActBar = phase === "ready";

  const actBanner =
    phase === "done"
      ? {
          tag: "LOCKED · VERIFIED",
          title: payload
            ? `${formatCompactNumber(payload.stats.rows_scanned)} rows matched against DuckDB`
            : "Results locked and verified",
        }
      : ACT_META[hudAct];

  return (
    <div
      className={`theater theater-${phase} act-stage-${hudAct}`}
      data-testid="engine-theater"
      data-progress={Math.round(progress * 100)}
      data-act={hudAct}
    >
      {/* Top 3-Act Choreography Progress Strip — shown only before a run.
          Once a query runs, this row is gone (user). */}
      {showActBar && (
      <div className="theater-act-bar">
        <div className="act-badge-group">
          <span className="act-tag">{actBanner.tag}</span>
          <span className="act-desc">{actBanner.title}</span>
        </div>
        <div className="act-triad" aria-hidden="true">
          <span className="act-tri">I MECH 00%</span>
          <span className="act-tri">II ANALOG 00%</span>
          <span className="act-tri">III DIGITAL 00%</span>
        </div>
      </div>
      )}

      {/* Top progress hairline sweep during live scan */}
      <div className="theater-rail" aria-hidden="true">
        <i style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>

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
        </div>

        {/* RIGHT: 4-Stage Pipeline + 10×12 Matrix + Analog Oscilloscope + Digital 8T Matrix */}
        <div className="theater-scan-pane">
          {/* 4-Stage Pipeline Stepper */}
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

          {/* Live 10-Year × 12-Month Partition Matrix */}
          <div className="pmatrix-wrap">
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
          </div>

          {/* Dual-Stage Analog Carrier Oscilloscope + Digital 8-Thread Synthesis */}
          <div className="hud-signal-deck">
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
          </div>

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
