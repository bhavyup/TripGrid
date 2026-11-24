/* TripGrid API client — thin, typed, no magic. */

export interface QueryInfo {
  id: string;
  title: string;
  description: string;
}

export interface FreshnessStatus {
  checked_at?: string;
  new_months?: string[];
  republished?: string[];
  updated?: string[];
  error?: string;
}

export interface Meta {
  years: number[];
  months: string[];
  month_rows: Record<string, number>;
  newest_month: string | null;
  queries: QueryInfo[];
  partitions: number;
  total_rows: number;
  archive_bytes: number;
  freshness: FreshnessStatus | null;
  ceiling_mb: number;
  workers: number;
  cache: { entries: number; bytes: number; budget_bytes: number };
}

export interface Partition {
  month: string;
  borough: string;
  path: string;
  rows: number;
  selected: boolean;
}

export interface PlanStats {
  partitions_total: number;
  partitions_selected: number;
  partitions_pruned: number;
  rows_total: number;
  rows_selected: number;
  // Note: the planner reports rows_total and rows_selected only;
  // rows pruned is derived (total - selected), never a field.
}

export interface Plan {
  query: string;
  year: number;
  stats: PlanStats;
  partitions: Partition[];
}

export interface RunStats {
  partitions_total: number;
  partitions_selected: number;
  partitions_pruned: number;
  rows_total?: number;
  rows_selected?: number;
  rows_scanned: number;
  files_read: number;
  wall_seconds: number;
  peak_rss_mb: number;
  ceiling_mb: number;
  under_ceiling: boolean;
  workers: number;
}

export type ResultPayload =
  | { kind: "q1"; total: number; matrix: number[][] }
  | { kind: "q2"; rows: Q2Row[] }
  | { kind: "q3"; rows: Q3Row[] }
  | { kind: "q4"; rows: Q4Row[] };

export interface Q2Row {
  payment_type: number;
  trips: number;
  avg_fare: number;
  tip_pct: number;
}

export interface Q3Row {
  zone: string;
  borough: string;
  trips: number;
}

export interface Q4Row {
  borough: string;
  trips: number;
  distinct_fares: number;
  p50: number;
  p90: number;
  p99: number;
}

export interface JobPayload {
  result: ResultPayload;
  stats: RunStats;
  cached: boolean;
}

export interface ZoneMap {
  [id: string]: { borough: string; zone: string };
}

export interface BenchRun {
  engine: string;
  query: string;
  year: number;
  wall_seconds: number;
  peak_rss_mb: number;
}

export interface BenchSuite {
  year: number;
  runs: Record<string, BenchRun>;
  gates_vs_duckdb: Record<string, boolean>;
}

/** One real console run, recorded by the server. Only genuine
 * executions land here — cache answers never do. */
export interface LiveRun {
  wall_seconds: number;
  peak_rss_mb: number;
  rows_scanned: number;
  files_read: number;
  partitions_selected: number;
  runs: number;
  last_run_at: string;
}

/* ---------------- TripGrid 2.0: recipes ---------------- */

export interface SpecDict {
  range: [string, string] | "all";
  measures: string[];
  dimensions: string[];
  filters: Record<string, unknown>;
  top_k?: number | null;
  sort?: string;
}

export interface PresetInfo {
  id: string;
  title: string;
  note: string;
  kind: "spec" | "audit";
  spec?: SpecDict;
  parts?: { name: string; label: string }[];
}

export interface GateReport {
  buckets: number;
  budget: number;
  shape: string;
}

export interface ValidateResult {
  ok: boolean;
  error?: string;
  gate?: GateReport;
  months?: number;
  rows_in_range?: number;
  partitions_in_range?: number;
  spec?: SpecDict;
}

export interface BuilderCatalogue {
  measures: { id: string; label: string; unit: string; percentile: boolean }[];
  dimensions: { id: string; label: string; cardinality: number | null }[];
  filters: { id: string; label: string; kind: string }[];
  boroughs: string[];
  payments: { id: number; label: string }[];
  max_buckets: number;
  max_pctl_groups: number;
}

export type SpecRow = Record<string, string | number | boolean | null>;

export interface SpecResultPayload {
  kind: "spec" | "preset" | "audit";
  title: string;
  rows: SpecRow[];
  spec: SpecDict | null;
  gate: GateReport | null;
}

export interface SpecJobPayload {
  result: SpecResultPayload;
  stats: RunStats;
  cached: boolean;
}

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  return (await resp.json()) as T;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    let detail = `${url} -> ${resp.status}`;
    try {
      const parsed = (await resp.json()) as { detail?: string };
      if (parsed.detail) detail = parsed.detail;
    } catch {
      /* keep the status line */
    }
    throw new Error(detail);
  }
  return (await resp.json()) as T;
}

export const fetchMeta = () => getJson<Meta>("/api/meta");
export const fetchZones = () => getJson<ZoneMap>("/api/zones");
export const fetchBenchmarks = () =>
  getJson<Record<string, BenchSuite>>("/api/benchmarks");
export const fetchLive = () =>
  getJson<Record<string, Record<string, LiveRun>>>("/api/live");
export const fetchPlan = (query: string, year: number) =>
  getJson<Plan>(`/api/plan?query=${query}&year=${year}`);
