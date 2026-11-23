import type {
  BuilderCatalogue,
  PresetInfo,
  SpecDict,
  SpecJobPayload,
  ZoneMap,
} from "../api";

export type PresetCategoryId = "all" | "policy" | "flows" | "benchmarks" | "audit";

export interface PresetCategoryMeta {
  id: Exclude<PresetCategoryId, "all">;
  label: string;
  tag: string;
}

export const PRESET_CATEGORY_TABS: { id: PresetCategoryId; label: string }[] = [
  { id: "all", label: "All" },
  { id: "policy", label: "City & Policy" },
  { id: "flows", label: "Patterns & Flows" },
  { id: "benchmarks", label: "Zones & Fares" },
  { id: "audit", label: "Data Audit" },
];

const PRESET_CATEGORY_MAP: Record<string, PresetCategoryMeta> = {
  congestion_verdict: { id: "policy", label: "City & Policy", tag: "Policy" },
  covid_recovery: { id: "policy", label: "City & Policy", tag: "Macro" },
  city_speed: { id: "policy", label: "City & Policy", tag: "Traffic" },
  demand_clock: { id: "flows", label: "Patterns & Flows", tag: "Rhythm" },
  busiest_routes: { id: "flows", label: "Patterns & Flows", tag: "Corridors" },
  tip_behaviour: { id: "flows", label: "Patterns & Flows", tag: "Tipping" },
  zone_month_trips: { id: "benchmarks", label: "Zones & Fares", tag: "Zones" },
  airport_payments: { id: "benchmarks", label: "Zones & Fares", tag: "Airports" },
  friday_manhattan: { id: "benchmarks", label: "Zones & Fares", tag: "Nightlife" },
  fare_percentiles: { id: "benchmarks", label: "Zones & Fares", tag: "Fares" },
  junk_audit: { id: "audit", label: "Data Audit", tag: "Audit" },
};

export function getPresetCategory(preset: PresetInfo): PresetCategoryMeta {
  if (preset.kind === "audit") {
    return { id: "audit", label: "Data Audit", tag: "Audit" };
  }
  return (
    PRESET_CATEGORY_MAP[preset.id] ?? {
      id: "flows",
      label: "Patterns & Flows",
      tag: "Preset",
    }
  );
}

export function filterPresetsByCategory(
  presets: PresetInfo[],
  category: PresetCategoryId,
): PresetInfo[] {
  if (category === "all") return presets;
  return presets.filter((p) => getPresetCategory(p).id === category);
}

export interface MeasureGroup {
  id: string;
  label: string;
  ids: string[];
}

export const MEASURE_GROUPS: MeasureGroup[] = [
  {
    id: "volume",
    label: "Volume & Distance",
    ids: ["trips", "sum_distance", "avg_distance", "sum_passengers", "avg_passengers"],
  },
  {
    id: "revenue",
    label: "Revenue & Tips",
    ids: [
      "sum_fare",
      "avg_fare",
      "sum_tip",
      "avg_tip",
      "tip_pct",
      "tip_pct_card",
      "sum_total",
    ],
  },
  {
    id: "speed",
    label: "Time & Speed",
    ids: ["avg_duration", "avg_speed"],
  },
  {
    id: "percentiles",
    label: "Exact Percentiles",
    ids: ["p50_fare", "p90_fare", "p99_fare"],
  },
];

export interface DimensionGroup {
  id: string;
  label: string;
  ids: string[];
}

export const DIMENSION_GROUPS: DimensionGroup[] = [
  {
    id: "time",
    label: "Time",
    ids: ["year", "month", "month_of_year", "hour", "weekday", "hour_weekday"],
  },
  {
    id: "geo",
    label: "Location",
    ids: ["pu_borough", "do_borough", "pu_zone", "do_zone", "route"],
  },
  {
    id: "attrs",
    label: "Trip",
    ids: ["payment_type", "airport"],
  },
];

const SHORT_MEASURE_LABELS: Record<string, string> = {
  tip_pct_card: "Tip % (card only)",
};

const SHORT_DIMENSION_LABELS: Record<string, string> = {
  route: "Route (PU → DO)",
};

export function shortMeasureLabel(id: string, fallback: string): string {
  return SHORT_MEASURE_LABELS[id] ?? fallback;
}

export function shortDimensionLabel(id: string, fallback: string): string {
  return SHORT_DIMENSION_LABELS[id] ?? fallback;
}

