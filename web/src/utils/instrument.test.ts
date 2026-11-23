import test from "node:test";
import assert from "node:assert/strict";
import {
  countAllActiveFilters,
  countFiltersInTab,
  describeActiveFilters,
  filterPresetsByCategory,
  formatCompactNumber,
  formatHourRanges,
  formatPresetDefaultSpan,
  formatSpecSignature,
  getFilterTabForDimension,
  getPresetCategory,
  groupCatalogueDimensions,
  groupCatalogueMeasures,
  resolveActiveGeography,
  resolveEffectiveRange,
  rowsToCsv,
  shortDimensionLabel,
  shortMeasureLabel,
  toggleIn,
} from "./instrument";
import type { BuilderCatalogue, PresetInfo, SpecJobPayload } from "../api";

const SAMPLE_PRESETS: PresetInfo[] = [
  {
    id: "congestion_verdict",
    title: "Did congestion pricing work?",
    note: "Manhattan pickups.",
    kind: "spec",
    spec: {
      range: ["2024-01", "2026-12"],
      measures: ["trips", "avg_fare"],
      dimensions: ["month"],
      filters: { pu_boroughs: ["Manhattan"] },
    },
  },
  {
    id: "busiest_routes",
    title: "Busiest routes",
    note: "Top 20 routes.",
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
    id: "fare_percentiles",
    title: "Exact fare percentiles per borough",
    note: "Original Q4.",
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
    note: "Four small counts.",
    kind: "audit",
    parts: [{ name: "negative_fare", label: "Negative fares" }],
  },
];

const SAMPLE_CATALOGUE: BuilderCatalogue = {
  measures: [
    { id: "trips", label: "Trips", unit: "count", percentile: false },
    { id: "avg_fare", label: "Average fare", unit: "usd", percentile: false },
    { id: "avg_speed", label: "Average speed", unit: "mph", percentile: false },
    { id: "p50_fare", label: "Median fare (p50)", unit: "usd", percentile: true },
  ],
  dimensions: [
    { id: "month", label: "Month", cardinality: null },
    { id: "pu_borough", label: "Pickup borough", cardinality: 8 },
    { id: "payment_type", label: "Payment type", cardinality: 8 },
  ],
  filters: [],
  boroughs: ["Manhattan", "Brooklyn", "Queens"],
  payments: [
    { id: 1, label: "Card" },
    { id: 2, label: "Cash" },
  ],
  max_buckets: 500000,
  max_pctl_groups: 128,
};

test("preset categorization maps policy, flows, benchmarks, and audit cleanly", () => {
  assert.equal(getPresetCategory(SAMPLE_PRESETS[0]).id, "policy");
  assert.equal(getPresetCategory(SAMPLE_PRESETS[1]).id, "flows");
  assert.equal(getPresetCategory(SAMPLE_PRESETS[2]).id, "benchmarks");
  assert.equal(getPresetCategory(SAMPLE_PRESETS[2]).tag, "Fares");
  assert.equal(getPresetCategory(SAMPLE_PRESETS[3]).id, "audit");

  assert.equal(filterPresetsByCategory(SAMPLE_PRESETS, "all").length, 4);
  assert.equal(filterPresetsByCategory(SAMPLE_PRESETS, "benchmarks").length, 1);
  assert.equal(filterPresetsByCategory(SAMPLE_PRESETS, "audit").length, 1);
});

test("measure and dimension grouping preserves all items including unknown future ones", () => {
  const mGroups = groupCatalogueMeasures([
    ...SAMPLE_CATALOGUE.measures,
    { id: "custom_metric", label: "Custom metric", unit: "plain", percentile: false },
  ]);
  const totalMeasures = mGroups.reduce((a, g) => a + g.items.length, 0);
  assert.equal(totalMeasures, 5);
  assert.equal(mGroups[mGroups.length - 1].id, "other");

  const dGroups = groupCatalogueDimensions(SAMPLE_CATALOGUE.dimensions);
  assert.equal(dGroups.length, 3);
  assert.equal(getFilterTabForDimension("pu_borough"), "geography");
  assert.equal(getFilterTabForDimension("pu_zone"), "zones");
  assert.equal(getFilterTabForDimension("hour"), "schedule");
  assert.equal(getFilterTabForDimension("payment_type"), "trip");
  assert.equal(getFilterTabForDimension("month"), null);
  assert.equal(shortMeasureLabel("tip_pct_card", "Tip % — card trips only"), "Tip % (card only)");
  assert.equal(shortDimensionLabel("route", "Route — pickup → drop-off"), "Route (PU → DO)");
});

