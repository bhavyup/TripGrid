import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { SpecDict, ZoneMap } from "../api";
import {
  NYC_BOROUGHS,
  resolveActiveGeography,
  type NycBoroughName,
} from "../utils/instrument";

interface Props {
  phase: "ready" | "scanning" | "done";
  effectiveSpec: SpecDict | null;
  zones: ZoneMap;
  isAudit: boolean;
  /** 0..1 progress of stencil pen-tracing animation */
  tracePct: number;
  /** 0..1 progress of overall scan */
  progress: number;
  compact?: boolean;
}

interface BoroughGeometry {
  name: NycBoroughName;
  code: string;
  path: string;
  detailPaths?: string[];
  labelX: number;
  labelY: number;
  busAnchorX: number;
  busAnchorY: number;
}

/**
 * Multi-vertex cartographic stencil silhouettes of New York City's five boroughs,
 * plotted in a 380x340 projection (Hudson west, Upper Harbor center, Jamaica Bay SE).
 */
const BOROUGH_STENCILS: BoroughGeometry[] = [
  {
    name: "Bronx",
    code: "BX",
    path:
      "M 176 42 L 182 22 L 210 18 L 246 22 L 266 36 L 262 56 L 274 68 L 258 82 L 242 78 L 236 90 L 218 92 L 204 86 L 186 88 L 178 72 Z",
    detailPaths: [
      "M 192 48 L 248 44",
      "M 214 26 L 218 78",
    ],
    labelX: 222,
    labelY: 56,
    busAnchorX: 234,
    busAnchorY: 60,
  },
  {
    name: "Manhattan",
    code: "MN",
    path:
      "M 174 44 L 178 68 L 171 92 L 166 114 L 161 138 L 158 164 L 162 178 L 152 192 L 142 204 L 134 202 L 136 184 L 141 154 L 146 126 L 154 96 L 162 68 L 168 48 Z",
    detailPaths: [
      // Central Park stencil cutout
      "M 157 98 L 164 99 L 159 124 L 152 123 Z",
      // Midtown street grid ticks
      "M 145 140 L 158 142 M 143 152 L 157 154 M 141 164 L 156 166",
    ],
    labelX: 152,
    labelY: 150,
    busAnchorX: 158,
    busAnchorY: 136,
  },
  {
    name: "Queens",
    code: "QN",
    path:
      "M 174 114 L 194 102 L 212 96 L 224 106 L 236 98 L 258 88 L 284 86 L 314 96 L 328 118 L 322 152 L 312 184 L 298 206 L 286 222 L 266 220 L 254 204 L 236 212 L 222 196 L 204 172 L 182 156 L 168 144 Z",
    detailPaths: [
      // Rockaway barrier spit
      "M 218 256 L 268 242 L 304 234 L 306 241 L 266 250 L 220 262 Z",
      // Flushing / Queens Blvd arterial
      "M 178 134 L 246 144 L 304 152",
    ],
    labelX: 256,
    labelY: 150,
    busAnchorX: 266,
    busAnchorY: 132,
  },
  {
    name: "Brooklyn",
    code: "BK",
    path:
      "M 166 148 L 182 158 L 204 174 L 218 196 L 230 218 L 218 242 L 196 254 L 186 274 L 164 282 L 140 278 L 136 266 L 146 258 L 124 246 L 122 224 L 134 212 L 132 198 L 144 186 L 154 174 Z",
    detailPaths: [
      // Prospect Park + Atlantic Ave stencil
      "M 164 206 L 176 208 L 172 222 L 160 218 Z",
      "M 150 184 L 204 198",
    ],
    labelX: 168,
    labelY: 236,
    busAnchorX: 184,
    busAnchorY: 214,
  },
  {
    name: "Staten Island",
    code: "SI",
    path:
      "M 96 240 L 108 248 L 112 262 L 102 276 L 88 288 L 72 302 L 46 318 L 24 326 L 18 314 L 32 294 L 42 272 L 46 248 L 68 242 Z",
    detailPaths: [
      "M 52 266 L 94 260",
      "M 42 296 L 84 276",
    ],
    labelX: 68,
    labelY: 280,
    busAnchorX: 86,
    busAnchorY: 262,
  },
];

