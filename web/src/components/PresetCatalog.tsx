import { useMemo, useState } from "react";
import type {
  BuilderCatalogue,
  PresetInfo,
  ValidateResult,
  ZoneMap,
} from "../api";
import {
  PRESET_CATEGORY_TABS,
  describeActiveFilters,
  filterPresetsByCategory,
  formatCompactNumber,
  formatPresetDefaultSpan,
  getPresetCategory,
  type PresetCategoryId,
} from "../utils/instrument";

const fmt = (n: number) => n.toLocaleString("en-US");

interface Props {
  presets: PresetInfo[];
  presetId: string;
  onSelectPreset: (id: string) => void;
  catalogue: BuilderCatalogue | null;
  zones: ZoneMap;
  rangeOverride: [string, string] | null;
  onClearRange: () => void;
  gate: ValidateResult | null;
  onCustomizeInBuilder: (preset: PresetInfo) => void;
  onSwitchToBuilder: () => void;
  /** A query is running: the running preset stays highlighted,
      everything else in the deck goes inert and faded. */
  running: boolean;
}

/**
 * Structured Preset Catalog: replaces the sprawling 11-row text dump
 * with a categorized 2-column archival index matrix paired with an
 * always-visible Active Preset Dossier showing the recipe blueprint.
 */
