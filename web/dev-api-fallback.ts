import type { Plugin } from "vite";

interface ReqLike {
  url?: string;
  method?: string;
  on(event: string, listener: (chunk: unknown) => void): void;
}

interface ResLike {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

/**
 * Dev-only fallback middleware for Vite when TripGrid's Python FastAPI
 * server is not running on http://127.0.0.1:8000 (for instance, in a
 * UI-only preview sandbox without the multi-GB Parquet archive).
 *
 * When FastAPI IS reachable (GET /api/health returns {"ok": true, "name": "TripGrid API"}),
 * every /api/* request passes straight through to Vite's proxy untouched.
 * Never included in `vite build` / `web/dist`.
 */

const MAX_BUCKETS = 500_000;
const MAX_PCTL_GROUPS = 128;
const PERCENTILE_MEASURES = new Set(["p50_fare", "p90_fare", "p99_fare"]);

const DIMENSION_CARDINALITIES: Record<string, number | null> = {
  year: null,
  month: null,
  month_of_year: 12,
  pu_borough: 8,
  do_borough: 8,
  pu_zone: 266,
  do_zone: 266,
  route: 266 * 266,
  hour: 24,
  weekday: 7,
  hour_weekday: 24 * 7,
  payment_type: 8,
  airport: 2,
};

const BUILDER_CATALOGUE = {
  measures: [
    { id: "trips", label: "Trips", unit: "count", percentile: false },
    { id: "sum_fare", label: "Total fare", unit: "usd", percentile: false },
    { id: "avg_fare", label: "Average fare", unit: "usd", percentile: false },
    { id: "sum_tip", label: "Total tip", unit: "usd", percentile: false },
    { id: "avg_tip", label: "Average tip", unit: "usd", percentile: false },
    { id: "tip_pct", label: "Tip % of fare", unit: "pct", percentile: false },
    { id: "tip_pct_card", label: "Tip % — card trips only", unit: "pct", percentile: false },
    { id: "sum_total", label: "Total charged", unit: "usd", percentile: false },
    { id: "sum_distance", label: "Total distance", unit: "mi", percentile: false },
    { id: "avg_distance", label: "Average distance", unit: "mi", percentile: false },
    { id: "sum_passengers", label: "Total passengers", unit: "count", percentile: false },
    { id: "avg_passengers", label: "Average passengers", unit: "plain", percentile: false },
    { id: "avg_duration", label: "Average duration", unit: "duration_s", percentile: false },
    { id: "avg_speed", label: "Average speed", unit: "mph", percentile: false },
    { id: "p50_fare", label: "Median fare (p50)", unit: "usd", percentile: true },
    { id: "p90_fare", label: "Fare p90", unit: "usd", percentile: true },
    { id: "p99_fare", label: "Fare p99", unit: "usd", percentile: true },
  ],
  dimensions: [
    { id: "year", label: "Year", cardinality: null },
    { id: "month", label: "Month", cardinality: null },
    { id: "month_of_year", label: "Month of year", cardinality: 12 },
    { id: "pu_borough", label: "Pickup borough", cardinality: 8 },
    { id: "do_borough", label: "Drop-off borough", cardinality: 8 },
    { id: "pu_zone", label: "Pickup zone", cardinality: 266 },
    { id: "do_zone", label: "Drop-off zone", cardinality: 266 },
    { id: "route", label: "Route — pickup → drop-off", cardinality: 266 * 266 },
    { id: "hour", label: "Hour of day", cardinality: 24 },
    { id: "weekday", label: "Weekday", cardinality: 7 },
    { id: "hour_weekday", label: "Hour × weekday", cardinality: 24 * 7 },
    { id: "payment_type", label: "Payment type", cardinality: 8 },
    { id: "airport", label: "Airport pickup", cardinality: 2 },
  ],
  filters: [
    { id: "pu_boroughs", label: "Pickup boroughs", kind: "boroughs" },
    { id: "do_boroughs", label: "Drop-off boroughs", kind: "boroughs" },
    { id: "pu_zones", label: "Pickup zones", kind: "zones" },
    { id: "do_zones", label: "Drop-off zones", kind: "zones" },
    { id: "hours", label: "Hours of day", kind: "hours" },
    { id: "weekdays", label: "Weekdays", kind: "weekdays" },
    { id: "payment_types", label: "Payment types", kind: "payments" },
    { id: "airport", label: "Airport pickups", kind: "airport" },
    { id: "sane_only", label: "Sane trips only (60s–4h, 0.1–200 mi)", kind: "flag" },
    { id: "fare_min", label: "Fare at least ($)", kind: "number" },
    { id: "fare_max", label: "Fare at most ($)", kind: "number" },
    { id: "dist_min", label: "Distance at least (mi)", kind: "number" },
    { id: "dist_max", label: "Distance at most (mi)", kind: "number" },
    { id: "dur_min", label: "Duration at least (seconds)", kind: "number" },
    { id: "dur_max", label: "Duration at most (seconds)", kind: "number" },
    { id: "min_passengers", label: "Passengers at least", kind: "number" },
  ],
  boroughs: [
    "Manhattan",
    "Brooklyn",
    "Queens",
    "Bronx",
    "Staten Island",
    "EWR",
    "N/A",
    "Unknown",
  ],
  payments: [
    { id: 0, label: "Unknown" },
    { id: 1, label: "Card" },
    { id: 2, label: "Cash" },
    { id: 3, label: "No charge" },
    { id: 4, label: "Dispute" },
    { id: 5, label: "Unknown (5)" },
    { id: 6, label: "Voided" },
  ],
  max_buckets: MAX_BUCKETS,
  max_pctl_groups: MAX_PCTL_GROUPS,
};

const PRESETS = [
  {
    id: "congestion_verdict",
    title: "Did congestion pricing work?",
    note: "Manhattan pickups, month by month, across the January 2025 start of the congestion charge.",
    kind: "spec",
    spec: {
      range: ["2024-01", "2026-12"],
      measures: ["trips", "avg_fare"],
      dimensions: ["month"],
      filters: { pu_boroughs: ["Manhattan"] },
    },
  },
  {
    id: "covid_recovery",
    title: "The COVID collapse and recovery",
    note: "Monthly trips from the last normal year through the collapse and the climb back.",
    kind: "spec",
    spec: {
      range: ["2019-01", "2022-12"],
      measures: ["trips"],
      dimensions: ["month"],
      filters: {},
    },
  },
  {
    id: "city_speed",
    title: "How fast is the city?",
    note: "Average trip speed by hour of day, over sane trips only — the traffic pulse of New York.",
    kind: "spec",
    spec: {
      range: "all",
      measures: ["avg_speed", "trips"],
      dimensions: ["hour"],
      filters: {},
    },
  },
  {
    id: "demand_clock",
    title: "The demand clock",
    note: "Trips by hour × weekday — when the city moves.",
    kind: "spec",
    spec: {
      range: "all",
      measures: ["trips"],
      dimensions: ["hour_weekday"],
      filters: {},
    },
  },
  {
    id: "busiest_routes",
    title: "Busiest routes",
    note: "The twenty pickup → drop-off zone pairs the city flows along most.",
    kind: "spec",
    spec: {
      range: "all",
      measures: ["trips"],
      dimensions: ["route"],
      filters: {},
      top_k: 20,
    },
  },
  {
    id: "tip_behaviour",
    title: "Tip behaviour",
    note: "Tip % by pickup borough. Card trips only — cash tips are never recorded, and the number says so.",
    kind: "spec",
    spec: {
      range: "all",
      measures: ["tip_pct_card", "avg_fare", "trips"],
      dimensions: ["pu_borough"],
      filters: {},
    },
  },
  {
    id: "airport_payments",
    title: "Airport pickups — fare & tip by payment",
    note: "The original Q2: rides that start at an airport, broken down by how they were paid for.",
    kind: "spec",
    spec: {
      range: "all",
      measures: ["trips", "avg_fare", "tip_pct"],
      dimensions: ["payment_type"],
      filters: { airport: "any" },
    },
  },
  {
    id: "zone_month_trips",
    title: "Trips per pickup zone, per month",
    note: "The original Q1 — the counting question the engine was first proven on.",
    kind: "spec",
    spec: {
      range: "all",
      measures: ["trips"],
      dimensions: ["month", "pu_zone"],
      filters: {},
    },
  },
  {
    id: "friday_manhattan",
    title: "Friday-evening Manhattan — top 20 drop-offs",
    note: "The original Q3: rides that start in Manhattan on a Friday between 17:00 and 23:59.",
    kind: "spec",
    spec: {
      range: "all",
      measures: ["trips"],
      dimensions: ["do_zone"],
      filters: {
        pu_boroughs: ["Manhattan"],
        weekdays: [4],
        hours: [17, 18, 19, 20, 21, 22, 23],
      },
      top_k: 20,
    },
  },
  {
    id: "fare_percentiles",
    title: "Exact fare percentiles per borough",
    note: "The original Q4 — exact p50 / p90 / p99 from sparse fare tables, nothing sorted, nothing estimated.",
    kind: "spec",
    spec: {
      range: "all",
      measures: ["p50_fare", "p90_fare", "p99_fare", "trips"],
      dimensions: ["pu_borough"],
      filters: {},
    },
  },
  {
    id: "junk_audit",
    title: "The junk audit",
    note: "How much of the official record is impossible: paid trips that went nowhere, negative fares, trips that lasted for days. Four small counts, one verdict.",
    kind: "audit",
    parts: [
      { name: "paid_but_no_distance", label: "Paid, but went nowhere (distance ≤ 0, fare > 0)" },
      { name: "negative_fare", label: "Negative fares" },
      { name: "marathon_trips", label: "Trips longer than 4 hours" },
      { name: "negative_duration", label: "Trips that end before they start" },
    ],
  },
];

const ZONES: Record<string, { borough: string; zone: string }> = {
  "1": { borough: "EWR", zone: "Newark Airport" },
  "4": { borough: "Manhattan", zone: "Alphabet City" },
  "13": { borough: "Manhattan", zone: "Battery Park City" },
  "43": { borough: "Manhattan", zone: "Central Park" },
  "48": { borough: "Manhattan", zone: "Clinton East" },
  "68": { borough: "Manhattan", zone: "East Chelsea" },
  "79": { borough: "Manhattan", zone: "East Village" },
  "90": { borough: "Manhattan", zone: "Flatiron" },
  "107": { borough: "Manhattan", zone: "Gramercy" },
  "113": { borough: "Manhattan", zone: "Greenwich Village North" },
  "132": { borough: "Queens", zone: "JFK Airport" },
  "138": { borough: "Queens", zone: "LaGuardia Airport" },
  "141": { borough: "Manhattan", zone: "Lenox Hill West" },
  "142": { borough: "Manhattan", zone: "Lincoln Square East" },
  "148": { borough: "Manhattan", zone: "Lower East Side" },
  "161": { borough: "Manhattan", zone: "Midtown Center" },
  "162": { borough: "Manhattan", zone: "Midtown East" },
  "163": { borough: "Manhattan", zone: "Midtown North" },
  "164": { borough: "Manhattan", zone: "Midtown South" },
  "170": { borough: "Manhattan", zone: "Murray Hill" },
  "186": { borough: "Manhattan", zone: "Penn Station/Madison Sq West" },
  "230": { borough: "Manhattan", zone: "Times Sq/Theatre District" },
  "234": { borough: "Manhattan", zone: "Union Sq" },
  "236": { borough: "Manhattan", zone: "Upper East Side North" },
  "237": { borough: "Manhattan", zone: "Upper East Side South" },
  "238": { borough: "Manhattan", zone: "Upper West Side North" },
  "239": { borough: "Manhattan", zone: "Upper West Side South" },
  "249": { borough: "Manhattan", zone: "West Village" },
  "261": { borough: "Manhattan", zone: "World Trade Center" },
  "263": { borough: "Manhattan", zone: "Yorkville West" },
};

function buildArchiveMonths() {
  const months: string[] = [];
  const monthRows: Record<string, number> = {};
  const yearBase: Record<number, number> = {
    2017: 9_400_000,
    2018: 8_550_000,
    2019: 7_020_000,
    2020: 1_950_000,
    2021: 2_580_000,
    2022: 3_310_000,
    2023: 3_190_000,
    2024: 3_420_000,
    2025: 3_780_000,
    2026: 3_620_000,
  };
  for (let y = 2017; y <= 2026; y++) {
    const maxM = y === 2026 ? 2 : 12;
    for (let m = 1; m <= maxM; m++) {
      const ym = `${y}-${String(m).padStart(2, "0")}`;
      months.push(ym);
      let base = yearBase[y];
      if (y === 2020 && m === 4) base = 238_000;
      else if (y === 2020 && m === 5) base = 348_000;
      else if (y === 2020 && m <= 2) base = 6_350_000;
      const seasonal = 0.92 + 0.16 * Math.sin(((m - 1) / 12) * Math.PI * 2);
      monthRows[ym] = Math.round(base * seasonal);
    }
  }
  return { months, monthRows };
}

const ARCHIVE = buildArchiveMonths();
const TOTAL_ROWS = Object.values(ARCHIVE.monthRows).reduce((a, b) => a + b, 0);

function monthsBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let [y, m] = start.split("-").map(Number);
  const [y1, m1] = end.split("-").map(Number);
  while (y < y1 || (y === y1 && m <= m1)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m === 13) {
      y += 1;
      m = 1;
    }
  }
  return out;
}