const BRIDGES: { name: string; d: string }[] = [
  { name: "GW Bridge", d: "M 136 68 L 164 72" },
  { name: "Queensboro", d: "M 161 138 L 173 136" },
  { name: "Brooklyn/Manhattan", d: "M 152 186 L 160 188 M 148 194 L 155 196" },
  { name: "Verrazzano", d: "M 110 258 L 124 252" },
  { name: "RFK / Triboro", d: "M 172 100 L 188 102" },
];

const AIRPORTS: {
  code: "JFK" | "LGA" | "EWR";
  x: number;
  y: number;
  borough: string;
}[] = [
  { code: "LGA", x: 214, y: 103, borough: "Queens" },
  { code: "JFK", x: 274, y: 206, borough: "Queens" },
  { code: "EWR", x: 48, y: 188, borough: "Newark" },
];

export default function StencilNycMap({
  phase,
  effectiveSpec,
  zones,
  isAudit,
  tracePct,
  progress,
  compact = false,
}: Props) {
  const [hovered, setHovered] = useState<NycBoroughName | null>(null);

  // 3D parallax tilt, restored from the pre-step-1 theater: the map rests
  // at a slight isometric lean and follows the cursor; reduced-motion
  // users keep the rest lean with no mouse follow.
  const [tilt, setTilt] = useState({ rx: 14, ry: -4 });
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const handleMapMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (prefersReducedMotion) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ rx: 14 - ny * 10, ry: -4 + nx * 12 });
  };
  const resetTilt = () => setTilt({ rx: 14, ry: -4 });

  const geo = useMemo(
    () => resolveActiveGeography(effectiveSpec, zones, isAudit),
    [effectiveSpec, zones, isAudit],
  );

  const activeBoroughs = useMemo(() => new Set(geo.boroughs), [geo.boroughs]);
  const activeAirports = useMemo(() => new Set(geo.airports), [geo.airports]);

  // Effective trace ratio: in ready state show full crisp stencil outline;
  // during scanning trace smoothly from 0 -> 1; in done state lock at 1.
  const drawRatio = phase === "ready" ? 1 : phase === "done" ? 1 : tracePct;
  const dashOffset = (1 - drawRatio) * 100;
  const fillOpacity =
    phase === "ready"
      ? 0.16
      : phase === "done"
        ? 0.24
        : 0.04 + Math.max(0, (drawRatio - 0.35) / 0.65) * 0.22;

  const busX = 338;
  const busY = 44;

  return (
    <div
      className={`stencil-map-wrap${compact ? " compact" : ""}`}
      onMouseMove={handleMapMove}
      onMouseLeave={resetTilt}
    >
      <div className="theater-pane-head">
        <span className="theater-kicker">NYC CARTOGRAPHIC STENCIL</span>
        <span className="theater-badge">
          {hovered
            ? `${hovered.toUpperCase()} · ${activeBoroughs.has(hovered) ? "IN SCOPE" : "PRUNED"}`
            : geo.prunedCount === 0
              ? `${NYC_BOROUGHS.length} / 5 BOROUGHS`
              : `${geo.boroughs.length} ACTIVE · ${geo.prunedCount} PRUNED`}
        </span>
      </div>

      <div
        className="stencil-frame"
        style={{
          transform: `perspective(1000px) rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`,
        }}
      >
        <svg
          className="stencil-svg"
          viewBox="0 0 380 340"
          role="img"
          aria-label={`NYC Stencil Map: ${geo.boroughs.join(", ") || "airports"} active`}
        >
          <defs>
            {/* Subtle cartographic drafting grid */}
            <pattern
              id="stencilGrid"
              width="24"
              height="24"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 24 0 L 0 0 0 24"
                fill="none"
                stroke="rgba(233, 227, 214, 0.055)"
                strokeWidth="0.65"
              />
            </pattern>

            {/* Architectural diagonal stencil hatch for active boroughs */}
            <pattern
              id="stencilHatchActive"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(42)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke="#ffb224"
                strokeWidth="1.05"
                strokeOpacity="0.48"
              />
            </pattern>

            {/* Subtle muted hatch for pruned boroughs so they remain clearly legible */}
            <pattern
              id="stencilHatchPruned"
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(-38)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="7"
                stroke="#a79e8d"
                strokeWidth="0.6"
                strokeOpacity="0.16"
              />
            </pattern>
          </defs>

          <rect x="0" y="0" width="380" height="340" fill="url(#stencilGrid)" />

          {/* NJ / Newark mainland stencil silhouette on far west */}
          <path
            d="M 10 18 L 122 18 L 116 68 L 106 124 L 96 176 L 78 214 L 46 232 L 10 240 Z"
            className="stencil-nj"
          />
          <text x="20" y="138" className="stencil-water-lbl">
            NEW JERSEY
          </text>

          {/* Harbor & river bathymetric contour lines */}
          <path
            d="M 136 12 C 134 78, 128 142, 118 212 C 114 234, 118 262, 124 300"
            className="stencil-waterway"
          />
          <path
            d="M 164 96 C 174 114, 168 148, 158 178 C 146 198, 128 214, 118 232"
            className="stencil-waterway"
          />
          <text x="108" y="88" className="stencil-water-lbl" transform="rotate(-82 108 88)">
            HUDSON R.
          </text>
          <text x="106" y="324" className="stencil-water-lbl">
            LOWER NY BAY
          </text>

          {/* Bridges */}
          {BRIDGES.map((br) => (
            <path key={br.name} d={br.d} className="stencil-bridge" />
          ))}

          {/* Five NYC Borough Stencils */}
          {BOROUGH_STENCILS.map((b, idx) => {
            const active = activeBoroughs.has(b.name);
            return (
              <g
                key={b.name}
                className={`stencil-borough${active ? " active" : " pruned"}`}
                onMouseEnter={() => setHovered(b.name)}
                onMouseLeave={() => setHovered(null)}
              >
                {/* Base architectural stencil silhouette (always visible) */}
                <path
                  d={b.path}
                  className="stencil-base"
                  fill={active ? "url(#stencilHatchActive)" : "url(#stencilHatchPruned)"}
                  style={{
                    fillOpacity: active ? fillOpacity : 0.85,
                  }}
                />

                {/* Interior stencil details (parks, arterials) */}
                {b.detailPaths?.map((dp, di) => (
                  <path key={di} d={dp} className="stencil-detail" />
                ))}

                {/* Animated Pen-Tracing Stencil Contour */}
                {active && (
                  <path
                    d={b.path}
                    pathLength={100}
                    className={`stencil-trace${phase === "scanning" ? " tracing" : ""}`}
                    style={{
                      strokeDasharray: "100",
                      strokeDashoffset: dashOffset,
                      transition:
                        phase === "ready"
                          ? "stroke-dashoffset 450ms cubic-bezier(0.16, 1, 0.3, 1)"
                          : undefined,
                    }}
                  />
                )}

                {/* Corner registration ticks when active */}
                {active && (
                  <circle
                    cx={b.busAnchorX}
                    cy={b.busAnchorY}
                    r={phase === "scanning" ? 3 : 2.2}
                    className="stencil-node"
                  />
                )}

                {/* Borough code label */}
                <text
                  x={b.labelX}
                  y={b.labelY}
                  textAnchor="middle"
                  className="stencil-blabel"
                >
                  {b.code}
                </text>

                {/* Stream arc to 8-Thread Kernel Collector */}
                {active && (phase === "scanning" || phase === "done") && (
                  <path
                    d={`M ${b.busAnchorX} ${b.busAnchorY} Q ${(b.busAnchorX + busX) / 2} ${Math.min(b.busAnchorY, busY) - 24}, ${busX} ${busY}`}
                    pathLength={100}
                    className={`stencil-stream${phase === "scanning" ? " live" : " settled"}`}
                    style={{
                      opacity: phase === "done" ? 0.35 : Math.min(0.85, progress * 1.4),
                      animationDelay: `${idx * 90}ms`,
                    }}
                  />
                )}
              </g>
            );
          })}

          {/* Airport Runway Stencils */}
          {AIRPORTS.map((ap, apIdx) => {
            const active = activeAirports.has(ap.code);
            return (
              <g
                key={ap.code}
                className={`stencil-airport${active ? " active" : " pruned"}`}
              >
                {active && (phase === "scanning" || phase === "done") && (
                  <path
                    d={`M ${ap.x} ${ap.y} Q ${(ap.x + busX) / 2} ${Math.min(ap.y, busY) - 18}, ${busX} ${busY}`}
                    pathLength={100}
                    className={`stencil-stream${phase === "scanning" ? " live" : " settled"}`}
                    style={{
                      opacity: phase === "done" ? 0.35 : Math.min(0.82, progress * 1.4),
                      animationDelay: `${apIdx * 110}ms`,
                    }}
                  />
                )}
                {active && phase === "scanning" && (
                  <circle
                    cx={ap.x}
                    cy={ap.y}
                    r="11"
                    className="nyc-beacon-ring"
                  />
                )}
                {active && (
                  <rect
                    x={ap.x - 7}
                    y={ap.y - 7}
                    width="14"
                    height="14"
                    className="stencil-airport-box"
                  />
                )}
                {/* Crossed runway stencil */}
                <path
                  d={`M ${ap.x - 5} ${ap.y - 3} L ${ap.x + 5} ${ap.y + 3} M ${ap.x - 4} ${ap.y + 4} L ${ap.x + 4} ${ap.y - 4}`}
                  className="stencil-runway"
                />
                <circle cx={ap.x} cy={ap.y} r="2.2" className="nyc-beacon-dot" />
                <text x={ap.x + 10} y={ap.y + 3} className="stencil-airport-lbl">
                  {ap.code}
                </text>
              </g>
            );
          })}

          {/* 8-Thread Kernel Collector Reticle */}
          <g className={`stencil-bus${phase === "scanning" ? " live" : ""}`}>
            <rect
              x={busX - 20}
              y={busY - 11}
              width="40"
              height="22"
              className="nyc-bus-box"
            />
            <text
              x={busX}
              y={busY + 3.5}
              textAnchor="middle"
              className="nyc-bus-txt"
            >
              8T BUS
            </text>
          </g>

          {/* Drafting Corner Crosshairs & Scale Bar */}
          <text x="12" y="16" className="nyc-coord">
            40°42&prime;N · 74°00&prime;W · EPSG:2263
          </text>
          <g transform="translate(274, 322)">
            <line x1="0" y1="0" x2="64" y2="0" stroke="rgba(167, 158, 141, 0.45)" strokeWidth="1" />
            <line x1="0" y1="-3" x2="0" y2="3" stroke="rgba(167, 158, 141, 0.45)" strokeWidth="1" />
            <line x1="32" y1="-2" x2="32" y2="2" stroke="rgba(167, 158, 141, 0.45)" strokeWidth="1" />
            <line x1="64" y1="-3" x2="64" y2="3" stroke="rgba(167, 158, 141, 0.45)" strokeWidth="1" />
            <text x="68" y="3" className="nyc-coord">
              10 MI
            </text>
          </g>
        </svg>
      </div>

      <div className="nyc-legend">
        <span>
          <i className="sw-b active" /> Traced &amp; scanned
        </span>
        <span>
          <i className="sw-b pruned" /> Pruned before read
        </span>
        <span className="legend-trace-pct mono">
          {phase === "scanning"
            ? `TRACE ${Math.round(drawRatio * 100)}%`
            : phase === "done"
              ? "TRACE LOCKED"
              : "STENCIL READY"}
        </span>
      </div>
    </div>
  );
}
