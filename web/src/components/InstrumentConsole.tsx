import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BuilderCatalogue,
  Meta,
  PresetInfo,
  SpecDict,
  SpecJobPayload,
  ValidateResult,
  ZoneMap,
} from "../api";
import PresetCatalog from "./PresetCatalog";
import BuilderPanel, {
  draftFromSpec,
  type BuilderDraft,
} from "./BuilderPanel";
import RangeGrid from "./RangeGrid";
import SpecResults from "./SpecResults";
import EngineTheater from "./EngineTheater";
import {
  formatCompactNumber,
  resolveEffectiveRange,
  rowsToCsv,
} from "../utils/instrument";
import { useAnimatedNumber } from "../utils/motion";

const fmt = (n: number) => n.toLocaleString("en-US");

interface Props {
  meta: Meta | null;
  zones: ZoneMap;
  presets: PresetInfo[];
  catalogue: BuilderCatalogue | null;
  mode: "presets" | "builder";
  onModeChange: (mode: "presets" | "builder") => void;
  presetId: string;
  onSelectPreset: (id: string) => void;
  range: [string, string] | null;
  onRangeChange: (range: [string, string] | null) => void;
  draft: BuilderDraft;
  onDraftChange: (draft: BuilderDraft) => void;
  effectiveSpec: SpecDict | null;
  gate: ValidateResult | null;
  running: boolean;
  fresh: boolean;
  onToggleFresh: () => void;
  filesDone: number;
  filesTotal: number;
  status: string;
  payload: SpecJobPayload | null;
  onRun: () => void;
}

/**
 * The Instrument Workbench (Section 01):
 *   1. Clean Command Bar (Mode switch | Gate budget gauge, Fresh toggle, Run CTA)
 *   2. Control Deck (Preset Catalog + Dossier OR 3-Bay Builder + Blueprint Dossier)
 *   3. Compact Archive Range Strip
 *   4. Animated 5-Column Execution Telemetry Strip
 *   5. Live Engine Theater & Results Stage
 */