function validateSpec(raw: Record<string, unknown>) {
  const measures = Array.isArray(raw.measures) ? (raw.measures as string[]) : [];
  const dimensions = Array.isArray(raw.dimensions) ? (raw.dimensions as string[]) : [];
  if (measures.length === 0) {
    return { ok: false, error: "a question needs at least one measure" };
  }
  let range: [string, string];
  if (!raw.range || raw.range === "all") {
    range = [ARCHIVE.months[0], ARCHIVE.months[ARCHIVE.months.length - 1]];
  } else {
    const r = raw.range as [string, string];
    range = [r[0], r[1]];
  }
  const specMonths = monthsBetween(range[0], range[1]);
  const yearsCount = new Set(specMonths.map((m) => m.slice(0, 4))).size;
  let buckets = 1;
  const parts: string[] = [];
  for (const d of dimensions) {
    const c =
      d === "year"
        ? yearsCount
        : d === "month"
          ? specMonths.length
          : (DIMENSION_CARDINALITIES[d] ?? 1);
    buckets *= c;
    parts.push(`${d}(${c})`);
  }
  const shape = parts.length ? parts.join(" × ") : "no grouping";
  const hasPctl = measures.some((m) => PERCENTILE_MEASURES.has(m));
  const budget = hasPctl ? MAX_PCTL_GROUPS : MAX_BUCKETS;
  if (buckets > budget) {
    return {
      ok: false,
      error: hasPctl
        ? `percentile questions keep a fare table per group: ${shape} = ${buckets.toLocaleString("en-US")} groups is over the ${MAX_PCTL_GROUPS.toLocaleString("en-US")}-group budget. Group by fewer, wider things (borough, month, payment type).`
        : `${shape} = ${buckets.toLocaleString("en-US")} buckets is over the ${MAX_BUCKETS.toLocaleString("en-US")}-bucket working-memory budget. Drop a grouping or narrow the range.`,
    };
  }
  const inRange = new Set(specMonths);
  const matchedMonths = ARCHIVE.months.filter((m) => inRange.has(m));
  const rowsInRange = matchedMonths.reduce((a, m) => a + (ARCHIVE.monthRows[m] ?? 0), 0);
  return {
    ok: true,
    gate: { buckets, budget, shape },
    months: matchedMonths.length,
    rows_in_range: rowsInRange,
    partitions_in_range: matchedMonths.length * 8,
    spec: {
      range,
      measures,
      dimensions,
      filters: raw.filters ?? {},
      top_k: raw.top_k ?? null,
      sort: raw.sort ?? (raw.top_k ? "measure" : "key"),
    },
  };
}

