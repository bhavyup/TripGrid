import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BuilderPetalId } from "../utils/spring";
import type {
  BuilderCatalogue,
  PresetInfo,
  SpecDict,
  ValidateResult,
  ZoneMap,
} from "../api";
import {
  FILTER_TABS,
  HOUR_PRESETS,
  WEEKDAYS_SHORT,
  WEEKDAY_PRESETS,
  countAllActiveFilters,
  countFiltersInTab,
  describeActiveFilters,
  formatCompactNumber,
  formatHourRanges,
  getFilterTabForDimension,
  groupCatalogueDimensions,
  groupCatalogueMeasures,
  shortDimensionLabel,
  shortMeasureLabel,
  toggleIn,
  type FilterTabId,
} from "../utils/instrument";

export interface BuilderDraft {
  measures: string[];
  dimensions: string[];
  filters: Record<string, unknown>;
  top_k: number | null;
  sort: "measure" | "key";
}

export const DEFAULT_DRAFT: BuilderDraft = {
  measures: ["trips"],
  dimensions: ["month"],
  filters: {},
  top_k: null,
  sort: "key",
};

export function draftFromSpec(spec: SpecDict): BuilderDraft {
  return {
    measures: [...spec.measures],
    dimensions: [...spec.dimensions],
    filters: { ...(spec.filters ?? {}) },
    top_k: spec.top_k ?? null,
    sort: spec.sort === "key" ? "key" : "measure",
  };
}

interface Props {
  catalogue: BuilderCatalogue;
  zones: ZoneMap;
  presets: PresetInfo[];
  draft: BuilderDraft;
  gate?: ValidateResult | null;
  /** The months the query will actually run over (from InstrumentConsole). */
  effectiveRange: [string, string] | null;
  onChange: (draft: BuilderDraft) => void;
  /** A query is running: every toggle in the panel goes inert. */
  locked: boolean;
  /** The focused petal: one bay at a time instead of the full 3-bay composer. */
  activePetal?: BuilderPetalId;
  /** The range picker, rendered inside the Time Span petal. */
  rangeNode?: ReactNode;
}

function ZonePicker({
  zones,
  value,
  onChange,
  label,
}: {
  zones: ZoneMap;
  value: number[];
  onChange: (ids: number[]) => void;
  label: string;
}) {
  const [search, setSearch] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);

  const entries = useMemo(() => {
    const all = Object.entries(zones)
      .map(([id, z]) => ({ id: Number(id), name: z.zone, borough: z.borough }))
      .sort((a, b) => a.id - b.id);
    const q = search.trim().toLowerCase();
    return all.filter((e) => {
      if (selectedOnly && !value.includes(e.id)) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.borough.toLowerCase().includes(q) ||
        String(e.id) === q
      );
    });
  }, [zones, search, selectedOnly, value]);

  return (
    <div className="zonepick-v2">
      <div className="zonebar">
        <input
          className="zoneq"
          type="text"
          aria-label={`Search ${label}`}
          placeholder={`Filter ${label.toLowerCase()} by name, borough or id…`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          type="button"
          className={`zmodebtn${selectedOnly ? " on" : ""}`}
          aria-pressed={selectedOnly}
          onClick={() => setSelectedOnly((s) => !s)}
        >
          Selected ({value.length})
        </button>
        {value.length > 0 && (
          <button
            type="button"
            className="zmodebtn"
            onClick={() => {
              onChange([]);
              setSelectedOnly(false);
            }}
          >
            Clear
          </button>
        )}
      </div>
      <div className="zonelist-v2">
        {entries.map((e) => {
          const checked = value.includes(e.id);
          return (
            <label
              className={`zitem${checked ? " checked" : ""}`}
              key={e.id}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onChange(toggleIn(value, e.id))}
              />
              <span className="zid">{String(e.id).padStart(3, "0")}</span>
              <span className="zname2">{e.name}</span>
              <span className="zbor">{e.borough}</span>
            </label>
          );
        })}
        {entries.length === 0 && (
          <p className="zonenone">No matching NYC taxi zones.</p>
        )}
      </div>
    </div>
  );
}

/**
 * The Query Builder Workbench: bounded 3-bay horizontal composer.
 * Bay 1: Semantic Measure Matrix
 * Bay 2: Dimensions (with live cardinality hints) + Output Limit/Sort
 * Bay 3: Tabbed Filter Workbench with always-visible active filter tokens
 */