export default function InstrumentConsole({
  meta,
  zones,
  presets,
  catalogue,
  mode,
  onModeChange,
  presetId,
  onSelectPreset,
  range,
  onRangeChange,
  draft,
  onDraftChange,
  effectiveSpec,
  gate,
  running,
  fresh,
  onToggleFresh,
  filesDone,
  filesTotal,
  status,
  payload,
  onRun,
}: Props) {
  const [showReceiptTheater, setShowReceiptTheater] = useState(false);
  const resultsStageRef = useRef<HTMLDivElement>(null);
  const wasRunningRef = useRef(false);

  useEffect(() => {
    if (running && !wasRunningRef.current && resultsStageRef.current) {
      resultsStageRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
      });
    }
    wasRunningRef.current = running;
  }, [running]);

  const activePreset = presets.find((p) => p.id === presetId);
  const isAudit = mode === "presets" && activePreset?.kind === "audit";
  const months = meta?.months ?? [];
  const stats = payload?.stats;

  const effectiveRange = useMemo(
    () =>
      resolveEffectiveRange(
        range,
        mode === "presets" ? activePreset?.spec : undefined,
        months,
        isAudit,
      ),
    [range, mode, activePreset, months, isAudit],
  );

  // Smoothly animated numeric telemetry roll-ins
  const animWall = useAnimatedNumber(stats ? stats.wall_seconds : null, 480);
  const animPeak = useAnimatedNumber(stats ? stats.peak_rss_mb : null, 520);
  const animRows = useAnimatedNumber(stats ? stats.rows_scanned : null, 600);
  const throughputTarget =
    stats && stats.wall_seconds > 0
      ? stats.rows_scanned / stats.wall_seconds / 1_000_000
      : null;
  const animThroughput = useAnimatedNumber(throughputTarget, 520);

  const handleCustomizePreset = useCallback(
    (preset: PresetInfo) => {
      if (!preset.spec) return;
      onDraftChange(draftFromSpec(preset.spec));
      if (!range && Array.isArray(preset.spec.range)) {
        const clamped = resolveEffectiveRange(null, preset.spec, months, false);
        onRangeChange(clamped);
      }
      onModeChange("builder");
    },
    [onDraftChange, onModeChange, onRangeChange, range, months],
  );

  const handleExportCsv = useCallback(() => {
    if (!payload) return;
    const csv = rowsToCsv(payload);
    if (!csv) return;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const slug = (payload.result.title || "tripgrid-result")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const link = document.createElement("a");
    link.href = url;
    link.download = `${slug || "tripgrid"}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [payload]);

  const gateRatio =
    gate?.ok && gate.gate && gate.gate.budget > 0
      ? Math.min(100, (gate.gate.buckets / gate.gate.budget) * 100)
      : 0;
  const gateBlocked = !isAudit && gate !== null && !gate.ok;
  const scanPct =
    running && filesTotal > 0
      ? Math.min(100, (filesDone / filesTotal) * 100)
      : payload
        ? 100
        : 0;

  const activeTitle =
    mode === "presets" && activePreset ? activePreset.title : "Custom query recipe";

  return (
    <div className="instrument" data-testid="instrument-console">
      {/* ---------- 1. CLEAN COMMAND BAR (no Active Query clutter) ---------- */}
      <div className="cmdbar cmdbar-clean">
        <div className="cmd-modes" role="tablist" aria-label="Instrument mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "presets"}
            className={mode === "presets" ? "on" : ""}
            onClick={() => onModeChange("presets")}
          >
            Presets
            <span className="cmd-count">{presets.length || 11}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "builder"}
            className={mode === "builder" ? "on" : ""}
            onClick={() => onModeChange("builder")}
          >
            Query Builder
          </button>
        </div>

        <div className="cmd-exec">
          {/* Compact Gate Budget Meter */}
          <div
            className={`cmd-gate${gateBlocked ? " bad" : ""}`}
            aria-live="polite"
          >
            <div className="cmd-gate-top">
              <span className="cmd-gate-k">Gate</span>
              <span className="cmd-gate-v">
                {isAudit
                  ? "4 counts · O(1)"
                  : gate
                    ? gate.ok && gate.gate
                      ? `${formatCompactNumber(gate.gate.buckets)} / ${formatCompactNumber(gate.gate.budget)}`
                      : "Over budget"
                    : "Pricing…"}
              </span>
            </div>
            <div className="cmd-gate-bar">
              <i
                style={{
                  width: isAudit
                    ? "6%"
                    : gateBlocked
                      ? "100%"
                      : `${Math.max(gateRatio, gate?.ok ? 3 : 0)}%`,
                }}
              />
            </div>
          </div>

          <button
            type="button"
            className={`cmd-fresh${fresh ? " on" : ""}`}
            aria-pressed={fresh}
            title="Skip server cache and execute live from disk"
            onClick={onToggleFresh}
          >
            {fresh ? "Fresh: On" : "Cache: On"}
          </button>

          <button
            type="button"
            className={`cmd-run${running ? " scanning" : ""}`}
            disabled={running || gateBlocked}
            onClick={onRun}
          >
            {running
              ? filesTotal > 0
                ? `Scanning ${filesDone}/${filesTotal}`
                : "Scanning…"
              : "Run Query"}
          </button>
        </div>
      </div>

      {/* Inline Gate Refusal Banner */}
      {gateBlocked && gate?.error && (
        <div className="gate-banner" role="alert">
          <span className="gate-banner-tag">GATE REFUSED</span>
          <span className="gate-banner-msg">{gate.error}</span>
        </div>
      )}

      {/* ---------- 2. STRUCTURED CONTROL DECK ---------- */}
      <div className="inst-deck" key={mode}>
        {mode === "presets" ? (
          <PresetCatalog
            presets={presets}
            presetId={presetId}
            onSelectPreset={onSelectPreset}
            catalogue={catalogue}
            zones={zones}
            rangeOverride={range}
            onClearRange={() => onRangeChange(null)}
            gate={gate}
            onCustomizeInBuilder={handleCustomizePreset}
            onSwitchToBuilder={() => onModeChange("builder")}
          />
        ) : catalogue ? (
          <BuilderPanel
            catalogue={catalogue}
            zones={zones}
            presets={presets}
            draft={draft}
            gate={gate}
            onChange={onDraftChange}
          />
        ) : (
          <div className="inst-loading">
            <span className="mono">Loading Query Builder catalogue…</span>
          </div>
        )}
      </div>

      {/* ---------- 3. ARCHIVE RANGE MAP ---------- */}
      <RangeGrid
        months={months}
        monthRows={meta?.month_rows ?? {}}
        value={range}
        effectiveRange={effectiveRange}
        mode={mode}
        isAudit={isAudit}
        onChange={onRangeChange}
      />

      {/* ---------- 4. ANIMATED EXECUTION TELEMETRY STRIP ---------- */}
      <div className={`telemetry-bar${payload ? " locked" : ""}`}>
        <div className="runstats-v2">
          <div className="tstat">
            <span className="label">Wall time</span>
            <div className="v">
              {animWall !== null ? `${animWall.toFixed(2)}s` : "—"}
            </div>
          </div>
          <div className="tstat">
            <span className="label">Peak memory</span>
            <div className="v">
              {animPeak !== null ? `${Math.round(animPeak)} MB` : "—"}
              <span className="tunit"> / 2,048</span>
            </div>
            <div className="gauge">
              <div
                className="fill"
                style={{
                  width: stats
                    ? `${Math.min(100, (stats.peak_rss_mb / 2048) * 100)}%`
                    : "0%",
                }}
              />
              <div className="ceil" />
            </div>
          </div>
          <div className="tstat">
            <span className="label">Rows scanned</span>
            <div className="v">
              {animRows !== null ? fmt(Math.round(animRows)) : "—"}
            </div>
          </div>
          <div className="tstat">
            <span className="label">Files read</span>
            <div className="v">
              {running
                ? `${filesDone} / ${filesTotal || "—"}`
                : stats
                  ? `${stats.files_read} / ${stats.partitions_selected}`
                  : "—"}
            </div>
            <div className="gauge">
              <div className="fill" style={{ width: `${scanPct}%` }} />
            </div>
          </div>
          <div className="tstat">
            <span className="label">Throughput</span>
            <div className="v">
              {animThroughput !== null
                ? `${animThroughput.toFixed(1)}M /s`
                : "—"}
            </div>
          </div>
        </div>
        {status.startsWith("Failed") && (
          <div className="gate-banner" role="alert">
            <span className="gate-banner-tag">SCAN FAILED</span>
            <span className="gate-banner-msg">{status}</span>
          </div>
        )}
      </div>

      {/* ---------- 5. LIVE ENGINE THEATER & RESULTS STAGE ---------- */}
      <div className="results-stage" ref={resultsStageRef}>
        {running ? (
          <EngineTheater
            phase="scanning"
            title={activeTitle}
            months={months}
            effectiveRange={effectiveRange}
            effectiveSpec={effectiveSpec}
            zones={zones}
            isAudit={isAudit}
            gate={gate}
            gateBlocked={gateBlocked}
            filesDone={filesDone}
            filesTotal={filesTotal}
            payload={null}
          />
        ) : payload ? (
          <div className="result-v2">
            <div className="result-head-v2">
              <div className="result-title-group">
                <span className="result-kind">
                  {payload.result.kind === "audit"
                    ? "Audit"
                    : mode === "builder"
                      ? "Builder"
                      : "Preset"}
                </span>
                <h3>{payload.result.title}</h3>
              </div>

              <div className="result-meta-actions">
                <span className="result-meta-text">
                  {payload.result.rows.length} row
                  {payload.result.rows.length === 1 ? "" : "s"}
                  {payload.result.gate
                    ? ` · ${payload.result.gate.shape}`
                    : ""}
                  {payload.cached ? " · Served from memory" : " · Live scan"}
                </span>
                <button
                  type="button"
                  className={`csv-btn${showReceiptTheater ? " on" : ""}`}
                  aria-expanded={showReceiptTheater}
                  onClick={() => setShowReceiptTheater((v) => !v)}
                >
                  {showReceiptTheater ? "Hide Engine Map" : "Engine Map"}
                </button>
                {payload.result.rows.length > 0 && (
                  <button
                    type="button"
                    className="csv-btn"
                    onClick={handleExportCsv}
                  >
                    Export CSV
                  </button>
                )}
              </div>
            </div>

            {showReceiptTheater && (
              <div className="receipt-theater-wrap">
                <EngineTheater
                  phase="done"
                  title={payload.result.title}
                  months={months}
                  effectiveRange={effectiveRange}
                  effectiveSpec={effectiveSpec}
                  zones={zones}
                  isAudit={isAudit}
                  gate={gate}
                  gateBlocked={false}
                  filesDone={payload.stats.files_read}
                  filesTotal={payload.stats.partitions_selected}
                  payload={payload}
                />
              </div>
            )}

            <div className="resultscroll-v2">
              <SpecResults payload={payload} catalogue={catalogue} />
            </div>
          </div>
        ) : (
          <EngineTheater
            phase="ready"
            title={activeTitle}
            months={months}
            effectiveRange={effectiveRange}
            effectiveSpec={effectiveSpec}
            zones={zones}
            isAudit={isAudit}
            gate={gate}
            gateBlocked={gateBlocked}
            filesDone={0}
            filesTotal={0}
            payload={null}
            onRun={onRun}
          />
        )}
      </div>
    </div>
  );
}