function synthRows(spec: {
  range: [string, string];
  measures: string[];
  dimensions: string[];
  top_k: number | null;
}) {
  const dim = spec.dimensions[0];
  const rows: Record<string, unknown>[] = [];
  const fillMeasures = (seed: number, scale: number) => {
    const out: Record<string, number> = {};
    for (const m of spec.measures) {
      switch (m) {
        case "trips":
          out[m] = Math.round(scale * (0.75 + ((seed * 17) % 50) / 100));
          break;
        case "avg_fare":
          out[m] = Number((14.2 + ((seed * 13) % 18) * 1.15).toFixed(2));
          break;
        case "sum_fare":
          out[m] = Math.round(scale * 19.4);
          break;
        case "avg_tip":
          out[m] = Number((2.9 + ((seed * 7) % 10) * 0.28).toFixed(2));
          break;
        case "sum_tip":
          out[m] = Math.round(scale * 3.4);
          break;
        case "tip_pct":
        case "tip_pct_card":
          out[m] = Number((16.5 + ((seed * 11) % 70) / 10).toFixed(1));
          break;
        case "avg_speed":
          out[m] = Number((8.4 + ((seed * 19) % 140) / 10).toFixed(1));
          break;
        case "avg_duration":
          out[m] = Math.round(780 + ((seed * 23) % 620));
          break;
        case "avg_distance":
          out[m] = Number((2.1 + ((seed * 9) % 85) / 10).toFixed(2));
          break;
        case "p50_fare":
          out[m] = Number((12.5 + (seed % 7) * 2.5).toFixed(2));
          break;
        case "p90_fare":
          out[m] = Number((29.5 + (seed % 7) * 5.2).toFixed(2));
          break;
        case "p99_fare":
          out[m] = Number((70.0 + (seed % 7) * 7.8).toFixed(2));
          break;
        default:
          out[m] = Math.round(scale * 1.2);
      }
    }
    return out;
  };

  if (!dim) {
    rows.push(fillMeasures(3, 18_420_000));
  } else if (dim === "month") {
    const ms = ARCHIVE.months.filter((m) => m >= spec.range[0] && m <= spec.range[1]);
    for (let i = 0; i < ms.length; i++) {
      rows.push({ month: ms[i], ...fillMeasures(i + 1, ARCHIVE.monthRows[ms[i]] ?? 3_200_000) });
    }
  } else if (dim === "pu_borough" || dim === "do_borough") {
    const bors = ["Manhattan", "Queens", "Brooklyn", "Bronx", "EWR", "Staten Island", "Unknown"];
    const weights = [41_200_000, 4_850_000, 1_120_000, 312_000, 145_000, 28_400, 540_000];
    bors.forEach((b, i) => rows.push({ [dim]: b, ...fillMeasures(i + 2, weights[i]) }));
  } else if (dim === "hour") {
    for (let h = 0; h < 24; h++) {
      const peak = h >= 17 && h <= 20 ? 2_400_000 : h <= 5 ? 420_000 : 1_550_000;
      rows.push({ hour: h, ...fillMeasures(h + 1, peak) });
    }
  } else if (dim === "payment_type") {
    [1, 2, 3, 4, 0].forEach((pid, i) =>
      rows.push({ payment_type: pid, ...fillMeasures(i + 5, [34_200_000, 8_140_000, 240_000, 195_000, 1_450_000][i]) }),
    );
  } else if (dim === "route") {
    const pairs = [
      ["237", "236"], ["236", "237"], ["161", "237"], ["132", "230"], ["138", "161"],
      ["237", "161"], ["162", "237"], ["236", "236"], ["186", "230"], ["132", "162"],
    ];
    pairs.forEach(([pu, du], i) =>
      rows.push({
        pu_zone: Number(pu),
        pu_zone_name: ZONES[pu]?.zone ?? `Zone ${pu}`,
        do_zone: Number(du),
        do_zone_name: ZONES[du]?.zone ?? `Zone ${du}`,
        ...fillMeasures(i + 1, 1_850_000 - i * 145_000),
      }),
    );
  } else if (dim === "pu_zone" || dim === "do_zone") {
    const ids = ["161", "237", "236", "132", "230", "162", "186", "138", "234", "170", "142", "249"];
    ids.forEach((id, i) =>
      rows.push({
        [dim]: Number(id),
        [`${dim}_name`]: ZONES[id]?.zone ?? `Zone ${id}`,
        [dim === "pu_zone" ? "pu_borough" : "do_borough"]: ZONES[id]?.borough ?? "Manhattan",
        ...fillMeasures(i + 3, 2_480_000 - i * 165_000),
      }),
    );
  } else {
    ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].forEach((w, i) =>
      rows.push({
        weekday: i,
        weekday_name: w,
        hour: 18,
        year: 2019 + i,
        month_of_year: i + 1,
        airport: i % 2 === 0,
        ...fillMeasures(i + 4, 6_400_000 - i * 320_000),
      }),
    );
  }
  return spec.top_k ? rows.slice(0, spec.top_k) : rows;
}

