import { useEffect, useMemo, useRef, useState } from "react";
import type { PresetInfo } from "../api";
import {
  BUILDER_PETALS,
  DIAL_SPRING,
  MORPH_SPRING,
  computeArcNodes,
  describeEllipticalArc,
  describeEllipticalWedge,
  stepSpring,
  type BuilderPetalId,
  type HudAct,
  type SpringState,
} from "../utils/spring";
import { getPresetCategory } from "../utils/instrument";

const SHORT_PRESET_NAMES: Record<string, string> = {
  congestion_verdict: "Congestion Toll",
  covid_recovery: "COVID Recovery",
  city_speed: "City Speed",
  demand_clock: "Demand Clock",
  busiest_routes: "Busiest Routes",
  tip_behaviour: "Tip Behaviour",
  airport_payments: "Airport Q2",
  zone_month_trips: "Zones × Mo Q1",
  friday_manhattan: "Fri Night Q3",
  fare_percentiles: "Fares p99 Q4",
  junk_audit: "Junk Audit",
};

interface Props {
  mode: "presets" | "builder";
  presets: PresetInfo[];
  presetId: string;
  onSelectPreset: (id: string) => void;
  activePetal: BuilderPetalId;
  onSelectPetal: (id: BuilderPetalId) => void;
  builderSummaries: Record<BuilderPetalId, string>;
  running: boolean;
  progress: number;
  hudAct?: HudAct;
  children: React.ReactNode;
}

const ACT_LABELS: Record<HudAct, { code: string; name: string }> = {
  mechanical: { code: "ACT I", name: "MECHANICAL LOCK" },
  analog: { code: "ACT II", name: "ANALOG TRACE" },
  digital: { code: "ACT III", name: "DIGITAL SYNTHESIS" },
  locked: { code: "READY", name: "CORE ARMED" },
};

/**
 * 208° Orbital FUI Command Wheel framing the Central Execution Core (`hud-core`).
 * Replaces linear dashboards with concentric counter-rotating vernier rings,
 * a spring-actuated orbital lock-on sector bracket (no car-speedometer needle),
 * and radial preset/builder wedges morphing via damped harmonic spring physics.
 */