export function groupCatalogueMeasures(
  measures: BuilderCatalogue["measures"],
): { id: string; label: string; items: BuilderCatalogue["measures"] }[] {
  const byId = new Map(measures.map((m) => [m.id, m]));
  const used = new Set<string>();
  const groups = MEASURE_GROUPS.map((g) => {
    const items = g.ids
      .map((id) => byId.get(id))
      .filter((x): x is BuilderCatalogue["measures"][number] => Boolean(x));
    items.forEach((m) => used.add(m.id));
    return { id: g.id, label: g.label, items };
  }).filter((g) => g.items.length > 0);

  const rest = measures.filter((m) => !used.has(m.id));
  if (rest.length > 0) {
    groups.push({ id: "other", label: "Other", items: rest });
  }
  return groups;
}

export function groupCatalogueDimensions(
  dimensions: BuilderCatalogue["dimensions"],
): { id: string; label: string; items: BuilderCatalogue["dimensions"] }[] {
  const byId = new Map(dimensions.map((d) => [d.id, d]));
  const used = new Set<string>();
  const groups = DIMENSION_GROUPS.map((g) => {
    const items = g.ids
      .map((id) => byId.get(id))
      .filter((x): x is BuilderCatalogue["dimensions"][number] => Boolean(x));
    items.forEach((d) => used.add(d.id));
    return { id: g.id, label: g.label, items };
  }).filter((g) => g.items.length > 0);

  const rest = dimensions.filter((d) => !used.has(d.id));
  if (rest.length > 0) {
    groups.push({ id: "other", label: "Other", items: rest });
  }
  return groups;
}

export type FilterTabId = "geography" | "zones" | "schedule" | "trip";

export const FILTER_TABS: { id: FilterTabId; label: string; filterIds: string[] }[] = [
  {
    id: "geography",
    label: "Geography",
    filterIds: ["pu_boroughs", "do_boroughs", "airport"],
  },
  {
    id: "zones",
    label: "Zones",
    filterIds: ["pu_zones", "do_zones"],
  },
  {
    id: "schedule",
    label: "Schedule",
    filterIds: ["weekdays", "hours"],
  },
  {
    id: "trip",
    label: "Trip & Fare",
    filterIds: [
      "payment_types",
      "sane_only",
      "fare_min",
      "fare_max",
      "dist_min",
      "dist_max",
      "dur_min",
      "dur_max",
      "min_passengers",
    ],
  },
];

export function getFilterTabForDimension(dimId: string): FilterTabId | null {
  switch (dimId) {
    case "pu_borough":
    case "do_borough":
    case "airport":
      return "geography";
    case "pu_zone":
    case "do_zone":
    case "route":
      return "zones";
    case "hour":
    case "weekday":
    case "hour_weekday":
      return "schedule";
    case "payment_type":
      return "trip";
    default:
      return null;
  }
}

export function isFilterActive(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function countFiltersInTab(
  filters: Record<string, unknown>,
  tabId: FilterTabId,
): number {
  const tab = FILTER_TABS.find((t) => t.id === tabId);
  if (!tab) return 0;
  return tab.filterIds.reduce(
    (acc, fid) => acc + (isFilterActive(filters[fid]) ? 1 : 0),
    0,
  );
}

export function countAllActiveFilters(filters: Record<string, unknown>): number {
  return Object.values(filters).reduce<number>(
    (acc, val) => acc + (isFilterActive(val) ? 1 : 0),
    0,
  );
}

export const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const HOUR_PRESETS: { id: string; label: string; hours: number[] }[] = [
  { id: "late", label: "Late 00–05", hours: [0, 1, 2, 3, 4, 5] },
  { id: "morning", label: "AM 06–11", hours: [6, 7, 8, 9, 10, 11] },
  { id: "midday", label: "Mid 12–16", hours: [12, 13, 14, 15, 16] },
  { id: "evening", label: "Eve 17–23", hours: [17, 18, 19, 20, 21, 22, 23] },
];

export const WEEKDAY_PRESETS: { id: string; label: string; days: number[] }[] = [
  { id: "weekdays", label: "Mon–Fri", days: [0, 1, 2, 3, 4] },
  { id: "weekend", label: "Sat–Sun", days: [5, 6] },
];

export function toggleIn<T>(arr: T[], v: T): T[] {
  return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
}

export function formatHourRanges(hours: number[]): string {
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
    } else {
      ranges.push(
        start === prev
          ? `${String(start).padStart(2, "0")}h`
          : `${String(start).padStart(2, "0")}–${String(prev).padStart(2, "0")}h`,
      );
      start = sorted[i];
      prev = sorted[i];
    }
  }
  ranges.push(
    start === prev
      ? `${String(start).padStart(2, "0")}h`
      : `${String(start).padStart(2, "0")}–${String(prev).padStart(2, "0")}h`,
  );
  return ranges.join(", ");
}

export interface ActiveFilterToken {
  id: string;
  label: string;
  value: string;
}

