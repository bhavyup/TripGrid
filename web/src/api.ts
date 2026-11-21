/* TripGrid API client — thin, typed, no magic. */

export interface QueryInfo {
  id: string;
  title: string;
  description: string;
}

export interface Meta {
  years: number[];
  queries: QueryInfo[];
  partitions: number;
  total_rows: number;
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
  rows_pruned: number;
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

async function getJson<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url} -> ${resp.status}`);
  return (await resp.json()) as T;
}

export const fetchMeta = () => getJson<Meta>("/api/meta");
export const fetchZones = () => getJson<ZoneMap>("/api/zones");
export const fetchBenchmarks = () =>
  getJson<Record<string, BenchSuite>>("/api/benchmarks");
export const fetchPlan = (query: string, year: number) =>
  getJson<Plan>(`/api/plan?query=${query}&year=${year}`);

function shape(query: string, raw: { result: never; stats: RunStats }): ResultPayload {
  if (query === "q1") {
    const r = raw.result as unknown as { total: number; matrix: number[][] };
    return { kind: "q1", total: r.total, matrix: r.matrix };
  }
  const r = raw.result as unknown as { rows: never };
  return { kind: query, rows: r.rows } as ResultPayload;
}

/**
 * Runs a query through the job API. Progress (files finished /
 * files total) streams over SSE; a slow poll backs it up in case
 * the stream is interrupted. Resolves with the shaped payload.
 */
export async function runQuery(
  query: string,
  year: number,
  onProgress: (done: number, total: number) => void,
): Promise<JobPayload> {
  const resp = await fetch("/api/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, year }),
  });
  if (!resp.ok) throw new Error(`start query -> ${resp.status}`);
  const started = (await resp.json()) as {
    cached: boolean;
    job_id: string | null;
    result?: never;
    stats?: RunStats;
  };
  if (started.cached && started.stats) {
    return {
      result: shape(query, started as unknown as { result: never; stats: RunStats }),
      stats: started.stats,
      cached: true,
    };
  }
  const jobId = started.job_id as string;

  const final = await new Promise<{ result: never; stats: RunStats }>(
    (resolve, reject) => {
      let settled = false;
      const finish = (body: { status: string; result?: never; stats?: RunStats; error?: string }) => {
        if (settled) return;
        if (body.status === "done" && body.stats) {
          settled = true;
          cleanup();
          resolve({ result: body.result as never, stats: body.stats });
        } else if (body.status === "error") {
          settled = true;
          cleanup();
          reject(new Error(body.error ?? "job failed"));
        }
      };
      const poll = window.setInterval(async () => {
        try {
          const body = await getJson<{
            status: string;
            result?: never;
            stats?: RunStats;
            error?: string;
          }>(`/api/jobs/${jobId}`);
          finish(body);
        } catch {
          /* keep polling */
        }
      }, 900);
      const es = new EventSource(`/api/jobs/${jobId}/events`);
      es.onmessage = (ev) => {
        try {
          const event = JSON.parse(ev.data) as {
            type: string;
            done?: number;
            total?: number;
          };
          if (event.type === "progress" && event.done != null && event.total != null) {
            onProgress(event.done, event.total);
          } else if (event.type === "done" || event.type === "error") {
            getJson<{ status: string; result?: never; stats?: RunStats; error?: string }>(
              `/api/jobs/${jobId}`,
            )
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
        es.close();
      };
    },
  );
  return { result: shape(query, final), stats: final.stats, cached: false };
}