export default function BuilderPanel({
  catalogue,
  zones,
  presets,
  draft,
  gate,
  effectiveRange,
  onChange,
  locked,
  activePetal,
  rangeNode,
}: Props) {
  const [filterTab, setFilterTab] = useState<FilterTabId>("geography");
  const [zoneDirection, setZoneDirection] = useState<"pu_zones" | "do_zones">(
    "pu_zones",
  );
  const [geoSubTab, setGeoSubTab] = useState<"boroughs" | "zones">("boroughs");
  const [schedSubTab, setSchedSubTab] = useState<"clock" | "bounds">("clock");
  const reduceMotion = useReducedMotion();

  // Step 27 — the Geography mode switch. "Boroughs & Airports /
  // Specific Taxi Zones" in Fraunces italic 300, centred, with a large
  // amber "/" between them. Switching tabs runs a wave: the amber
  // drains out of the old option letter by letter, farthest from the
  // "/" first, then flows into the new option from the "/" outward.
  // Each letter is a span with its own transition-delay; the delay is
  // the letter's distance from the "/" (in letters) times STEP, offset
  // by the drain time for the entering option so the two waves run in
  // sequence, not at once.
  const GEO_SWITCH_STEP = 26; // ms per letter
  const GEO_SWITCH_DUR = 320; // ms — keep in step with the CSS transition
  const GEO_SWITCH_TEXTS = {
    boroughs: "Boroughs & Airports",
    zones: "Specific Taxi Zones",
  } as const;
  const prevGeoTabRef = useRef<"boroughs" | "zones">(geoSubTab);
  useEffect(() => {
    prevGeoTabRef.current = geoSubTab;
  }, [geoSubTab]);
  // On the render where the tab just changed, the ref still holds the
  // old tab, so the outgoing and incoming waves can be told apart.
  const prevGeoTab = prevGeoTabRef.current;
  const leavingGeoTab = prevGeoTab !== geoSubTab ? prevGeoTab : null;
  const geoSwitchDrainMs =
    leavingGeoTab !== null
      ? (GEO_SWITCH_TEXTS[leavingGeoTab].length - 1) * GEO_SWITCH_STEP + GEO_SWITCH_DUR
      : 0;

  function geoSwitchKind(id: "boroughs" | "zones"): "leaving" | "entering" | "steady" {
    if (leavingGeoTab === null) return "steady";
    return id === leavingGeoTab ? "leaving" : "entering";
  }

  // Per-letter transition-delay (ms) for one letter of a switch option.
  // `side` is which side of the "/" the option sits on; `index` the
  // letter's position, `len` the option's length.
  function geoSwitchLetterDelay(
    side: "left" | "right",
    kind: "leaving" | "entering" | "steady",
    index: number,
    len: number,
  ): number {
    if (kind === "steady" || reduceMotion) return 0;
    // Distance from the "/" in letters: the left option's nearest
    // letter is its last, the right option's nearest is its first.
    const dist = side === "left" ? len - 1 - index : index;
    if (kind === "leaving") {
      // Farthest changes first, nearest last: delay grows toward the "/".
      return (len - 1 - dist) * GEO_SWITCH_STEP;
    }
    // Entering: nearest changes first, after the drain finishes.
    return geoSwitchDrainMs + dist * GEO_SWITCH_STEP;
  }

  function geoSwitchLetters(text: string, id: "boroughs" | "zones") {
    const side = id === "boroughs" ? "left" : "right";
    const kind = geoSwitchKind(id);
    return [...text].map((ch, i) => (
      <span
        key={i}
        className="geo-letter"
        style={{ transitionDelay: `${geoSwitchLetterDelay(side, kind, i, text.length)}ms` }}
      >
        {ch === " " ? " " : ch}
      </span>
    ));
  }

  const measureGroups = useMemo(
    () => groupCatalogueMeasures(catalogue.measures),
    [catalogue.measures],
  );
  const dimGroups = useMemo(
    () => groupCatalogueDimensions(catalogue.dimensions),
    [catalogue.dimensions],
  );

  const setFilter = (id: string, v: unknown) => {
    const filters = { ...draft.filters };
    if (
      v === undefined ||
      v === "" ||
      v === false ||
      (Array.isArray(v) && v.length === 0)
    ) {
      delete filters[id];
    } else {
      filters[id] = v;
    }
    onChange({ ...draft, filters });
  };

  const clearAllFilters = () => onChange({ ...draft, filters: {} });

  const arr = (id: string): unknown[] =>
    Array.isArray(draft.filters[id]) ? (draft.filters[id] as unknown[]) : [];

  const airportIds = useMemo(() => {
    const find = (needle: string) => {
      const hit = Object.entries(zones).find(([, z]) =>
        z.zone.includes(needle),
      );
      return hit ? Number(hit[0]) : null;
    };
    return { jfk: find("JFK"), lga: find("LaGuardia"), ewr: find("Newark") };
  }, [zones]);

  const airportVal = draft.filters["airport"];
  const airportMode =
    airportVal === "any"
      ? "any"
      : Array.isArray(airportVal) && airportVal.length === 1
        ? String(airportVal[0])
        : "off";

  const setAirport = (mode: string) => {
    if (mode === "off") setFilter("airport", undefined);
    else if (mode === "any") setFilter("airport", "any");
    else setFilter("airport", [Number(mode)]);
  };

  const hasPercentile = draft.measures.some(
    (m) => catalogue.measures.find((x) => x.id === m)?.percentile,
  );

  // Step 17: the summary panel's Filters row (re-added after step 16
  // took it out with the blueprint strip).
  const activeFilterTokens = useMemo(
    () => describeActiveFilters(draft.filters, catalogue, zones),
    [draft.filters, catalogue, zones],
  );

  // Step 16: one measure group (label + its toggle buttons), reused by
  // the three-column measures bay below.
  const renderMeasureGroup = (
    group: ReturnType<typeof groupCatalogueMeasures>[number] | undefined,
  ) => {
    if (!group) return null;
    return (
      <div className="bgroup" key={group.id}>
        <div className="bgroup-label">
          <span>{group.label}</span>
          {group.id === "percentiles" && (
            <span className="bgroup-note">
              ≤ {catalogue.max_pctl_groups} groups
            </span>
          )}
        </div>
        <div className="btoggle-grid petal-toggles">
          {group.items.map((m) => {
            const idx = draft.measures.indexOf(m.id);
            const on = idx !== -1;
            return (
              <button
                key={m.id}
                type="button"
                title={m.label}
                aria-pressed={on}
                className={`btoggle${on ? " on" : ""}`}
                onClick={() =>
                  onChange({
                    ...draft,
                    measures: toggleIn(draft.measures, m.id),
                  })
                }
              >
                <span className="btoggle-name">
                  {shortMeasureLabel(m.id, m.label)}
                </span>
                {on && draft.measures.length > 1 && idx === 0 && (
                  <span className="btoggle-rank" title="Primary ranking measure">
                    1st
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  const activeFilterCount = countAllActiveFilters(draft.filters);
  const puZones = arr("pu_zones") as number[];
  const doZones = arr("do_zones") as number[];
  const hoursVal = arr("hours") as number[];
  const weekdaysVal = arr("weekdays") as number[];
  const puBoroughs = arr("pu_boroughs") as string[];
  const doBoroughs = arr("do_boroughs") as string[];
  const paymentsVal = arr("payment_types") as number[];

  const numVal = (id: string) =>
    typeof draft.filters[id] === "number" ? String(draft.filters[id]) : "";

  const setNum = (id: string, raw: string) => {
    setFilter(id, raw === "" ? undefined : Number(raw));
  };

  const handleToggleDimension = (dimId: string) => {
    const turningOn = !draft.dimensions.includes(dimId);
    onChange({
      ...draft,
      dimensions: toggleIn(draft.dimensions, dimId),
    });
    if (turningOn) {
      const targetTab = getFilterTabForDimension(dimId);
      if (targetTab) {
        setFilterTab(targetTab);
        if (dimId === "pu_zone") setZoneDirection("pu_zones");
        if (dimId === "do_zone") setZoneDirection("do_zones");
      }
    }
  };

  return (
    <div
      className={`bworkbench${locked ? " locked" : ""}`}
      inert={locked}
    >
      {/* Step 17: two columns — the builder on the left (whichever
          dial is selected right now), the recipe summary on the
          right in the preset dossier's own shape. */}
      <div className="bworkbench-main">
      {/* Step 15: one toolbar row — the preset dropdown on the left,
          Reset at the right end. The "Seed from preset" label and the
          "N measures · N dims · N filters" summary are gone. */}
      <div className="btoolbar">
        <select
          id="builder-preset-select"
          className="bselect"
          value=""
          onChange={(e) => {
            const p = presets.find((x) => x.id === e.target.value);
            if (p?.spec) onChange(draftFromSpec(p.spec));
          }}
        >
          <option value="">Choose a preset…</option>
          {presets
            .filter((p) => p.kind === "spec")
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
        </select>
        <button
          type="button"
          className="breset"
          onClick={() => onChange({ ...DEFAULT_DRAFT })}
        >
          Reset builder
        </button>
      </div>

      {/* Focused petal bay OR full 3-bay composer */}
      {activePetal ? (
        <div className="builder-focused-bay" data-petal={activePetal}>
          {/* Step 15: the active-filter token row is gone (it only ever
              showed the geography pick, e.g. "Pickup: Manhattan").
              Filters still show in the blueprint "Where" cell below. */}

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={activePetal}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: reduceMotion ? 0 : 0.25 }}
            >
          {activePetal === "measures" && (
            <div className="petal-bay-grid petal-bay-measures" role="region" aria-label="Measures">
              {/* Step 22: back to the step-19/20 layout, per his word —
                  Percentiles as its own row below the three columns.
                  Step 21's revert was my call, not his, and he wants it
                  back. Any group outside the four known ones lands in
                  column 3. */}
              <div className="bmeasure-col">
                {renderMeasureGroup(
                  measureGroups.find((g) => g.id === "volume"),
                )}
              </div>
              <div className="bmeasure-col">
                {renderMeasureGroup(
                  measureGroups.find((g) => g.id === "revenue"),
                )}
              </div>
              <div className="bmeasure-col">
                {renderMeasureGroup(
                  measureGroups.find((g) => g.id === "speed"),
                )}
                {measureGroups
                  .filter(
                    (g) =>
                      !["volume", "revenue", "speed", "percentiles"].includes(
                        g.id,
                      ),
                  )
                  .map((g) => renderMeasureGroup(g))}
              </div>
              <div className="bpercentile-row">
                {renderMeasureGroup(
                  measureGroups.find((g) => g.id === "percentiles"),
                )}
              </div>
              {hasPercentile && (
                <p className="bbay-foot">
                  Exact fare tables enforce the {catalogue.max_pctl_groups}-group percentile gate.
                </p>
              )}
            </div>
          )}

          {activePetal === "dimensions" && (
            <div className="petal-bay-grid petal-bay-dims" role="region" aria-label="Group By">
              <div className="petal-dims-cols">
                {dimGroups.map((group) => (
                  <div className="bgroup" key={group.id}>
                    <div className="bgroup-label">
                      <span>{group.label}</span>
                    </div>
                    <div className="btoggle-grid">
                      {group.items.map((d) => {
                        const on = draft.dimensions.includes(d.id);
                        const cardText =
                          d.cardinality === null
                            ? "range"
                            : formatCompactNumber(d.cardinality);
                        return (
                          <button
                            key={d.id}
                            type="button"
                            title={`${d.label} — splits output table into rows by ${d.label.toLowerCase()}`}
                            aria-pressed={on}
                            className={`btoggle btoggle-dim${d.id === "route" ? " btoggle-wide" : ""}${on ? " on" : ""}`}
                            onClick={() => handleToggleDimension(d.id)}
                          >
                            <span className="btoggle-name">
                              {shortDimensionLabel(d.id, d.label)}
                            </span>
                            <span className="btoggle-card">{cardText}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="boutput petal-output-bar">
                <div className="boutput-row">
                  <span className="bgroup-label-inline">Limit</span>
                  <div className="bseg" role="group" aria-label="Row limit">
                    {(
                      [
                        [null, "All"],
                        [10, "10"],
                        [20, "20"],
                        [50, "50"],
                        [100, "100"],
                      ] as [number | null, string][]
                    ).map(([k, label]) => (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={draft.top_k === k}
                        className={draft.top_k === k ? "on" : ""}
                        onClick={() => onChange({ ...draft, top_k: k })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="boutput-row">
                  <span className="bgroup-label-inline">Order</span>
                  <div className="bseg" role="group" aria-label="Sort order">
                    <button
                      type="button"
                      aria-pressed={draft.sort === "measure"}
                      className={draft.sort === "measure" ? "on" : ""}
                      onClick={() => onChange({ ...draft, sort: "measure" })}
                    >
                      Biggest first
                    </button>
                    <button
                      type="button"
                      aria-pressed={draft.sort === "key"}
                      className={draft.sort === "key" ? "on" : ""}
                      onClick={() => onChange({ ...draft, sort: "key" })}
                    >
                      Group order
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activePetal === "geography" && (
            <div className="petal-bay-grid petal-bay-geo" role="region" aria-label="Geography filters">
              <div className="petal-sub-bar">
                <div className="geo-switch" role="tablist" aria-label="Geography filter mode">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={geoSubTab === "boroughs"}
                    className={geoSubTab === "boroughs" ? "on" : ""}
                    onClick={() => setGeoSubTab("boroughs")}
                  >
                    {geoSwitchLetters(GEO_SWITCH_TEXTS.boroughs, "boroughs")}
                  </button>
                  <span className="geo-switch-slash" aria-hidden="true">/</span>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={geoSubTab === "zones"}
                    className={geoSubTab === "zones" ? "on" : ""}
                    onClick={() => setGeoSubTab("zones")}
                  >
                    {geoSwitchLetters(GEO_SWITCH_TEXTS.zones, "zones")}
                    {puZones.length + doZones.length > 0 && (
                      <span
                        className="geo-switch-count"
                        style={{
                          transitionDelay: `${geoSwitchLetterDelay(
                            "right",
                            geoSwitchKind("zones"),
                            GEO_SWITCH_TEXTS.zones.length - 1,
                            GEO_SWITCH_TEXTS.zones.length,
                          )}ms`,
                        }}
                      >
                        ({puZones.length + doZones.length})
                      </span>
                    )}
                  </button>
                </div>
              </div>

              {geoSubTab === "boroughs" ? (
                <>
                <div className="petal-two-col">
                  <div className="bgroup">
                    <div className="bgroup-label">
                      <span>Pickup Boroughs</span>
                      {puBoroughs.length > 0 && (
                        <button
                          type="button"
                          className="linkbtn mono-xs"
                          onClick={() => setFilter("pu_boroughs", undefined)}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <div className="bchip-grid">
                      {catalogue.boroughs.map((b) => (
                        <button
                          key={b}
                          type="button"
                          aria-pressed={puBoroughs.includes(b)}
                          className={`btoggle sm${puBoroughs.includes(b) ? " on" : ""}`}
                          onClick={() =>
                            setFilter("pu_boroughs", toggleIn(puBoroughs, b))
                          }
                        >
                          {b}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="bgroup">
                    <div className="bgroup-label">
                      <span>Drop-off Boroughs &amp; Airports</span>
                      {doBoroughs.length > 0 && (
                        <button
                          type="button"
                          className="linkbtn mono-xs"
                          onClick={() => setFilter("do_boroughs", undefined)}
                        >
                          Clear drop-off
                        </button>
                      )}
                    </div>
                    <div className="bchip-grid">
                      {catalogue.boroughs.map((b) => (
                        <button
                          key={b}
                          type="button"
                          aria-pressed={doBoroughs.includes(b)}
                          className={`btoggle sm${doBoroughs.includes(b) ? " on" : ""}`}
                          onClick={() =>
                            setFilter("do_boroughs", toggleIn(doBoroughs, b))
                          }
                        >
                          {b}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {/* Step 25: the airport selector is its own full-width
                    row below the two borough columns, with the same
                    divider above it as the Group By bay has above its
                    Limit/Order bar. It used to live inside the drop-off
                    column, squeezed to that column's width. */}
                <div className="bgeo-airport">
                  <div
                    className="bseg bseg-airport"
                    role="group"
                    aria-label="Airport pickups"
                  >
                    {(
                      [
                        ["off", "Any trip"],
                        ["any", "All airports"],
                        ...(airportIds.jfk != null
                          ? [[String(airportIds.jfk), "JFK"] as [string, string]]
                          : []),
                        ...(airportIds.lga != null
                          ? [[String(airportIds.lga), "LGA"] as [string, string]]
                          : []),
                        ...(airportIds.ewr != null
                          ? [[String(airportIds.ewr), "EWR"] as [string, string]]
                          : []),
                      ] as [string, string][]
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={airportMode === m}
                        className={airportMode === m ? "on" : ""}
                        onClick={() => setAirport(m)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                </>
              ) : (
                <div className="fpane fpane-zones">
                  <div className="bseg zone-dir-seg" role="tablist" aria-label="Zone direction">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={zoneDirection === "pu_zones"}
                      className={zoneDirection === "pu_zones" ? "on" : ""}
                      onClick={() => setZoneDirection("pu_zones")}
                    >
                      Pickup Zones {puZones.length > 0 ? `(${puZones.length})` : ""}
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={zoneDirection === "do_zones"}
                      className={zoneDirection === "do_zones" ? "on" : ""}
                      onClick={() => setZoneDirection("do_zones")}
                    >
                      Drop-off Zones {doZones.length > 0 ? `(${doZones.length})` : ""}
                    </button>
                  </div>
                  <ZonePicker
                    zones={zones}
                    label={zoneDirection === "pu_zones" ? "Pickup zones" : "Drop-off zones"}
                    value={zoneDirection === "pu_zones" ? puZones : doZones}
                    onChange={(ids) => setFilter(zoneDirection, ids)}
                  />
                </div>
              )}
            </div>
          )}

          {activePetal === "schedule" && (
            <div className="petal-bay-grid" role="region" aria-label="Schedule and trip filters">
              <div className="petal-sub-bar">
                <div className="bseg" role="tablist" aria-label="Schedule and trip parameter section">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={schedSubTab === "clock"}
                    className={schedSubTab === "clock" ? "on" : ""}
                    onClick={() => setSchedSubTab("clock")}
                  >
                    Days &amp; Hours {weekdaysVal.length + hoursVal.length > 0 ? `(${weekdaysVal.length + hoursVal.length})` : ""}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={schedSubTab === "bounds"}
                    className={schedSubTab === "bounds" ? "on" : ""}
                    onClick={() => setSchedSubTab("bounds")}
                  >
                    Payments &amp; Trip Bounds
                  </button>
                </div>
              </div>

              {schedSubTab === "clock" ? (
                <div className="fpane fpane-schedule">
                  <div className="bgroup">
                    <div className="bgroup-label">
                      <span>Days of Week</span>
                      <div className="inline-shortcuts">
                        {WEEKDAY_PRESETS.map((wp) => (
                          <button
                            key={wp.id}
                            type="button"
                            className="linkbtn mono-xs"
                            onClick={() => setFilter("weekdays", wp.days)}
                          >
                            {wp.label}
                          </button>
                        ))}
                        {weekdaysVal.length > 0 && (
                          <button
                            type="button"
                            className="linkbtn mono-xs"
                            onClick={() => setFilter("weekdays", undefined)}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="weekday-strip-v2">
                      {WEEKDAYS_SHORT.map((w, i) => {
                        const on = weekdaysVal.includes(i);
                        return (
                          <button
                            key={w}
                            type="button"
                            aria-pressed={on}
                            className={`wday-card${on ? " on" : ""}`}
                            onClick={() =>
                              setFilter("weekdays", toggleIn(weekdaysVal, i))
                            }
                          >
                            <span className="wday-name">{w}</span>
                            <span className="wday-kind">{i >= 5 ? "WKND" : "WK"}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="bgroup">
                    <div className="bgroup-label">
                      <span>Hours by Time Band</span>
                      {hoursVal.length > 0 && (
                        <button
                          type="button"
                          className="linkbtn mono-xs"
                          onClick={() => setFilter("hours", undefined)}
                        >
                          Clear hours
                        </button>
                      )}
                    </div>
                    <div className="hour-bands">
                      {HOUR_PRESETS.map((band) => {
                        const allOn = band.hours.every((h) => hoursVal.includes(h));
                        const someOn = band.hours.some((h) => hoursVal.includes(h));
                        const toggleBand = () => {
                          if (allOn) {
                            setFilter("hours", hoursVal.filter((h) => !band.hours.includes(h)));
                          } else {
                            setFilter(
                              "hours",
                              Array.from(new Set([...hoursVal, ...band.hours])).sort((a, b) => a - b),
                            );
                          }
                        };
                        return (
                          <div className="hband" key={band.id}>
                            <button
                              type="button"
                              className={`hband-btn${allOn ? " on" : someOn ? " part" : ""}`}
                              onClick={toggleBand}
                            >
                              <span>{band.label.split(" ")[0]}</span>
                              <span className="hband-span">
                                {band.label.split(" ").slice(1).join(" ")}
                              </span>
                            </button>
                            <div className="hband-cells">
                              {band.hours.map((h) => (
                                <button
                                  key={h}
                                  type="button"
                                  aria-pressed={hoursVal.includes(h)}
                                  className={`hcell${hoursVal.includes(h) ? " on" : ""}`}
                                  onClick={() => setFilter("hours", toggleIn(hoursVal, h))}
                                >
                                  {String(h).padStart(2, "0")}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="petal-two-col">
                  <div className="bgroup">
                    <div className="bgroup-label">
                      <span>Payment Types</span>
                      {paymentsVal.length > 0 && (
                        <button
                          type="button"
                          className="linkbtn mono-xs"
                          onClick={() => setFilter("payment_types", undefined)}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    <div className="bchip-grid">
                      {catalogue.payments.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          aria-pressed={paymentsVal.includes(p.id)}
                          className={`btoggle sm${paymentsVal.includes(p.id) ? " on" : ""}`}
                          onClick={() =>
                            setFilter("payment_types", toggleIn(paymentsVal, p.id))
                          }
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <button
                        type="button"
                        aria-pressed={draft.filters["sane_only"] === true}
                        className={`btoggle full${draft.filters["sane_only"] === true ? " on" : ""}`}
                        onClick={() =>
                          setFilter(
                            "sane_only",
                            draft.filters["sane_only"] === true ? undefined : true,
                          )
                        }
                      >
                        <span>Sane trips only (60s–4h, 0.1–200 mi)</span>
                        <span className="btoggle-card">
                          {draft.filters["sane_only"] === true ? "ON" : "OFF"}
                        </span>
                      </button>
                    </div>
                  </div>
                  <div className="bgroup">
                    <div className="bgroup-label">
                      <span>Numeric Bounds</span>
                    </div>
                    <div className="bounds-grid">
                      <div className="bound-pair">
                        <span className="bound-name">Fare ($)</span>
                        <input
                          className="numin-v2"
                          type="number"
                          step="any"
                          aria-label="Minimum fare ($)"
                          placeholder="Min"
                          value={numVal("fare_min")}
                          onChange={(e) => setNum("fare_min", e.target.value)}
                        />
                        <span className="bound-dash" aria-hidden="true">–</span>
                        <input
                          className="numin-v2"
                          type="number"
                          step="any"
                          aria-label="Maximum fare ($)"
                          placeholder="Max"
                          value={numVal("fare_max")}
                          onChange={(e) => setNum("fare_max", e.target.value)}
                        />
                      </div>
                      <div className="bound-pair">
                        <span className="bound-name">Distance (mi)</span>
                        <input
                          className="numin-v2"
                          type="number"
                          step="any"
                          aria-label="Minimum distance (miles)"
                          placeholder="Min"
                          value={numVal("dist_min")}
                          onChange={(e) => setNum("dist_min", e.target.value)}
                        />
                        <span className="bound-dash" aria-hidden="true">–</span>
                        <input
                          className="numin-v2"
                          type="number"
                          step="any"
                          aria-label="Maximum distance (miles)"
                          placeholder="Max"
                          value={numVal("dist_max")}
                          onChange={(e) => setNum("dist_max", e.target.value)}
                        />
                      </div>
                      <div className="bound-pair">
                        <span className="bound-name">Duration (s)</span>
                        <input
                          className="numin-v2"
                          type="number"
                          step="any"
                          aria-label="Minimum duration (seconds)"
                          placeholder="Min"
                          value={numVal("dur_min")}
                          onChange={(e) => setNum("dur_min", e.target.value)}
                        />
                        <span className="bound-dash" aria-hidden="true">–</span>
                        <input
                          className="numin-v2"
                          type="number"
                          step="any"
                          aria-label="Maximum duration (seconds)"
                          placeholder="Max"
                          value={numVal("dur_max")}
                          onChange={(e) => setNum("dur_max", e.target.value)}
                        />
                      </div>
                      <div className="bound-pair bound-single">
                        <span className="bound-name">Min passengers</span>
                        <input
                          className="numin-v2"
                          type="number"
                          step="1"
                          min="1"
                          aria-label="Minimum passengers"
                          placeholder="Any"
                          value={numVal("min_passengers")}
                          onChange={(e) => setNum("min_passengers", e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {activePetal === "range" && (
            <div className="petal-bay-grid petal-bay-range" role="region" aria-label="Archive time span">
              {rangeNode}
            </div>
          )}
            </motion.div>
          </AnimatePresence>
        </div>
      ) : (
      <div className="bbays">
        {/* BAY 1: MEASURES — dictates the natural height of the control panel */}
        <div className="bbay bbay-measures" role="region" aria-label="Measures">
          <header className="bbay-head">
            <div>
              <span className="bbay-idx">01</span>
              <h3 className="bbay-title">Measures</h3>
            </div>
            <span className="bbay-meta">
              {draft.measures.length} active
            </span>
          </header>
          <div className="bbay-sub">
            <span>Columns to compute</span>
          </div>

          <div className="bbay-body">
            {measureGroups.map((group) => (
              <div className="bgroup" key={group.id}>
                <div className="bgroup-label">
                  <span>{group.label}</span>
                  {group.id === "percentiles" && (
                    <span className="bgroup-note">
                      ≤ {catalogue.max_pctl_groups} groups
                    </span>
                  )}
                </div>
                <div className="btoggle-grid">
                  {group.items.map((m) => {
                    const idx = draft.measures.indexOf(m.id);
                    const on = idx !== -1;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        title={m.label}
                        aria-pressed={on}
                        className={`btoggle${on ? " on" : ""}`}
                        onClick={() =>
                          onChange({
                            ...draft,
                            measures: toggleIn(draft.measures, m.id),
                          })
                        }
                      >
                        <span className="btoggle-name">
                          {shortMeasureLabel(m.id, m.label)}
                        </span>
                        {on && draft.measures.length > 1 && idx === 0 && (
                          <span
                            className="btoggle-rank"
                            title="Primary ranking measure"
                          >
                            1st
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {hasPercentile && (
            <p className="bbay-foot">
              Exact fare tables enforce the {catalogue.max_pctl_groups}-group
              percentile gate.
            </p>
          )}
        </div>

        {/* BAY 2: GROUP BY + OUTPUT */}
        <div
          className="bbay bbay-dims"
          role="region"
          aria-label="Dimensions and Output"
        >
          <header className="bbay-head">
            <div>
              <span className="bbay-idx">02</span>
              <h3 className="bbay-title">Group By</h3>
            </div>
            <span className="bbay-meta">
              {draft.dimensions.length === 0
                ? "Single total"
                : `${draft.dimensions.length} row key${draft.dimensions.length === 1 ? "" : "s"}`}
            </span>
          </header>
          <div className="bbay-sub">
            <span>Split output into one row per</span>
            <span className="bbay-sub-right">max rows</span>
          </div>

          <div className="bbay-body">
            {dimGroups.map((group) => (
              <div className="bgroup" key={group.id}>
                <div className="bgroup-label">
                  <span>{group.label}</span>
                </div>
                <div className="btoggle-grid">
                  {group.items.map((d) => {
                    const on = draft.dimensions.includes(d.id);
                    const cardText =
                      d.cardinality === null
                        ? "range"
                        : formatCompactNumber(d.cardinality);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        title={`${d.label} — splits output table into rows by ${d.label.toLowerCase()}`}
                        aria-pressed={on}
                        className={`btoggle btoggle-dim${d.id === "route" ? " btoggle-wide" : ""}${on ? " on" : ""}`}
                        onClick={() => handleToggleDimension(d.id)}
                      >
                        <span className="btoggle-name">
                          {shortDimensionLabel(d.id, d.label)}
                        </span>
                        <span className="btoggle-card">{cardText}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Output controls anchored neatly inside Bay 2 */}
            <div className="boutput">
              <div className="boutput-row">
                <span className="bgroup-label-inline">Limit</span>
                <div className="bseg" role="group" aria-label="Row limit">
                  {(
                    [
                      [null, "All"],
                      [10, "10"],
                      [20, "20"],
                      [50, "50"],
                      [100, "100"],
                    ] as [number | null, string][]
                  ).map(([k, label]) => (
                    <button
                      key={label}
                      type="button"
                      aria-pressed={draft.top_k === k}
                      className={draft.top_k === k ? "on" : ""}
                      onClick={() => onChange({ ...draft, top_k: k })}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="boutput-row">
                <span className="bgroup-label-inline">Order</span>
                <div className="bseg" role="group" aria-label="Sort order">
                  <button
                    type="button"
                    aria-pressed={draft.sort === "measure"}
                    className={draft.sort === "measure" ? "on" : ""}
                    onClick={() => onChange({ ...draft, sort: "measure" })}
                  >
                    Biggest first
                  </button>
                  <button
                    type="button"
                    aria-pressed={draft.sort === "key"}
                    className={draft.sort === "key" ? "on" : ""}
                    onClick={() => onChange({ ...draft, sort: "key" })}
                  >
                    Group order
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* BAY 3: TABBED FILTERS */}
        <div className="bbay bbay-filters" role="region" aria-label="Filters">
          <header className="bbay-head">
            <div>
              <span className="bbay-idx">03</span>
              <h3 className="bbay-title">Filters</h3>
            </div>
            <div className="bbay-head-actions">
              <span className="bbay-meta">
                {activeFilterCount === 0
                  ? "Unfiltered"
                  : `${activeFilterCount} active`}
              </span>
              {activeFilterCount > 0 && (
                <button
                  type="button"
                  className="linkbtn mono-xs"
                  onClick={clearAllFilters}
                >
                  Clear all
                </button>
              )}
            </div>
          </header>
          <div className="bbay-sub">
            <span>Narrow which trips are scanned</span>
          </div>

          {/* Step 15: the active-filter token strip is gone here too
              (same row as in the focused bay). */}

          {/* 4 focused Filter Sub-Tabs */}
          <div className="ftabs" role="tablist" aria-label="Filter categories">
            {FILTER_TABS.map((t) => {
              const cnt = countFiltersInTab(draft.filters, t.id);
              const active = filterTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`ftab${active ? " on" : ""}`}
                  onClick={() => setFilterTab(t.id)}
                >
                  <span>{t.label}</span>
                  {cnt > 0 && <span className="ftab-cnt">{cnt}</span>}
                </button>
              );
            })}
          </div>

          <div className="bbay-body">
            {filterTab === "geography" && (
              <div className="fpane">
                <div className="bgroup">
                  <div className="bgroup-label">
                    <span>Pickup Boroughs</span>
                    {puBoroughs.length > 0 && (
                      <button
                        type="button"
                        className="linkbtn mono-xs"
                        onClick={() => setFilter("pu_boroughs", undefined)}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="bchip-grid">
                    {catalogue.boroughs.map((b) => (
                      <button
                        key={b}
                        type="button"
                        aria-pressed={puBoroughs.includes(b)}
                        className={`btoggle sm${puBoroughs.includes(b) ? " on" : ""}`}
                        onClick={() =>
                          setFilter("pu_boroughs", toggleIn(puBoroughs, b))
                        }
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bgroup">
                  <div className="bgroup-label">
                    <span>Drop-off Boroughs</span>
                    {doBoroughs.length > 0 && (
                      <button
                        type="button"
                        className="linkbtn mono-xs"
                        onClick={() => setFilter("do_boroughs", undefined)}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="bchip-grid">
                    {catalogue.boroughs.map((b) => (
                      <button
                        key={b}
                        type="button"
                        aria-pressed={doBoroughs.includes(b)}
                        className={`btoggle sm${doBoroughs.includes(b) ? " on" : ""}`}
                        onClick={() =>
                          setFilter("do_boroughs", toggleIn(doBoroughs, b))
                        }
                      >
                        {b}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bgroup">
                  <div className="bgroup-label">
                    <span>Airport Pickups</span>
                  </div>
                  <div className="bseg" role="group" aria-label="Airport pickups">
                    {(
                      [
                        ["off", "Any trip"],
                        ["any", "All airports"],
                        ...(airportIds.jfk != null
                          ? [[String(airportIds.jfk), "JFK"] as [string, string]]
                          : []),
                        ...(airportIds.lga != null
                          ? [[String(airportIds.lga), "LGA"] as [string, string]]
                          : []),
                        ...(airportIds.ewr != null
                          ? [[String(airportIds.ewr), "EWR"] as [string, string]]
                          : []),
                      ] as [string, string][]
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={airportMode === m}
                        className={airportMode === m ? "on" : ""}
                        onClick={() => setAirport(m)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {filterTab === "zones" && (
              <div className="fpane fpane-zones">
                <div className="bseg zone-dir-seg" role="tablist" aria-label="Zone direction">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={zoneDirection === "pu_zones"}
                    className={zoneDirection === "pu_zones" ? "on" : ""}
                    onClick={() => setZoneDirection("pu_zones")}
                  >
                    Pickup Zones {puZones.length > 0 ? `(${puZones.length})` : ""}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={zoneDirection === "do_zones"}
                    className={zoneDirection === "do_zones" ? "on" : ""}
                    onClick={() => setZoneDirection("do_zones")}
                  >
                    Drop-off Zones {doZones.length > 0 ? `(${doZones.length})` : ""}
                  </button>
                </div>
                <ZonePicker
                  zones={zones}
                  label={
                    zoneDirection === "pu_zones"
                      ? "Pickup zones"
                      : "Drop-off zones"
                  }
                  value={zoneDirection === "pu_zones" ? puZones : doZones}
                  onChange={(ids) => setFilter(zoneDirection, ids)}
                />
              </div>
            )}

            {filterTab === "schedule" && (
              <div className="fpane fpane-schedule">
                <div className="bgroup">
                  <div className="bgroup-label">
                    <span>Days of Week</span>
                    <div className="inline-shortcuts">
                      {WEEKDAY_PRESETS.map((wp) => (
                        <button
                          key={wp.id}
                          type="button"
                          className="linkbtn mono-xs"
                          onClick={() => setFilter("weekdays", wp.days)}
                        >
                          {wp.label}
                        </button>
                      ))}
                      {weekdaysVal.length > 0 && (
                        <button
                          type="button"
                          className="linkbtn mono-xs"
                          onClick={() => setFilter("weekdays", undefined)}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="weekday-strip-v2">
                    {WEEKDAYS_SHORT.map((w, i) => {
                      const on = weekdaysVal.includes(i);
                      return (
                        <button
                          key={w}
                          type="button"
                          aria-pressed={on}
                          className={`wday-card${on ? " on" : ""}`}
                          onClick={() =>
                            setFilter("weekdays", toggleIn(weekdaysVal, i))
                          }
                        >
                          <span className="wday-name">{w}</span>
                          <span className="wday-kind">
                            {i >= 5 ? "WKND" : "WK"}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="bgroup">
                  <div className="bgroup-label">
                    <span>Hours by Time Band</span>
                    <div className="inline-shortcuts">
                      {hoursVal.length > 0 && (
                        <button
                          type="button"
                          className="linkbtn mono-xs"
                          onClick={() => setFilter("hours", undefined)}
                        >
                          Clear hours
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="hour-bands">
                    {HOUR_PRESETS.map((band) => {
                      const allOn = band.hours.every((h) =>
                        hoursVal.includes(h),
                      );
                      const someOn = band.hours.some((h) =>
                        hoursVal.includes(h),
                      );
                      const toggleBand = () => {
                        if (allOn) {
                          const next = hoursVal.filter(
                            (h) => !band.hours.includes(h),
                          );
                          setFilter("hours", next);
                        } else {
                          const next = Array.from(
                            new Set([...hoursVal, ...band.hours]),
                          ).sort((a, b) => a - b);
                          setFilter("hours", next);
                        }
                      };
                      return (
                        <div className="hband" key={band.id}>
                          <button
                            type="button"
                            className={`hband-btn${allOn ? " on" : someOn ? " part" : ""}`}
                            onClick={toggleBand}
                            title={`Toggle all hours in ${band.label}`}
                          >
                            <span>{band.label.split(" ")[0]}</span>
                            <span className="hband-span">
                              {band.label.split(" ").slice(1).join(" ")}
                            </span>
                          </button>
                          <div className="hband-cells">
                            {band.hours.map((h) => (
                              <button
                                key={h}
                                type="button"
                                aria-pressed={hoursVal.includes(h)}
                                className={`hcell${hoursVal.includes(h) ? " on" : ""}`}
                                onClick={() =>
                                  setFilter("hours", toggleIn(hoursVal, h))
                                }
                              >
                                {String(h).padStart(2, "0")}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {(() => {
                  const activeDays =
                    weekdaysVal.length > 0 ? weekdaysVal.length : 7;
                  const activeHours =
                    hoursVal.length > 0 ? hoursVal.length : 24;
                  const totalHrs = activeDays * activeHours;
                  const pct = Math.round((totalHrs / 168) * 100);
                  const dayText =
                    weekdaysVal.length === 0
                      ? "Every day"
                      : [...weekdaysVal]
                          .sort((a, b) => a - b)
                          .map((d) => WEEKDAYS_SHORT[d])
                          .join(", ");
                  const hrText =
                    hoursVal.length === 0
                      ? "All 24 hours"
                      : formatHourRanges(hoursVal);
                  return (
                    <div className="sched-summary">
                      <div className="sched-summary-top">
                        <span className="sched-summary-label">
                          {dayText} · {hrText}
                        </span>
                        <span className="sched-summary-stat">
                          {totalHrs} / 168 hrs ({pct}%)
                        </span>
                      </div>
                      <div className="sched-bar">
                        <i style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {filterTab === "trip" && (
              <div className="fpane">
                <div className="bgroup">
                  <div className="bgroup-label">
                    <span>Payment Types</span>
                    {paymentsVal.length > 0 && (
                      <button
                        type="button"
                        className="linkbtn mono-xs"
                        onClick={() => setFilter("payment_types", undefined)}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="bchip-grid">
                    {catalogue.payments.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        aria-pressed={paymentsVal.includes(p.id)}
                        className={`btoggle sm${paymentsVal.includes(p.id) ? " on" : ""}`}
                        onClick={() =>
                          setFilter(
                            "payment_types",
                            toggleIn(paymentsVal, p.id),
                          )
                        }
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bgroup">
                  <div className="bgroup-label">
                    <span>Data Quality</span>
                  </div>
                  <button
                    type="button"
                    aria-pressed={draft.filters["sane_only"] === true}
                    className={`btoggle full${draft.filters["sane_only"] === true ? " on" : ""}`}
                    onClick={() =>
                      setFilter(
                        "sane_only",
                        draft.filters["sane_only"] === true ? undefined : true,
                      )
                    }
                  >
                    <span>Sane trips only (60s–4h, 0.1–200 mi)</span>
                    <span className="btoggle-card">
                      {draft.filters["sane_only"] === true ? "ON" : "OFF"}
                    </span>
                  </button>
                </div>

                <div className="bgroup">
                  <div className="bgroup-label">
                    <span>Numeric Bounds</span>
                  </div>
                  <div className="bounds-grid">
                    <div className="bound-pair">
                      <span className="bound-name">Fare ($)</span>
                      <input
                        className="numin-v2"
                        type="number"
                        step="any"
                        aria-label="Minimum fare ($)"
                        placeholder="Min"
                        value={numVal("fare_min")}
                        onChange={(e) => setNum("fare_min", e.target.value)}
                      />
                      <span className="bound-dash" aria-hidden="true">
                        –
                      </span>
                      <input
                        className="numin-v2"
                        type="number"
                        step="any"
                        aria-label="Maximum fare ($)"
                        placeholder="Max"
                        value={numVal("fare_max")}
                        onChange={(e) => setNum("fare_max", e.target.value)}
                      />
                    </div>

                    <div className="bound-pair">
                      <span className="bound-name">Distance (mi)</span>
                      <input
                        className="numin-v2"
                        type="number"
                        step="any"
                        aria-label="Minimum distance (miles)"
                        placeholder="Min"
                        value={numVal("dist_min")}
                        onChange={(e) => setNum("dist_min", e.target.value)}
                      />
                      <span className="bound-dash" aria-hidden="true">
                        –
                      </span>
                      <input
                        className="numin-v2"
                        type="number"
                        step="any"
                        aria-label="Maximum distance (miles)"
                        placeholder="Max"
                        value={numVal("dist_max")}
                        onChange={(e) => setNum("dist_max", e.target.value)}
                      />
                    </div>

                    <div className="bound-pair">
                      <span className="bound-name">Duration (s)</span>
                      <input
                        className="numin-v2"
                        type="number"
                        step="any"
                        aria-label="Minimum duration (seconds)"
                        placeholder="Min"
                        value={numVal("dur_min")}
                        onChange={(e) => setNum("dur_min", e.target.value)}
                      />
                      <span className="bound-dash" aria-hidden="true">
                        –
                      </span>
                      <input
                        className="numin-v2"
                        type="number"
                        step="any"
                        aria-label="Maximum duration (seconds)"
                        placeholder="Max"
                        value={numVal("dur_max")}
                        onChange={(e) => setNum("dur_max", e.target.value)}
                      />
                    </div>

                    <div className="bound-pair bound-single">
                      <span className="bound-name">Min passengers</span>
                      <input
                        className="numin-v2"
                        type="number"
                        step="1"
                        min="1"
                        aria-label="Minimum passengers"
                        placeholder="Any"
                        value={numVal("min_passengers")}
                        onChange={(e) =>
                          setNum("min_passengers", e.target.value)
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )}

      </div>

      {/* Step 17: the recipe summary, on the right, in the preset
          dossier's own shape — kicker, title, ledger rows. It tracks
          the live draft, so it is the blueprint strip's replacement
          (step 16 took the strip out; this is where its content went). */}
      <aside className="preset-dossier bsummary" aria-label="Current recipe summary">
        <div className="dossier-kicker">
          <span className="amber">Builder</span>
          <span className="sep" aria-hidden="true">/</span>
          <span>Custom recipe</span>
        </div>
        <h3 className="dossier-title">Custom query recipe</h3>
        <div className="dossier-ledger">
          <div className="drow">
            <span className="dkey">Measures</span>
            <span className="dval">
              {draft.measures.length > 0
                ? draft.measures
                    .map(
                      (id) =>
                        shortMeasureLabel(
                          id,
                          catalogue.measures.find((m) => m.id === id)?.label ?? id,
                        ),
                    )
                    .join(" · ")
                : "Pick at least one measure"}
            </span>
          </div>
          <div className="drow">
            <span className="dkey">Group by</span>
            <span className="dval">
              {draft.dimensions.length > 0
                ? draft.dimensions
                    .map(
                      (id) =>
                        shortDimensionLabel(
                          id,
                          catalogue.dimensions.find((d) => d.id === id)?.label ??
                            id,
                        ),
                    )
                    .join(" × ")
                : "Archive total"}
              {draft.top_k ? ` · Top ${draft.top_k}` : ""}
              {` · ${draft.sort === "key" ? "Group order" : "Biggest first"}`}
            </span>
          </div>
          <div className="drow">
            <span className="dkey">Filters</span>
            <span className="dval">
              {activeFilterTokens.length > 0
                ? activeFilterTokens.map((t) => `${t.label}: ${t.value}`).join(" · ")
                : "None — all trips in range"}
            </span>
          </div>
          <div className="drow">
            <span className="dkey">Range</span>
            <span className="dval">
              {effectiveRange ? (
                <span className="amber">
                  {effectiveRange[0]} → {effectiveRange[1]}
                </span>
              ) : (
                "Whole archive"
              )}
            </span>
          </div>
          <div className="drow">
            <span className="dkey">Gate plan</span>
            <span className="dval mono">
              {gate
                ? gate.ok && gate.gate
                  ? `${gate.gate.shape} = ${gate.gate.buckets.toLocaleString("en-US")} / ${formatCompactNumber(gate.gate.budget)} · ${formatCompactNumber(gate.rows_in_range ?? 0)} rows`
                  : "Over budget"
                : "Pricing…"}
            </span>
          </div>
        </div>
      </aside>
    </div>
  );
}