export default function RadialDial({
  mode,
  presets,
  presetId,
  onSelectPreset,
  activePetal,
  onSelectPetal,
  builderSummaries,
  running,
  progress,
  hudAct = "locked",
  children,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1260);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setWidth(entry.contentRect.width);
        }
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const isCompact = width < 1040;
  // Orbital halo geometry embracing `.hud-core` across -194° .. +14°
  const rx = Math.max(320, Math.min(550, width * 0.432));
  const ry = 204;
  const cx = width / 2;
  const cy = 256;
  const svgHeight = 416;

  const presetNodes = useMemo(
    () => computeArcNodes(presets.length, rx, ry, -194, 14),
    [presets.length, rx, ry],
  );
  const builderNodes = useMemo(
    () => computeArcNodes(BUILDER_PETALS.length, rx * 0.94, ry * 0.94, -172, -8),
    [rx, ry],
  );

  const activePresetIdx = Math.max(
    0,
    presets.findIndex((p) => p.id === presetId),
  );
  const activeBuilderIdx = Math.max(
    0,
    BUILDER_PETALS.findIndex((p) => p.id === activePetal),
  );

  const targetAngle =
    mode === "presets"
      ? (presetNodes[activePresetIdx]?.angleDeg ?? -90)
      : (builderNodes[activeBuilderIdx]?.angleDeg ?? -90);
  const targetMorph = mode === "builder" ? 1 : 0;

  const [orbitalAngle, setOrbitalAngle] = useState(targetAngle);
  const [morphProgress, setMorphProgress] = useState(targetMorph);

  const angleSpringRef = useRef<SpringState>({ value: targetAngle, velocity: 0 });
  const morphSpringRef = useRef<SpringState>({ value: targetMorph, velocity: 0 });
  const targetAngleRef = useRef(targetAngle);
  const targetMorphRef = useRef(targetMorph);
  targetAngleRef.current = targetAngle;
  targetMorphRef.current = targetMorph;

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      angleSpringRef.current = { value: targetAngle, velocity: 0 };
      morphSpringRef.current = { value: targetMorph, velocity: 0 };
      setOrbitalAngle(targetAngle);
      setMorphProgress(targetMorph);
      return;
    }

    let rafId = 0;
    let lastTs = performance.now();

    const tick = (now: number) => {
      const dt = (now - lastTs) / 1000;
      lastTs = now;

      const a = stepSpring(
        angleSpringRef.current,
        targetAngleRef.current,
        DIAL_SPRING,
        dt,
      );
      const m = stepSpring(
        morphSpringRef.current,
        targetMorphRef.current,
        MORPH_SPRING,
        dt,
      );

      angleSpringRef.current = a.state;
      morphSpringRef.current = m.state;
      setOrbitalAngle(a.state.value);
      setMorphProgress(m.state.value);

      if (!a.settled || !m.settled) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(rafId);
  }, [targetAngle, targetMorph]);

  const stepSelection = (delta: number) => {
    if (mode === "presets" && presets.length > 0) {
      const next = (activePresetIdx + delta + presets.length) % presets.length;
      onSelectPreset(presets[next].id);
    } else if (mode === "builder") {
      const next =
        (activeBuilderIdx + delta + BUILDER_PETALS.length) %
        BUILDER_PETALS.length;
      onSelectPetal(BUILDER_PETALS[next].id);
    }
  };

  // Concentric FUI rings around `.hud-core`
  const trackRx = rx * 0.81;
  const trackRy = ry * 0.81;
  const gyroRx = rx * 0.72;
  const gyroRy = ry * 0.72;

  // Vernier tick marks along the mechanical orbital ring
  const ticks = useMemo(() => {
    const out: { x1: number; y1: number; x2: number; y2: number; major: boolean }[] = [];
    for (let deg = -198; deg <= 18; deg += 4) {
      const rad = (deg * Math.PI) / 180;
      const major = deg % 16 === 0;
      const rIn = major ? 0.77 : 0.79;
      const rOut = 0.81;
      out.push({
        x1: cx + rx * rIn * Math.cos(rad),
        y1: cy + ry * rIn * Math.sin(rad),
        x2: cx + rx * rOut * Math.cos(rad),
        y2: cy + ry * rOut * Math.sin(rad),
        major,
      });
    }
    return out;
  }, [cx, cy, rx, ry]);

  // Spring-actuated orbital lock-on sector bracket centered on orbitalAngle
  const lockHalfSpan = mode === "presets" ? 8.5 : 15;
  const lockWedgePath = describeEllipticalWedge(
    cx,
    cy,
    rx * 0.76,
    ry * 0.76,
    rx * 0.835,
    ry * 0.835,
    orbitalAngle - lockHalfSpan,
    orbitalAngle + lockHalfSpan,
  );

  // Target ray connecting the active orbital sector into the inner gyro track (short crisp vector, not a needle!)
  const rayRad = (orbitalAngle * Math.PI) / 180;
  const rayOuterX = cx + rx * 0.89 * Math.cos(rayRad);
  const rayOuterY = cy + ry * 0.89 * Math.sin(rayRad);
  const rayInnerX = cx + rx * 0.835 * Math.cos(rayRad);
  const rayInnerY = cy + ry * 0.835 * Math.sin(rayRad);

  const actDisplay = running
    ? ACT_LABELS[hudAct]
    : progress >= 1
      ? { code: "LOCKED", name: "RESULTS VERIFIED" }
      : ACT_LABELS.locked;

  return (
    <div
      className={`orbital-hud${mode === "builder" ? " is-builder" : " is-presets"}${running ? ` act-${hudAct}` : ""}`}
      ref={stageRef}
      data-testid="radial-cockpit"
      data-mode={mode}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" && e.altKey) {
          e.preventDefault();
          stepSelection(-1);
        } else if (e.key === "ArrowRight" && e.altKey) {
          e.preventDefault();
          stepSelection(1);
        }
      }}
    >
      {!isCompact ? (
        <div className="orbital-frame">
          {/* Concentric FUI Orbital Halo Rings (behind & surrounding `.hud-core`) */}
          <svg
            className="orbital-svg"
            width={width}
            height={svgHeight}
            viewBox={`0 0 ${width} ${svgHeight}`}
            aria-hidden="true"
          >
            {/* Outer perimeter guide orbit */}
            <path
              d={describeEllipticalArc(cx, cy, rx, ry, -198, 18)}
              className="orb-arc-outer"
            />
            {/* Secondary hairline halo */}
            <path
              d={describeEllipticalArc(cx, cy, rx * 0.91, ry * 0.91, -196, 16)}
              className="orb-arc-mid"
            />
            {/* Mechanical vernier scale ring */}
            <path
              d={describeEllipticalArc(cx, cy, trackRx, trackRy, -198, 18)}
              className="orb-arc-track"
            />
            {/* Counter-rotating segmented inner gyro track */}
            <path
              d={describeEllipticalArc(cx, cy, gyroRx, gyroRy, -194, 14)}
              className={`orb-arc-gyro${running ? " spinning" : ""}`}
            />

            {/* Live phase sweep progress along orbital arc */}
            {running && (
              <path
                d={describeEllipticalArc(
                  cx,
                  cy,
                  trackRx,
                  trackRy,
                  -194,
                  -194 + 208 * Math.min(1, Math.max(0.02, progress)),
                )}
                className="orb-arc-progress"
              />
            )}

            {/* 54 Mechanical calibration notches */}
            {ticks.map((t, idx) => (
              <line
                key={idx}
                x1={t.x1}
                y1={t.y1}
                x2={t.x2}
                y2={t.y2}
                className={t.major ? "dial-tick major" : "dial-tick"}
              />
            ))}

            {/* Spring-actuated Orbital Sector Lock Bracket */}
            <path d={lockWedgePath} className="orb-lock-wedge" />
            <line
              x1={rayInnerX}
              y1={rayInnerY}
              x2={rayOuterX}
              y2={rayOuterY}
              className="orb-lock-coupler"
            />
            <circle cx={rayOuterX} cy={rayOuterY} r={3} className="dial-needle-tip" />
          </svg>

          {/* Outer Orbital Petals — Presets Ring (morphs out smoothly into Builder) */}
          <div
            className="orbital-ring-layer"
            role="tablist"
            aria-label="Preset analytical questions"
            aria-hidden={mode !== "presets"}
            style={{
              opacity: Math.max(0, 1 - morphProgress * 1.45),
              transform: `scale(${1 - morphProgress * 0.05})`,
              pointerEvents: mode === "presets" ? "auto" : "none",
            }}
          >
            {presets.map((p, idx) => {
              const node = presetNodes[idx];
              if (!node) return null;
              const selected = p.id === presetId;
              const cat = getPresetCategory(p);
              const popOut = selected ? 10 : 0;
              const px = cx + (rx + popOut) * node.nx;
              const py = cy + (ry + popOut) * node.ny;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={mode === "presets" ? 0 : -1}
                  title={p.title}
                  className={`orb-petal${selected ? " active" : ""}`}
                  style={{
                    transform: `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) translate(-50%, -50%)`,
                  }}
                  onClick={() => onSelectPreset(p.id)}
                >
                  <span className="dp-top">
                    <span className="dp-idx">{String(idx + 1).padStart(2, "0")}</span>
                    <span className="dp-tag">{cat.tag}</span>
                  </span>
                  <span className="dp-title">
                    {SHORT_PRESET_NAMES[p.id] ?? p.title}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Outer Orbital Petals — Query Builder 5-Sector Ring (morphs in smoothly) */}
          <div
            className="orbital-ring-layer"
            role="tablist"
            aria-label="Query builder parameter dials"
            aria-hidden={mode !== "builder"}
            style={{
              opacity: Math.max(0, (morphProgress - 0.18) / 0.82),
              transform: `scale(${0.95 + morphProgress * 0.05})`,
              pointerEvents: mode === "builder" ? "auto" : "none",
            }}
          >
            {BUILDER_PETALS.map((petal, idx) => {
              const node = builderNodes[idx];
              if (!node) return null;
              const selected = petal.id === activePetal;
              const popOut = selected ? 10 : 0;
              const px = cx + (rx * 0.94 + popOut) * node.nx;
              const py = cy + (ry * 0.94 + popOut) * node.ny;
              return (
                <button
                  key={petal.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={mode === "builder" ? 0 : -1}
                  className={`orb-petal orb-petal-builder${selected ? " active" : ""}`}
                  style={{
                    transform: `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0) translate(-50%, -50%)`,
                  }}
                  onClick={() => onSelectPetal(petal.id)}
                >
                  <span className="dp-top">
                    <span className="dp-idx">{petal.code}</span>
                    <span className="dp-tag">{petal.title}</span>
                  </span>
                  <span className="dp-title">{builderSummaries[petal.id]}</span>
                </button>
              );
            })}
          </div>

          {/* Upper HUD Crown Bridge (connects orbital crown cleanly to the Central Core) */}
          <div className="orb-crown-bridge">
            <button
              type="button"
              className="dial-step-btn"
              aria-label="Previous dial item"
              onClick={() => stepSelection(-1)}
            >
              ‹
            </button>
            <div className="orb-crown-center">
              <div className="orb-crown-meta">
                <span className="dial-collar-kicker">
                  {mode === "presets"
                    ? `SECTOR ${String(activePresetIdx + 1).padStart(2, "0")} / ${String(presets.length || 11).padStart(2, "0")}`
                    : `BAY ${BUILDER_PETALS[activeBuilderIdx]?.code ?? "01"} · COMPOSER`}
                </span>
                <span className="orb-crown-sep" aria-hidden="true">·</span>
                <span className="dial-collar-deg mono">
                  AZ {Math.round(orbitalAngle + 194)}°
                </span>
              </div>
              <div className={`orb-phase-pill${running ? " live" : ""}`}>
                <span className="amber">{actDisplay.code}</span>
                <span>{actDisplay.name}</span>
              </div>
            </div>
            <button
              type="button"
              className="dial-step-btn"
              aria-label="Next dial item"
              onClick={() => stepSelection(1)}
            >
              ›
            </button>
          </div>

          {/* Central HUD Core embraced directly inside the orbital arch */}
          <div className="hud-core-shell">
            <div className="hud-core">{children}</div>
          </div>
        </div>
      ) : (
        /* Compact Tablet / Mobile Orbital Strip */
        <>
          <div className="dial-compact">
            <div className="dial-compact-head">
              <span className="dial-collar-kicker">
                {mode === "presets"
                  ? `SECTOR ${String(activePresetIdx + 1).padStart(2, "0")} / ${presets.length || 11}`
                  : `BUILDER · ${BUILDER_PETALS[activeBuilderIdx]?.title}`}
                {" · "}
                <span className="amber">{actDisplay.name}</span>
              </span>
              <div className="dial-compact-nav">
                <button
                  type="button"
                  className="dial-step-btn"
                  aria-label="Previous dial item"
                  onClick={() => stepSelection(-1)}
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="dial-step-btn"
                  aria-label="Next dial item"
                  onClick={() => stepSelection(1)}
                >
                  ›
                </button>
              </div>
            </div>
            <div className="dial-compact-rail" role="tablist">
              {mode === "presets"
                ? presets.map((p, idx) => (
                    <button
                      key={p.id}
                      type="button"
                      role="tab"
                      aria-selected={p.id === presetId}
                      className={`dial-chip${p.id === presetId ? " active" : ""}`}
                      onClick={() => onSelectPreset(p.id)}
                    >
                      <span className="dp-idx">{String(idx + 1).padStart(2, "0")}</span>
                      <span>{SHORT_PRESET_NAMES[p.id] ?? p.title}</span>
                    </button>
                  ))
                : BUILDER_PETALS.map((petal) => (
                    <button
                      key={petal.id}
                      type="button"
                      role="tab"
                      aria-selected={petal.id === activePetal}
                      className={`dial-chip${petal.id === activePetal ? " active" : ""}`}
                      onClick={() => onSelectPetal(petal.id)}
                    >
                      <span className="dp-idx">{petal.code}</span>
                      <span>{petal.title}</span>
                    </button>
                  ))}
            </div>
          </div>
          <div className="hud-core">{children}</div>
        </>
      )}
    </div>
  );
}
