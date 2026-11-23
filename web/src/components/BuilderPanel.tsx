import { useMemo, useState } from "react";
import type { BuilderCatalogue, PresetInfo, SpecDict, ZoneMap } from "../api";

export interface BuilderDraft {
  measures: string[];
  dimensions: string[];
  filters: Record<string, unknown>;
  top_k: number | null;
  sort: "measure" | "key";
}

export function draftFromSpec(spec: SpecDict): BuilderDraft {
  return {
    measures: [...spec.measures],
    dimensions: [...spec.dimensions],
    filters: { ...(spec.filters ?? {}) },
    top_k: spec.top_k ?? null,
    sort: spec.sort === "key" ? "key" : "measure",
  };
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  catalogue: BuilderCatalogue;
  zones: ZoneMap;
  presets: PresetInfo[];
  draft: BuilderDraft;
  onChange: (draft: BuilderDraft) => void;
}

function toggleIn<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

function ZonePicker({
  zones,
  value,
  onChange,
}: {
  zones: ZoneMap;
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const [search, setSearch] = useState("");
  const entries = useMemo(() => {
    const all = Object.entries(zones)
      .map(([id, z]) => ({ id: Number(id), name: z.zone, borough: z.borough }))
      .sort((a, b) => a.id - b.id);
    const q = search.trim().toLowerCase();
    return q
      ? all.filter(
          (e) =>
            e.name.toLowerCase().includes(q) || e.borough.toLowerCase().includes(q),
        )
      : all;
  }, [zones, search]);
  return (
    <div className="zonepick">
      <input
        className="zoneq"
        type="text"
        placeholder="Search zones…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="zonelist">
        {entries.map((e) => (
          <label className="zitem" key={e.id}>
            <input
              type="checkbox"
              checked={value.includes(e.id)}
              onChange={() => onChange(toggleIn(value, e.id))}
            />
            <span className="zid">{e.id}</span>
            <span className="zname2">{e.name}</span>
            <span className="zbor">{e.borough}</span>
          </label>
        ))}
        {entries.length === 0 && <p className="zonenone">No zone matches.</p>}
      </div>
      <p className="zonecount">
        {value.length} selected
        {value.length > 0 && (
          <button className="linkbtn" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </p>
    </div>
  );
}

/**
 * The Question Builder: every measure, every grouping and every
 * filter the engine understands, as toggles. Nothing here runs
 * anything — the panel only edits a recipe; the gate line under
 * the Run button prices it live, and the server prices it again
 * before a single row is read.
 */
export default function BuilderPanel({ catalogue, zones, presets, draft, onChange }: Props) {
  const setFilter = (id: string, v: unknown) => {
    const filters = { ...draft.filters };
    if (v === undefined || (Array.isArray(v) && v.length === 0)) delete filters[id];
    else filters[id] = v;
    onChange({ ...draft, filters });
  };
  const arr = (id: string): unknown[] =>
    Array.isArray(draft.filters[id]) ? (draft.filters[id] as unknown[]) : [];

  const airportIds = useMemo(() => {
    const find = (needle: string) => {
      const hit = Object.entries(zones).find(([, z]) => z.zone.includes(needle));
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

  return (
    <div className="builder">
      <div className="bsec">
        <span className="label">Start from a preset</span>
        <select
          className="startfrom"
          value=""
          onChange={(e) => {
            const p = presets.find((x) => x.id === e.target.value);
            if (p?.spec) onChange(draftFromSpec(p.spec));
          }}
        >
          <option value="">Open a preset as a starting point…</option>
          {presets
            .filter((p) => p.kind === "spec")
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
        </select>
      </div>

      <div className="bsec">
        <span className="label">Measures — what to compute</span>
        <div className="chips">
          {catalogue.measures.map((m) => (
            <button
              key={m.id}
              className={`chip${draft.measures.includes(m.id) ? " on" : ""}`}
              onClick={() =>
                onChange({ ...draft, measures: toggleIn(draft.measures, m.id) })
              }
            >
              {m.label}
            </button>
          ))}
        </div>
        {draft.measures.length > 1 && (
          <p className="bhint">
            Bars and ranking follow the first measure — {draft.measures[0]}.
          </p>
        )}
      </div>

      <div className="bsec">
        <span className="label">Group by</span>
        <div className="chips">
          {catalogue.dimensions.map((d) => (
            <button
              key={d.id}
              className={`chip${draft.dimensions.includes(d.id) ? " on" : ""}`}
              onClick={() =>
                onChange({ ...draft, dimensions: toggleIn(draft.dimensions, d.id) })
              }
            >
              {d.label}
            </button>
          ))}
        </div>
        {hasPercentile && (
          <p className="bhint">
            Percentile measures keep a fare table per group — the gate allows{" "}
            {catalogue.max_pctl_groups} groups for them, not{" "}
            {catalogue.max_buckets.toLocaleString("en-US")}.
          </p>
        )}
      </div>

      <div className="bsec">
        <span className="label">Filters — which trips count</span>
        {catalogue.filters.map((f) => {
          if (f.kind === "boroughs") {
            const val = arr(f.id) as string[];
            return (
              <div className="frow" key={f.id}>
                <span className="flabel">{f.label}</span>
                <div className="chips">
                  {catalogue.boroughs.map((b) => (
                    <button
                      key={b}
                      className={`chip sm${val.includes(b) ? " on" : ""}`}
                      onClick={() => setFilter(f.id, toggleIn(val, b))}
                    >
                      {b}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          if (f.kind === "zones") {
            const val = arr(f.id) as number[];
            return (
              <details className="frow" key={f.id}>
                <summary className="flabel">
                  {f.label}
                  {val.length > 0 ? ` — ${val.length} picked` : ""}
                </summary>
                <ZonePicker
                  zones={zones}
                  value={val}
                  onChange={(ids) => setFilter(f.id, ids)}
                />
              </details>
            );
          }
          if (f.kind === "hours") {
            const val = arr(f.id) as number[];
            return (
              <div className="frow" key={f.id}>
                <span className="flabel">{f.label}</span>
                <div className="chips">
                  {Array.from({ length: 24 }, (_, h) => (
                    <button
                      key={h}
                      className={`chip sm${val.includes(h) ? " on" : ""}`}
                      onClick={() => setFilter(f.id, toggleIn(val, h))}
                    >
                      {String(h).padStart(2, "0")}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          if (f.kind === "weekdays") {
            const val = arr(f.id) as number[];
            return (
              <div className="frow" key={f.id}>
                <span className="flabel">{f.label}</span>
                <div className="chips">
                  {WEEKDAYS.map((w, i) => (
                    <button
                      key={w}
                      className={`chip sm${val.includes(i) ? " on" : ""}`}
                      onClick={() => setFilter(f.id, toggleIn(val, i))}
                    >
                      {w}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          if (f.kind === "payments") {
            const val = arr(f.id) as number[];
            return (
              <div className="frow" key={f.id}>
                <span className="flabel">{f.label}</span>
                <div className="chips">
                  {catalogue.payments.map((p) => (
                    <button
                      key={p.id}
                      className={`chip sm${val.includes(p.id) ? " on" : ""}`}
                      onClick={() => setFilter(f.id, toggleIn(val, p.id))}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          if (f.kind === "airport") {
            return (
              <div className="frow" key={f.id}>
                <span className="flabel">{f.label}</span>
                <div className="chips">
                  {(
                    [
                      ["off", "Off"],
                      ["any", "Any airport"],
                      ...(airportIds.jfk != null
                        ? [[String(airportIds.jfk), "JFK"] as [string, string]]
                        : []),
                      ...(airportIds.lga != null
                        ? [[String(airportIds.lga), "LaGuardia"] as [string, string]]
                        : []),
                      ...(airportIds.ewr != null
                        ? [[String(airportIds.ewr), "Newark"] as [string, string]]
                        : []),
                    ] as [string, string][]
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      className={`chip sm${airportMode === mode ? " on" : ""}`}
                      onClick={() => setAirport(mode)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            );
          }
          if (f.kind === "flag") {
            const on = draft.filters[f.id] === true;
            return (
              <div className="frow" key={f.id}>
                <button
                  className={`chip${on ? " on" : ""}`}
                  onClick={() => setFilter(f.id, on ? undefined : true)}
                >
                  {f.label}
                </button>
              </div>
            );
          }
          // number
          const val = draft.filters[f.id];
          return (
            <div className="frow numrow" key={f.id}>
              <span className="flabel">{f.label}</span>
              <input
                className="numin"
                type="number"
                step="any"
                value={typeof val === "number" ? val : ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  setFilter(f.id, raw === "" ? undefined : Number(raw));
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="bsec">
        <span className="label">Output</span>
        <div className="frow">
          <span className="flabel">Keep</span>
          <div className="chips">
            {(
              [
                [null, "All groups"],
                [10, "Top 10"],
                [20, "Top 20"],
                [50, "Top 50"],
                [100, "Top 100"],
              ] as [number | null, string][]
            ).map(([k, label]) => (
              <button
                key={label}
                className={`chip sm${draft.top_k === k ? " on" : ""}`}
                onClick={() => onChange({ ...draft, top_k: k })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="frow">
          <span className="flabel">Order</span>
          <div className="chips">
            <button
              className={`chip sm${draft.sort === "measure" ? " on" : ""}`}
              onClick={() => onChange({ ...draft, sort: "measure" })}
            >
              Biggest first
            </button>
            <button
              className={`chip sm${draft.sort === "key" ? " on" : ""}`}
              onClick={() => onChange({ ...draft, sort: "key" })}
            >
              Group order
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