export const fetchPresets = () => getJson<PresetInfo[]>("/api/presets");
export const fetchBuilder = () => getJson<BuilderCatalogue>("/api/builder");
export const validateSpec = (spec: SpecDict) =>
  postJson<ValidateResult>("/api/spec/validate", { spec });

interface StartedJob {
  cached: boolean;
  job_id: string | null;
  result?: unknown;
  stats?: RunStats;
}

interface JobBody {
  status: string;
  result?: unknown;
  stats?: RunStats;
  error?: string;
}

/**
 * Waits for a started job: progress streams over SSE (files
 * finished / files total), a slow poll backs it up in case the
 * stream is interrupted.
 */
function awaitJob(
  jobId: string,
  onProgress: (done: number, total: number) => void,
): Promise<{ result: unknown; stats: RunStats }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (body: JobBody) => {
      if (settled) return;
      if (body.status === "done" && body.stats) {
        settled = true;
        cleanup();
        resolve({ result: body.result, stats: body.stats });
      } else if (body.status === "error") {
        settled = true;
        cleanup();
        reject(new Error(body.error ?? "job failed"));
      }
    };
    const poll = window.setInterval(async () => {
      try {
        finish(await getJson<JobBody>(`/api/jobs/${jobId}`));
      } catch {
        /* keep polling */
      }
    }, 900);
    // The server reports progress per file finished; over the whole
    // archive that is ~50 events a second, and every one re-rendered the
    // entire theater (heavy SVG + 1320-cell month matrix), which froze the
    // tab on long runs. Forward at most one update per 100 ms, always with
    // the latest values; the final numbers come from the job payload anyway.
    let lastProgressAt = 0;
    let pendingProgress: { done: number; total: number } | null = null;
    let progressTimer: number | undefined;
    const flushProgress = () => {
      progressTimer = undefined;
      if (pendingProgress) {
        lastProgressAt = Date.now();
        onProgress(pendingProgress.done, pendingProgress.total);
        pendingProgress = null;
      }
    };
    const reportProgress = (done: number, total: number) => {
      const now = Date.now();
      if (now - lastProgressAt >= 100) {
        lastProgressAt = now;
        pendingProgress = null;
        if (progressTimer !== undefined) {
          window.clearTimeout(progressTimer);
          progressTimer = undefined;
        }
        onProgress(done, total);
      } else {
        pendingProgress = { done, total };
        if (progressTimer === undefined) {
          progressTimer = window.setTimeout(flushProgress, 100 - (now - lastProgressAt));
        }
      }
    };
    const es = new EventSource(`/api/jobs/${jobId}/events`);
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as {
          type: string;
          done?: number;
          total?: number;
        };
        if (event.type === "progress" && event.done != null && event.total != null) {
          reportProgress(event.done, event.total);
        } else if (event.type === "done" || event.type === "error") {
          getJson<JobBody>(`/api/jobs/${jobId}`)
            .then(finish)
            .catch(() => undefined);
        }
      } catch {
        /* malformed event: ignore */
      }
    };
    es.onerror = () => {
      /* the poll is the safety net */
    };
    const cleanup = () => {
      window.clearInterval(poll);
      if (progressTimer !== undefined) window.clearTimeout(progressTimer);
      es.close();
    };
  });
}

async function startAndAwait(
  url: string,
  body: unknown,
  onProgress: (done: number, total: number) => void,
): Promise<{ result: unknown; stats: RunStats; cached: boolean }> {
  const started = await postJson<StartedJob>(url, body);
  if (started.cached && started.stats) {
    return { result: started.result, stats: started.stats, cached: true };
  }
  const final = await awaitJob(started.job_id as string, onProgress);
  return { ...final, cached: false };
}

function shape(query: string, raw: { result: never; stats: RunStats }): ResultPayload {
  if (query === "q1") {
    const r = raw.result as unknown as { total: number; matrix: number[][] };
    return { kind: "q1", total: r.total, matrix: r.matrix };
  }
  const r = raw.result as unknown as { rows: never };
  return { kind: query, rows: r.rows } as ResultPayload;
}

/** Runs one of the original four questions through the job API. */
export async function runQuery(
  query: string,
  year: number,
  onProgress: (done: number, total: number) => void,
  fresh = false,
): Promise<JobPayload> {
  const out = await startAndAwait(
    "/api/query",
    { query, year, fresh },
    onProgress,
  );
  return {
    result: shape(query, out as unknown as { result: never; stats: RunStats }),
    stats: out.stats,
    cached: out.cached,
  };
}

/** Runs a hand-built recipe from the Question Builder. */
export async function runSpec(
  spec: SpecDict,
  onProgress: (done: number, total: number) => void,
  fresh = false,
): Promise<SpecJobPayload> {
  const out = await startAndAwait("/api/spec/run", { spec, fresh }, onProgress);
  return {
    result: out.result as SpecResultPayload,
    stats: out.stats,
    cached: out.cached,
  };
}

/** Runs a preset; range overrides the preset's own when given. */
export async function runPreset(
  name: string,
  range: [string, string] | null,
  onProgress: (done: number, total: number) => void,
  fresh = false,
): Promise<SpecJobPayload> {
  const out = await startAndAwait(
    "/api/preset/run",
    { name, range, fresh },
    onProgress,
  );
  return {
    result: out.result as SpecResultPayload,
    stats: out.stats,
    cached: out.cached,
  };
}