const BENCHMARKS = {
  "2025": {
    year: 2025,
    runs: {
      "tripgrid/q1": { engine: "tripgrid", query: "q1", year: 2025, wall_seconds: 0.42, peak_rss_mb: 318 },
      "duckdb/q1": { engine: "duckdb", query: "q1", year: 2025, wall_seconds: 0.78, peak_rss_mb: 612 },
      "pandas/q1": { engine: "pandas", query: "q1", year: 2025, wall_seconds: 5.91, peak_rss_mb: 2480 },
      "tripgrid/q2": { engine: "tripgrid", query: "q2", year: 2025, wall_seconds: 0.34, peak_rss_mb: 310 },
      "duckdb/q2": { engine: "duckdb", query: "q2", year: 2025, wall_seconds: 0.22, peak_rss_mb: 488 },
      "pandas/q2": { engine: "pandas", query: "q2", year: 2025, wall_seconds: 3.12, peak_rss_mb: 1940 },
      "tripgrid/q3": { engine: "tripgrid", query: "q3", year: 2025, wall_seconds: 0.61, peak_rss_mb: 344 },
      "duckdb/q3": { engine: "duckdb", query: "q3", year: 2025, wall_seconds: 0.41, peak_rss_mb: 720 },
      "pandas/q3": { engine: "pandas", query: "q3", year: 2025, wall_seconds: 6.45, peak_rss_mb: 2610 },
      "tripgrid/q4": { engine: "tripgrid", query: "q4", year: 2025, wall_seconds: 0.74, peak_rss_mb: 402 },
      "duckdb/q4": { engine: "duckdb", query: "q4", year: 2025, wall_seconds: 2.15, peak_rss_mb: 2890 },
      "pandas/q4": { engine: "pandas", query: "q4", year: 2025, wall_seconds: 9.84, peak_rss_mb: 4120 },
    },
    gates_vs_duckdb: {
      "tripgrid/q1": true,
      "tripgrid/q2": true,
      "tripgrid/q3": true,
      "tripgrid/q4": true,
    },
  },
};