test("filter counts, hour range compaction, and active filter tokens work accurately", () => {
  const filters = {
    pu_boroughs: ["Manhattan"],
    hours: [17, 18, 19, 20, 21, 22, 23],
    weekdays: [4],
    fare_min: 15,
    sane_only: true,
    empty_list: [],
  };
  assert.equal(countFiltersInTab(filters, "geography"), 1);
  assert.equal(countFiltersInTab(filters, "schedule"), 2);
  assert.equal(countFiltersInTab(filters, "trip"), 2);
  assert.equal(countAllActiveFilters(filters), 5);
  assert.equal(formatHourRanges([0, 1, 2, 17, 18, 22]), "00–02h, 17–18h, 22h");

  const tokens = describeActiveFilters(filters, SAMPLE_CATALOGUE, {
    "132": { borough: "Queens", zone: "JFK Airport" },
  });
  assert.equal(tokens.length, 5);
  assert.deepEqual(
    tokens.find((t) => t.id === "hours"),
    { id: "hours", label: "Hours", value: "17–23h" },
  );
  assert.deepEqual(
    tokens.find((t) => t.id === "weekdays"),
    { id: "weekdays", label: "Days", value: "Fri" },
  );
});

test("recipe formatting, compact numbers, toggleIn, and range clamping work", () => {
  assert.deepEqual(toggleIn([1, 2], 2), [1]);
  assert.deepEqual(toggleIn([1, 2], 3), [1, 2, 3]);
  assert.equal(formatCompactNumber(500000), "500.0K");
  assert.equal(formatCompactNumber(108400000), "108.4M");
  assert.equal(formatPresetDefaultSpan(SAMPLE_PRESETS[0].spec), "2024–2026");
  assert.equal(formatPresetDefaultSpan(SAMPLE_PRESETS[1].spec), "All years");

  const sig = formatSpecSignature(SAMPLE_PRESETS[0].spec, SAMPLE_CATALOGUE);
  assert.equal(sig, "Trips, Average fare · by Month");

  const clamped = resolveEffectiveRange(
    null,
    SAMPLE_PRESETS[0].spec,
    ["2017-01", "2024-01", "2025-12"],
    false,
  );
  assert.deepEqual(clamped, ["2024-01", "2025-12"]);
  assert.equal(
    resolveEffectiveRange(["2025-01", "2025-12"], SAMPLE_PRESETS[0].spec, ["2025-01"], true),
    null,
  );
});

test("rowsToCsv escapes commas, quotes, and nulls cleanly", () => {
  const payload = {
    cached: false,
    stats: {
      partitions_total: 10,
      partitions_selected: 10,
      partitions_pruned: 0,
      rows_scanned: 100,
      files_read: 10,
      wall_seconds: 0.5,
      peak_rss_mb: 320,
      ceiling_mb: 2048,
      under_ceiling: true,
      workers: 8,
    },
    result: {
      kind: "preset",
      title: "Test",
      spec: null,
      gate: null,
      rows: [
        { zone: 'Midtown, "Center"', trips: 1200, avg_fare: 18.5 },
        { zone: "JFK Airport", trips: 900, avg_fare: null },
      ],
    },
  } satisfies SpecJobPayload;

  const csv = rowsToCsv(payload);
  assert.equal(
    csv,
    'zone,trips,avg_fare\n"Midtown, ""Center""",1200,18.5\nJFK Airport,900,',
  );
});

test("resolveActiveGeography computes NYC borough and airport pruning accurately", () => {
  const zones = {
    "132": { borough: "Queens", zone: "JFK Airport" },
    "138": { borough: "Queens", zone: "LaGuardia Airport" },
    "161": { borough: "Manhattan", zone: "Midtown Center" },
  };
  const manhattanOnly = resolveActiveGeography(
    {
      range: "all",
      measures: ["trips"],
      dimensions: ["month"],
      filters: { pu_boroughs: ["Manhattan"] },
    },
    zones,
    false,
  );
  assert.deepEqual(manhattanOnly.boroughs, ["Manhattan"]);
  assert.equal(manhattanOnly.prunedCount, 4);

  const airportSpec = resolveActiveGeography(
    {
      range: "all",
      measures: ["trips"],
      dimensions: ["payment_type"],
      filters: { airport: [132] },
    },
    zones,
    false,
  );
  assert.deepEqual(airportSpec.airports, ["JFK"]);
  assert.deepEqual(airportSpec.boroughs, ["Queens"]);

  const auditGeo = resolveActiveGeography(null, zones, true);
  assert.equal(auditGeo.boroughs.length, 5);
  assert.equal(auditGeo.prunedCount, 0);
});