export function describeActiveFilters(
  filters: Record<string, unknown> | undefined,
  catalogue: BuilderCatalogue | null,
  zones: ZoneMap,
): ActiveFilterToken[] {
  if (!filters) return [];
  const paymentMap = new Map(
    (catalogue?.payments ?? []).map((p) => [p.id, p.label]),
  );
  const tokens: ActiveFilterToken[] = [];

  for (const [id, raw] of Object.entries(filters)) {
    if (!isFilterActive(raw)) continue;
    switch (id) {
      case "pu_boroughs": {
        const list = raw as string[];
        tokens.push({
          id,
          label: "Pickup",
          value: list.length <= 2 ? list.join(", ") : `${list.length} boroughs`,
        });
        break;
      }
      case "do_boroughs": {
        const list = raw as string[];
        tokens.push({
          id,
          label: "Drop-off",
          value: list.length <= 2 ? list.join(", ") : `${list.length} boroughs`,
        });
        break;
      }
      case "pu_zones": {
        const list = raw as number[];
        const first = zones[String(list[0])]?.zone ?? `Zone ${list[0]}`;
        tokens.push({
          id,
          label: "PU Zone",
          value: list.length === 1 ? first : `${list.length} zones`,
        });
        break;
      }
      case "do_zones": {
        const list = raw as number[];
        const first = zones[String(list[0])]?.zone ?? `Zone ${list[0]}`;
        tokens.push({
          id,
          label: "DO Zone",
          value: list.length === 1 ? first : `${list.length} zones`,
        });
        break;
      }
      case "hours": {
        tokens.push({
          id,
          label: "Hours",
          value: formatHourRanges(raw as number[]),
        });
        break;
      }
      case "weekdays": {
        const list = [...new Set(raw as number[])].sort((a, b) => a - b);
        tokens.push({
          id,
          label: "Days",
          value: list.map((d) => WEEKDAYS_SHORT[d] ?? String(d)).join(", "),
        });
        break;
      }
      case "payment_types": {
        const list = raw as number[];
        tokens.push({
          id,
          label: "Payment",
          value: list
            .map((p) => paymentMap.get(p) ?? `Type ${p}`)
            .slice(0, 2)
            .join(", ") + (list.length > 2 ? ` +${list.length - 2}` : ""),
        });
        break;
      }
      case "airport": {
        if (raw === "any") {
          tokens.push({ id, label: "Airport", value: "Any" });
        } else if (Array.isArray(raw) && raw.length > 0) {
          const zname = zones[String(raw[0])]?.zone ?? `Zone ${raw[0]}`;
          const short = zname.includes("JFK")
            ? "JFK"
            : zname.includes("LaGuardia")
              ? "LaGuardia"
              : zname.includes("Newark")
                ? "Newark"
                : zname;
          tokens.push({ id, label: "Airport", value: short });
        }
        break;
      }
      case "sane_only": {
        tokens.push({ id, label: "Quality", value: "Sane trips only" });
        break;
      }
      case "fare_min":
        tokens.push({ id, label: "Fare", value: `≥ $${raw}` });
        break;
      case "fare_max":
        tokens.push({ id, label: "Fare", value: `≤ $${raw}` });
        break;
      case "dist_min":
        tokens.push({ id, label: "Dist", value: `≥ ${raw} mi` });
        break;
      case "dist_max":
        tokens.push({ id, label: "Dist", value: `≤ ${raw} mi` });
        break;
      case "dur_min":
        tokens.push({ id, label: "Dur", value: `≥ ${raw}s` });
        break;
      case "dur_max":
        tokens.push({ id, label: "Dur", value: `≤ ${raw}s` });
        break;
      case "min_passengers":
        tokens.push({ id, label: "Pax", value: `≥ ${raw}` });
        break;
      default:
        tokens.push({ id, label: id, value: String(raw) });
    }
  }
  return tokens;
}