function readBody(req: ReqLike): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: unknown) => {
      data += String(chunk);
    });
    req.on("end", () => resolve(data));
  });
}

function sendJson(res: ResLike, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function tripgridDevApiFallback(): Plugin {
  let backendUp: boolean | null = null;
  let lastProbe = 0;
  const cache = new Map<string, unknown>();
  const jobs = new Map<
    string,
    {
      status: string;
      payload: Record<string, unknown>;
      total: number;
    }
  >();

  async function isTripGridFastApiUp(): Promise<boolean> {
    const now = Date.now();
    if (backendUp !== null && now - lastProbe < 10_000) return backendUp;
    lastProbe = now;
    try {
      const resp = await fetch("http://127.0.0.1:8000/api/health", {
        signal: AbortSignal.timeout(400),
      });
      if (!resp.ok) {
        backendUp = false;
        return false;
      }
      const data = (await resp.json()) as { name?: string };
      backendUp = data?.name === "TripGrid API";
      return backendUp;
    } catch {
      backendUp = false;
      return false;
    }
  }

  return {
    name: "tripgrid-dev-api-fallback",
    configureServer(server) {
      server.middlewares.use(async (rawReq, rawRes, next) => {
        const req = rawReq as unknown as ReqLike;
        const res = rawRes as unknown as ResLike;
        const url = req.url ?? "";
        if (!url.startsWith("/api/")) return next();
        if (await isTripGridFastApiUp()) return next();

        if (req.method === "GET" && url === "/api/meta") {
          return sendJson(res, 200, {
            years: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026],
            months: ARCHIVE.months,
            month_rows: ARCHIVE.monthRows,
            newest_month: ARCHIVE.months[ARCHIVE.months.length - 1],
            queries: [],
            partitions: ARCHIVE.months.length * 8,
            total_rows: TOTAL_ROWS,
            archive_bytes: 5_240_000_000,
            freshness: {
              checked_at: "2026-11-22T12:00:00Z",
              updated: [],
            },
            ceiling_mb: 2048,
            workers: 8,
            cache: { entries: cache.size, bytes: 0, budget_bytes: 134_217_728 },
          });
        }
        if (req.method === "GET" && url === "/api/zones") {
          return sendJson(res, 200, ZONES);
        }
        if (req.method === "GET" && url === "/api/presets") {
          return sendJson(res, 200, PRESETS);
        }
        if (req.method === "GET" && url === "/api/builder") {
          return sendJson(res, 200, BUILDER_CATALOGUE);
        }
        if (req.method === "GET" && url === "/api/benchmarks") {
          return sendJson(res, 200, BENCHMARKS);
        }
        if (req.method === "GET" && url === "/api/live") {
          return sendJson(res, 200, {});
        }
        if (req.method === "POST" && url === "/api/spec/validate") {
          const parsed = JSON.parse((await readBody(req)) || "{}") as { spec?: Record<string, unknown> };
          return sendJson(res, 200, validateSpec(parsed.spec ?? {}));
        }
        const eventsMatch = url.match(/^\/api\/jobs\/([^/]+)\/events$/);
        if (req.method === "GET" && eventsMatch) {
          const job = jobs.get(eventsMatch[1]);
          if (!job) return sendJson(res, 404, { detail: "unknown job" });
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          const half = Math.max(1, Math.floor(job.total / 2));
          const chunks = [
            `data: ${JSON.stringify({ type: "progress", done: half, total: job.total })}\n\n`,
            `data: ${JSON.stringify({ type: "progress", done: job.total, total: job.total })}\n\n`,
            `data: ${JSON.stringify({ type: "done" })}\n\n`,
          ];
          job.status = "done";
          res.end(chunks.join(""));
          return;
        }
        const jobMatch = url.match(/^\/api\/jobs\/([^/]+)$/);
        if (req.method === "GET" && jobMatch) {
          const job = jobs.get(jobMatch[1]);
          if (!job) return sendJson(res, 404, { detail: "unknown job" });
          return sendJson(res, 200, {
            id: jobMatch[1],
            status: "done",
            ...job.payload,
          });
        }
        if (req.method === "POST" && (url === "/api/preset/run" || url === "/api/spec/run")) {
          const parsed = JSON.parse((await readBody(req)) || "{}") as {
            name?: string;
            range?: [string, string] | null;
            spec?: Record<string, unknown>;
            fresh?: boolean;
          };
          const key = JSON.stringify({ url, name: parsed.name, range: parsed.range, spec: parsed.spec });
          if (!parsed.fresh && cache.has(key)) {
            return sendJson(res, 200, { cached: true, job_id: null, ...(cache.get(key) as object) });
          }

          let payload: Record<string, unknown>;
          let totalParts = ARCHIVE.months.length * 8;
          if (url === "/api/preset/run") {
            const preset = PRESETS.find((p) => p.id === parsed.name);
            if (!preset) return sendJson(res, 400, { detail: "unknown preset" });
            if (preset.kind === "audit") {
              payload = {
                result: {
                  kind: "audit",
                  title: preset.title,
                  spec: null,
                  gate: null,
                  rows: [
                    { part: "paid_but_no_distance", label: "Paid, but went nowhere (distance ≤ 0, fare > 0)", trips: 4_812_390, sum_fare: 121_440_820 },
                    { part: "negative_fare", label: "Negative fares", trips: 2_394_118, sum_fare: -48_291_040 },
                    { part: "marathon_trips", label: "Trips longer than 4 hours", trips: 814_220 },
                    { part: "negative_duration", label: "Trips that end before they start", trips: 92_411 },
                  ],
                },
                stats: {
                  partitions_total: ARCHIVE.months.length * 8,
                  partitions_selected: ARCHIVE.months.length * 8,
                  partitions_pruned: 0,
                  rows_scanned: TOTAL_ROWS,
                  files_read: ARCHIVE.months.length * 8,
                  wall_seconds: 1.84,
                  peak_rss_mb: 392,
                  ceiling_mb: 2048,
                  under_ceiling: true,
                  workers: 8,
                },
              };
            } else {
              const rawSpec = { ...(preset.spec ?? {}), range: parsed.range ?? preset.spec?.range ?? "all" };
              const v = validateSpec(rawSpec);
              if (!v.ok || !v.spec) return sendJson(res, 400, { detail: v.error });
              totalParts = v.partitions_in_range ?? 96;
              payload = {
                result: {
                  kind: "preset",
                  title: preset.title,
                  spec: v.spec,
                  gate: v.gate,
                  rows: synthRows(v.spec as { range: [string, string]; measures: string[]; dimensions: string[]; top_k: number | null }),
                },
                stats: {
                  partitions_total: ARCHIVE.months.length * 8,
                  partitions_selected: totalParts,
                  partitions_pruned: ARCHIVE.months.length * 8 - totalParts,
                  rows_scanned: v.rows_in_range ?? 42_000_000,
                  files_read: totalParts,
                  wall_seconds: Number((0.36 + (v.months ?? 12) * 0.012).toFixed(2)),
                  peak_rss_mb: 348,
                  ceiling_mb: 2048,
                  under_ceiling: true,
                  workers: 8,
                },
              };
            }
          } else {
            const v = validateSpec(parsed.spec ?? {});
            if (!v.ok || !v.spec) return sendJson(res, 400, { detail: v.error });
            totalParts = v.partitions_in_range ?? 96;
            payload = {
              result: {
                kind: "spec",
                title: "Custom question",
                spec: v.spec,
                gate: v.gate,
                rows: synthRows(v.spec as { range: [string, string]; measures: string[]; dimensions: string[]; top_k: number | null }),
              },
              stats: {
                partitions_total: ARCHIVE.months.length * 8,
                partitions_selected: totalParts,
                partitions_pruned: ARCHIVE.months.length * 8 - totalParts,
                rows_scanned: v.rows_in_range ?? 42_000_000,
                files_read: totalParts,
                wall_seconds: Number((0.44 + (v.months ?? 12) * 0.011).toFixed(2)),
                peak_rss_mb: 364,
                ceiling_mb: 2048,
                under_ceiling: true,
                workers: 8,
              },
            };
          }
          cache.set(key, payload);
          const jobId = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          jobs.set(jobId, { status: "running", payload, total: totalParts });
          return sendJson(res, 200, { cached: false, job_id: jobId, status: "running" });
        }
        return next();
      });
    },
  };
}
