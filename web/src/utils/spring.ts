/**
 * Pure spring physics, semicircular radial dial geometry, and
 * execution choreography timing math for TripGrid's controller cockpit.
 */

export interface SpringState {
  value: number;
  velocity: number;
}

export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass?: number;
  precision?: number;
}

export const DIAL_SPRING: SpringConfig = {
  stiffness: 260,
  damping: 22,
  mass: 1,
  precision: 0.001,
};

export const MORPH_SPRING: SpringConfig = {
  stiffness: 210,
  damping: 24,
  mass: 1,
  precision: 0.002,
};

/**
 * Advances a 1D damped harmonic spring toward `target` over `dtSeconds`.
 * Sub-steps internally so large frame deltas never destabilize the solver.
 */
export function stepSpring(
  state: SpringState,
  target: number,
  config: SpringConfig,
  dtSeconds: number,
): { state: SpringState; settled: boolean } {
  const mass = config.mass ?? 1;
  const precision = config.precision ?? 0.001;
  const clampedDt = Math.min(Math.max(dtSeconds, 0), 0.064);
  if (clampedDt === 0) {
    const done =
      Math.abs(target - state.value) <= precision &&
      Math.abs(state.velocity) <= precision;
    return { state, settled: done };
  }

  const maxStep = 0.008;
  const steps = Math.max(1, Math.ceil(clampedDt / maxStep));
  const h = clampedDt / steps;

  let x = state.value;
  let v = state.velocity;

  for (let i = 0; i < steps; i++) {
    const displacement = x - target;
    const springForce = -config.stiffness * displacement;
    const dampingForce = -config.damping * v;
    const accel = (springForce + dampingForce) / mass;
    v += accel * h;
    x += v * h;
  }

  if (Math.abs(target - x) <= precision && Math.abs(v) <= precision) {
    return { state: { value: target, velocity: 0 }, settled: true };
  }

  return { state: { value: x, velocity: v }, settled: false };
}

export interface ArcNodeLayout {
  index: number;
  angleDeg: number;
  angleRad: number;
  /** Normalized position [-1..1] horizontally and [0..1] vertically from arc center */
  nx: number;
  ny: number;
  /** Pixel offset from arc origin (cx, cy) */
  x: number;
  y: number;
}

/**
 * Computes evenly spaced nodes along an upper semicircular arc.
 * 0 deg = right (3 o'clock), -90 deg = straight up (12 o'clock), -180 deg = left (9 o'clock).
 */
export function computeArcNodes(
  count: number,
  radiusX: number,
  radiusY: number,
  startDeg = -172,
  endDeg = -8,
): ArcNodeLayout[] {
  if (count <= 0) return [];
  if (count === 1) {
    const mid = (startDeg + endDeg) / 2;
    const rad = (mid * Math.PI) / 180;
    return [
      {
        index: 0,
        angleDeg: mid,
        angleRad: rad,
        nx: Math.cos(rad),
        ny: Math.sin(rad),
        x: Math.cos(rad) * radiusX,
        y: Math.sin(rad) * radiusY,
      },
    ];
  }

  const nodes: ArcNodeLayout[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const angleDeg = startDeg + t * (endDeg - startDeg);
    const angleRad = (angleDeg * Math.PI) / 180;
    const nx = Math.cos(angleRad);
    const ny = Math.sin(angleRad);
    nodes.push({
      index: i,
      angleDeg,
      angleRad,
      nx,
      ny,
      x: nx * radiusX,
      y: ny * radiusY,
    });
  }
  return nodes;
}

/**
 * Generates an SVG elliptical arc path string centered at (cx, cy)
 * from `startDeg` to `endDeg`.
 */