export function formatCompactNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(n % 1000 === 0 ? 0 : 1)}K`;
  return n.toLocaleString("en-US");
}

export function formatSpecSignature(
  spec: SpecDict | undefined,
  catalogue: BuilderCatalogue | null,
): string {
  if (!spec) return "4 audit checks · Whole archive";
  const mMap = new Map((catalogue?.measures ?? []).map((m) => [m.id, m.label]));
  const dMap = new Map((catalogue?.dimensions ?? []).map((d) => [d.id, d.label]));
  const mList = spec.measures.map((id) => mMap.get(id) ?? id);
  const dList = spec.dimensions.map((id) => dMap.get(id) ?? id);
  const mText =
    mList.length <= 2
      ? mList.join(", ")
      : `${mList.slice(0, 2).join(", ")} +${mList.length - 2}`;
  const dText = dList.length > 0 ? `by ${dList.join(" × ")}` : "archive total";
  const topText = spec.top_k ? ` · top ${spec.top_k}` : "";
  return `${mText || "No measure"} · ${dText}${topText}`;
}

export function formatPresetDefaultSpan(spec: SpecDict | undefined): string {
  if (!spec || spec.range === "all") return "All years";
  const [a, b] = spec.range;
  if (a.endsWith("-01") && b.endsWith("-12")) {
    return a.slice(0, 4) === b.slice(0, 4)
      ? a.slice(0, 4)
      : `${a.slice(0, 4)}–${b.slice(0, 4)}`;
  }
  return `${a} → ${b}`;
}

export function resolveEffectiveRange(
  overrideRange: [string, string] | null,
  presetSpec: SpecDict | undefined,
  months: string[],
  isAudit: boolean,
): [string, string] | null {
  if (isAudit) return null;
  if (overrideRange) return overrideRange;
  if (presetSpec && Array.isArray(presetSpec.range)) {
    const [rawA, rawB] = presetSpec.range;
    if (months.length === 0) return [rawA, rawB];
    const clampedA = rawA < months[0] ? months[0] : rawA;
    const clampedB = rawB > months[months.length - 1] ? months[months.length - 1] : rawB;
    return clampedA <= clampedB ? [clampedA, clampedB] : [rawA, rawB];
  }
  return null;
}

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function rowsToCsv(payload: SpecJobPayload): string {
  const rows = payload.result.rows;
  if (rows.length === 0) return "";
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => headers.map((h) => escapeCsvCell(row[h])).join(",")),
  ];
  return lines.join("\n");
}

export const NYC_BOROUGHS = [
  "Manhattan",
  "Brooklyn",
  "Queens",
  "Bronx",
  "Staten Island",
] as const;

export type NycBoroughName = (typeof NYC_BOROUGHS)[number];

export interface ActiveGeography {
  boroughs: NycBoroughName[];
  airports: ("JFK" | "LGA" | "EWR")[];
  prunedCount: number;
}

/**
 * Resolves which NYC boroughs and airports will actually be scanned
 * given the active query filters, reflecting partition-level pruning.
 */
export function resolveActiveGeography(
  spec: SpecDict | null | undefined,
  zones: ZoneMap,
  isAudit: boolean,
): ActiveGeography {
  if (isAudit || !spec?.filters) {
    return {
      boroughs: [...NYC_BOROUGHS],
      airports: ["JFK", "LGA", "EWR"],
      prunedCount: 0,
    };
  }

  const f = spec.filters;
  const activeSet = new Set<NycBoroughName>();
  const airportSet = new Set<"JFK" | "LGA" | "EWR">();
  let constrained = false;

  if (f.airport === "any") {
    constrained = true;
    activeSet.add("Queens");
    airportSet.add("JFK");
    airportSet.add("LGA");
    airportSet.add("EWR");
  } else if (Array.isArray(f.airport) && f.airport.length > 0) {
    constrained = true;
    for (const id of f.airport as number[]) {
      const z = zones[String(id)];
      if (z?.zone.includes("JFK")) {
        airportSet.add("JFK");
        activeSet.add("Queens");
      } else if (z?.zone.includes("LaGuardia")) {
        airportSet.add("LGA");
        activeSet.add("Queens");
      } else if (z?.zone.includes("Newark")) {
        airportSet.add("EWR");
      }
    }
  }

  if (Array.isArray(f.pu_boroughs) && f.pu_boroughs.length > 0) {
    constrained = true;
    for (const b of f.pu_boroughs as string[]) {
      if ((NYC_BOROUGHS as readonly string[]).includes(b)) {
        activeSet.add(b as NycBoroughName);
      }
      if (b === "EWR") airportSet.add("EWR");
      if (b === "Queens") {
        airportSet.add("JFK");
        airportSet.add("LGA");
      }
    }
  }

  if (Array.isArray(f.pu_zones) && f.pu_zones.length > 0) {
    constrained = true;
    for (const id of f.pu_zones as number[]) {
      const z = zones[String(id)];
      if (z && (NYC_BOROUGHS as readonly string[]).includes(z.borough)) {
        activeSet.add(z.borough as NycBoroughName);
      }
      if (z?.zone.includes("JFK")) airportSet.add("JFK");
      if (z?.zone.includes("LaGuardia")) airportSet.add("LGA");
      if (z?.zone.includes("Newark")) airportSet.add("EWR");
    }
  }

  if (!constrained) {
    return {
      boroughs: [...NYC_BOROUGHS],
      airports: ["JFK", "LGA", "EWR"],
      prunedCount: 0,
    };
  }

  const boroughs = NYC_BOROUGHS.filter((b) => activeSet.has(b));
  return {
    boroughs,
    airports: Array.from(airportSet),
    prunedCount: NYC_BOROUGHS.length - boroughs.length,
  };
}