export default function PresetCatalog({
  presets,
  presetId,
  onSelectPreset,
  catalogue,
  zones,
  rangeOverride,
  onClearRange,
  gate,
  onCustomizeInBuilder,
  onSwitchToBuilder,
  running,
}: Props) {
  const [category, setCategory] = useState<PresetCategoryId>("all");

  const counts = useMemo(() => {
    const map: Record<PresetCategoryId, number> = {
      all: presets.length,
      policy: 0,
      flows: 0,
      benchmarks: 0,
      audit: 0,
    };
    for (const p of presets) {
      map[getPresetCategory(p).id] += 1;
    }
    return map;
  }, [presets]);

  const visiblePresets = useMemo(
    () => filterPresetsByCategory(presets, category),
    [presets, category],
  );

  const indexById = useMemo(
    () => new Map(presets.map((p, i) => [p.id, i + 1])),
    [presets],
  );

  const activePreset = presets.find((p) => p.id === presetId) ?? presets[0];
  const activeMeta = activePreset ? getPresetCategory(activePreset) : null;
  const activeIndex = activePreset ? (indexById.get(activePreset.id) ?? 1) : 1;

  const measureMap = useMemo(
    () => new Map((catalogue?.measures ?? []).map((m) => [m.id, m.label])),
    [catalogue],
  );
  const dimMap = useMemo(
    () => new Map((catalogue?.dimensions ?? []).map((d) => [d.id, d.label])),
    [catalogue],
  );

  const activeFilters = useMemo(
    () =>
      activePreset?.spec
        ? describeActiveFilters(activePreset.spec.filters, catalogue, zones)
        : [],
    [activePreset, catalogue, zones],
  );

  if (presets.length === 0) {
    return (
      <div className="inst-loading">
        <span className="mono">Loading preset index…</span>
      </div>
    );
  }

  return (
    <div
      className={`preset-deck${running ? " locked" : ""}`}
      inert={running}
    >
      {/* Category filter rail */}
      <div className="cat-rail" role="tablist" aria-label="Preset categories">
        {PRESET_CATEGORY_TABS.map((tab) => {
          const active = category === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`cat-tab${active ? " on" : ""}`}
              onClick={() => setCategory(tab.id)}
            >
              <span>{tab.label}</span>
              <span className="cat-count">{counts[tab.id]}</span>
            </button>
          );
        })}
      </div>

      {/* 2-pane split: compact 2-col index matrix | active dossier */}
      <div className="preset-split">
        <div
          className="preset-matrix"
          role="listbox"
          aria-label="Preset analytical questions"
        >
          {visiblePresets.map((p) => {
            const num = indexById.get(p.id) ?? 1;
            const meta = getPresetCategory(p);
            const isSelected = p.id === presetId;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`pcell${isSelected ? " active" : ""}`}
                onClick={() => onSelectPreset(p.id)}
              >
                <div className="pcell-meta">
                  <span className="pcell-meta-left">
                    <span className="pcell-num">
                      {String(num).padStart(2, "0")}
                    </span>
                    <span className="sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="pcell-tag">{meta.tag}</span>
                  </span>
                  <span className="pcell-span">
                    {formatPresetDefaultSpan(p.spec)}
                  </span>
                </div>
                <div className="pcell-title">{p.title}</div>
              </button>
            );
          })}
          {visiblePresets.length % 2 === 1 && (
            <button
              type="button"
              className="pcell pcell-cta"
              onClick={onSwitchToBuilder}
            >
              <div className="pcell-meta">
                <span className="pcell-meta-left">
                  <span className="pcell-num amber">+</span>
                  <span className="sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="pcell-tag">Custom Recipe</span>
                </span>
                <span className="pcell-span">Builder</span>
              </div>
              <div className="pcell-title">Compose your own question →</div>
            </button>
          )}
        </div>

        {/* Right pane: Active Preset Dossier */}
        {activePreset && (
          <aside className="preset-dossier" aria-label="Selected preset details">
            <div className="dossier-kicker">
              <span className="amber">
                {String(activeIndex).padStart(2, "0")}
              </span>
              <span className="sep" aria-hidden="true">/</span>
              <span>{activeMeta?.label}</span>
              {activePreset.kind === "audit" ? (
                <>
                  <span className="sep" aria-hidden="true">·</span>
                  <span>Multi-pass audit</span>
                </>
              ) : activePreset.spec?.top_k ? (
                <>
                  <span className="sep" aria-hidden="true">·</span>
                  <span>Top {activePreset.spec.top_k}</span>
                </>
              ) : null}
            </div>

            <h3 className="dossier-title">{activePreset.title}</h3>
            <p className="dossier-note">{activePreset.note}</p>

            {activePreset.kind === "audit" ? (
              <div className="dossier-ledger">
                <div className="drow drow-stack">
                  <span className="dkey">Four checks</span>
                  <ol className="audit-parts">
                    {(activePreset.parts ?? []).map((part, idx) => (
                      <li key={part.name}>
                        <span className="mono amber">0{idx + 1}</span>
                        <span>{part.label}</span>
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="drow">
                  <span className="dkey">Scope</span>
                  <span className="dval">Whole archive — never range-clamped</span>
                </div>
                <div className="drow">
                  <span className="dkey">Memory gate</span>
                  <span className="dval">4 scalar counts · O(1) working memory</span>
                </div>
              </div>
            ) : activePreset.spec ? (
              <div className="dossier-ledger">
                <div className="drow">
                  <span className="dkey">Measures</span>
                  <span className="dval">
                    {activePreset.spec.measures
                      .map((m) => measureMap.get(m) ?? m)
                      .join(" · ")}
                  </span>
                </div>
                <div className="drow">
                  <span className="dkey">Group by</span>
                  <span className="dval">
                    {activePreset.spec.dimensions.length > 0
                      ? activePreset.spec.dimensions
                          .map((d) => dimMap.get(d) ?? d)
                          .join(" × ")
                      : "None (single total)"}
                  </span>
                </div>
                <div className="drow">
                  <span className="dkey">Filters</span>
                  <span className="dval">
                    {activeFilters.length > 0
                      ? activeFilters.map((f) => `${f.label}: ${f.value}`).join(" · ")
                      : "None — all trips in range"}
                  </span>
                </div>
                <div className="drow">
                  <span className="dkey">Range</span>
                  <span className="dval">
                    {rangeOverride ? (
                      <>
                        <span className="amber">
                          {rangeOverride[0]} → {rangeOverride[1]}
                        </span>{" "}
                        <button
                          type="button"
                          className="linkbtn"
                          onClick={onClearRange}
                        >
                          Reset
                        </button>
                      </>
                    ) : Array.isArray(activePreset.spec.range) ? (
                      `${activePreset.spec.range[0]} → ${activePreset.spec.range[1]}`
                    ) : (
                      "Whole archive"
                    )}
                  </span>
                </div>
                {gate?.ok && gate.gate && (
                  <div className="drow">
                    <span className="dkey">Gate plan</span>
                    <span className="dval mono">
                      {gate.gate.shape} = {fmt(gate.gate.buckets)} /{" "}
                      {formatCompactNumber(gate.gate.budget)} ·{" "}
                      {formatCompactNumber(gate.rows_in_range ?? 0)} rows
                    </span>
                  </div>
                )}
              </div>
            ) : null}

            {activePreset.kind === "spec" && activePreset.spec && (
              <div className="dossier-foot">
                <button
                  type="button"
                  className="dossier-action"
                  onClick={() => onCustomizeInBuilder(activePreset)}
                >
                  Open in Query Builder →
                </button>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