export function describeEllipticalArc(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  startDeg: number,
  endDeg: number,
): string {
  const sRad = (startDeg * Math.PI) / 180;
  const eRad = (endDeg * Math.PI) / 180;
  const x1 = cx + rx * Math.cos(sRad);
  const y1 = cy + ry * Math.sin(sRad);
  const x2 = cx + rx * Math.cos(eRad);
  const y2 = cy + ry * Math.sin(eRad);
  const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const sweep = endDeg >= startDeg ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${rx} ${ry} 0 ${largeArc} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/**
 * Generates an SVG annular sector (curved HUD wedge) between inner and outer ellipses.
 */
export function describeEllipticalWedge(
  cx: number,
  cy: number,
  rxIn: number,
  ryIn: number,
  rxOut: number,
  ryOut: number,
  startDeg: number,
  endDeg: number,
): string {
  const sRad = (startDeg * Math.PI) / 180;
  const eRad = (endDeg * Math.PI) / 180;
  const ox1 = cx + rxOut * Math.cos(sRad);
  const oy1 = cy + ryOut * Math.sin(sRad);
  const ox2 = cx + rxOut * Math.cos(eRad);
  const oy2 = cy + ryOut * Math.sin(eRad);
  const ix2 = cx + rxIn * Math.cos(eRad);
  const iy2 = cy + ryIn * Math.sin(eRad);
  const ix1 = cx + rxIn * Math.cos(sRad);
  const iy1 = cy + ryIn * Math.sin(sRad);
  const largeArc = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
  const sweepOut = endDeg >= startDeg ? 1 : 0;
  const sweepIn = endDeg >= startDeg ? 0 : 1;
  return [
    `M ${ox1.toFixed(2)} ${oy1.toFixed(2)}`,
    `A ${rxOut} ${ryOut} 0 ${largeArc} ${sweepOut} ${ox2.toFixed(2)} ${oy2.toFixed(2)}`,
    `L ${ix2.toFixed(2)} ${iy2.toFixed(2)}`,
    `A ${rxIn} ${ryIn} 0 ${largeArc} ${sweepIn} ${ix1.toFixed(2)} ${iy1.toFixed(2)}`,
    "Z",
  ].join(" ");
}

export type BuilderPetalId =
  | "measures"
  | "dimensions"
  | "geography"
  | "schedule"
  | "range";

export interface BuilderPetalMeta {
  id: BuilderPetalId;
  code: string;
  title: string;
  hint: string;
}

export const BUILDER_PETALS: BuilderPetalMeta[] = [
  {
    id: "measures",
    code: "01",
    title: "Measures",
    hint: "Columns & percentiles",
  },
  {
    id: "dimensions",
    code: "02",
    title: "Group By",
    hint: "Row keys & sort limit",
  },
  {
    id: "geography",
    code: "03",
    title: "Geography",
    hint: "Boroughs, airports & zones",
  },
  {
    id: "schedule",
    code: "04",
    title: "Schedule & Trip",
    hint: "Hours, days, fare & speed",
  },
  {
    id: "range",
    code: "05",
    title: "Time Span",
    hint: "Months & calendar years",
  },
];

export type HudAct = "mechanical" | "analog" | "digital" | "locked";

export interface ChoreographyFrame {
  /** Overall 0..1 progress */
  progress: number;
  /** Cinematic FUI progression: mechanical -> analog -> digital -> locked */
  act: HudAct;
  /** 0 = Prune, 1 = Analog Trace, 2 = Digital Synthesis, 3 = Verify, 4 = Locked */
  stageIndex: number;
  /** 0..1 Act I mechanical ring lock & partition relay arming */
  mechanicalPct: number;
  /** 0..1 Act II NYC stencil outline tracing progress */
  tracePct: number;
  /** 0..1 Act II analog waveform & carrier stream intensity */
  analogPct: number;
  /** 0..1 partition matrix scan cursor sweep */
  scanPct: number;
  /** 0..1 Act III digital 8-thread synthesis & row materialization */
  digitalPct: number;
  /** 0..1 memory oscilloscope sweep */
  scopePct: number;
}

/**
 * 3-Act Mechanical -> Analog -> Digital execution choreography for TripGrid's FUI HUD:
 *   - Act I  (0.00 -> 0.28): Mechanical vernier ring lock, relay arming, index pruning
 *   - Act II (0.28 -> 0.66): Analog contour stencil pen-tracing + carrier oscilloscope + 8T disk stream
 *   - Act III(0.66 -> 1.00): Digital kernel synthesis, odometer row count, DuckDB parity lock
 */
export function computeChoreographyFrame(
  elapsedMs: number,
  durationMs = 2400,
): ChoreographyFrame {
  if (durationMs <= 0) {
    return {
      progress: 1,
      act: "locked",
      stageIndex: 4,
      mechanicalPct: 1,
      tracePct: 1,
      analogPct: 1,
      scanPct: 1,
      digitalPct: 1,
      scopePct: 1,
    };
  }

  const raw = Math.min(1, Math.max(0, elapsedMs / durationMs));
  const progress =
    raw < 0.5 ? 4 * raw * raw * raw : 1 - Math.pow(-2 * raw + 2, 3) / 2;

  const act: HudAct =
    raw >= 1
      ? "locked"
      : raw < 0.28
        ? "mechanical"
        : raw < 0.66
          ? "analog"
          : "digital";

  const stageIndex =
    raw >= 1
      ? 4
      : raw < 0.26
        ? 0
        : raw < 0.6
          ? 1
          : raw < 0.86
            ? 2
            : 3;

  // Act I: Mechanical lock & index pruning (0.00 -> 0.28)
  const mechRaw = Math.min(1, Math.max(0, raw / 0.28));
  const mechanicalPct = 1 - Math.pow(1 - mechRaw, 2);

  // Act II: Analog pen-tracing stencil (0.20 -> 0.64)
  const traceRaw = Math.min(1, Math.max(0, (raw - 0.2) / 0.44));
  const tracePct = 1 - Math.pow(1 - traceRaw, 2.1);

  // Act II: Analog carrier signal wave (0.24 -> 0.72)
  const analogRaw = Math.min(1, Math.max(0, (raw - 0.24) / 0.48));
  const analogPct = analogRaw;

  // Partition matrix sweeps smoothly across Analog -> Digital (0.18 -> 0.88)
  const scanRaw = Math.min(1, Math.max(0, (raw - 0.18) / 0.7));
  const scanPct = scanRaw;

  // Act III: Digital synthesis & odometer buildup (0.62 -> 1.00)
  const digRaw = Math.min(1, Math.max(0, (raw - 0.62) / 0.38));
  const digitalPct = digRaw < 0.5 ? 2 * digRaw * digRaw : 1 - Math.pow(-2 * digRaw + 2, 2) / 2;

  const scopePct = Math.min(1, Math.max(0.06, raw));

  return {
    progress,
    act,
    stageIndex,
    mechanicalPct,
    tracePct,
    analogPct,
    scanPct,
    digitalPct,
    scopePct,
  };
}
