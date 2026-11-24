import type { BuilderCatalogue, SpecJobPayload, SpecRow } from "../api";

const fmt = (n: number) => n.toLocaleString("en-US");
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function fmtValue(unit: string, v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  switch (unit) {
    case "count":
      return fmt(Math.round(v));
    case "usd":
      return "$" + (Math.abs(v) >= 10000 ? fmt(Math.round(v)) : v.toFixed(2));
    case "pct":
      return `${v.toFixed(1)}%`;
    case "mph":
      return `${v.toFixed(1)} mph`;
    case "duration_s":
      return `${(v / 60).toFixed(1)} min`;
    case "mi":
      return Math.abs(v) >= 10000
        ? `${fmt(Math.round(v))} mi`
        : `${v.toFixed(2)} mi`;
    default:
      return v.toFixed(2);
  }
}

const num = (row: SpecRow, key: string): number | null =>
  typeof row[key] === "number" ? (row[key] as number) : null;
const str = (row: SpecRow, key: string): string =>
  typeof row[key] === "string" ? (row[key] as string) : "";

function fmtMonth(ym: string): string {
  const [y, m] = ym.split("-");
  return `${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
}

/** The group's name, composed from whichever dimension fields
 * the composer put on the row — zone names ride along with their
 * ids, weekdays with their names, so no lookup is needed here. */
function rowLabel(
  row: SpecRow,
  dims: string[],
  payments: Map<number, string>,
): { main: string; sub: string } {
  const parts: string[] = [];
  const subs: string[] = [];
  for (const d of dims) {
    switch (d) {
      case "year":
        parts.push(String(row.year ?? ""));
        break;
      case "month":
        parts.push(fmtMonth(str(row, "month")));
        break;
      case "month_of_year":
        parts.push(MONTH_NAMES[(num(row, "month_of_year") ?? 1) - 1] ?? "");
        break;
      case "pu_borough":
        parts.push(str(row, "pu_borough"));
        break;
      case "do_borough":
        parts.push(str(row, "do_borough"));
        break;
      case "pu_zone":
        parts.push(str(row, "pu_zone_name") || `Zone ${row.pu_zone}`);
        if (str(row, "pu_borough")) subs.push(str(row, "pu_borough"));
        break;
      case "do_zone":
        parts.push(str(row, "do_zone_name") || `Zone ${row.do_zone}`);
        if (str(row, "do_borough")) subs.push(str(row, "do_borough"));
        break;
      case "route":
        parts.push(
          `${str(row, "pu_zone_name") || `Zone ${row.pu_zone}`} → ${
            str(row, "do_zone_name") || `Zone ${row.do_zone}`
          }`,
        );
        break;
      case "hour":
        parts.push(`${String(num(row, "hour") ?? 0).padStart(2, "0")}:00`);
        break;
      case "weekday":
        parts.push(str(row, "weekday_name"));
        break;
      case "hour_weekday":
        parts.push(
          `${str(row, "weekday_name").slice(0, 3)} ${String(
            num(row, "hour") ?? 0,
          ).padStart(2, "0")}:00`,
        );
        break;
      case "payment_type":
        parts.push(
          payments.get(num(row, "payment_type") ?? -1) ??
            `Type ${row.payment_type}`,
        );
        break;
      case "airport":
        parts.push(row.airport ? "Airport pickup" : "Anywhere else");
        break;
    }
  }
  return { main: parts.join(" · ") || "All trips", sub: subs.join(" · ") };
}

interface Props {
  payload: SpecJobPayload;
  catalogue: BuilderCatalogue | null;
}

/**
 * One renderer for every recipe answer, in one visual language.
 * The rows are self-describing; the catalogue supplies each
 * measure's label and unit. Every row is a ranked bar row: the
 * first measure drives the bar and the big value, the rest ride
 * along as sub-lines beneath it. No header anywhere — the table
 * variant is gone, so a two-measure answer looks like a
 * one-measure answer with one more line. The junk audit keeps its
 * four verdict lines. At most 150 rows mount: a runaway answer
 * (Q1 returns 30,379 rows) used to mount 30k DOM nodes and every
 * 100 ms progress tick reconciled all of them — that is what made
 * the app stick after Q8. The full answer stays one Export CSV
 * click away.
 */
export default function SpecResults({ payload, catalogue }: Props) {
  const { result } = payload;
  const rows = result.rows;
  const payments = new Map(
    (catalogue?.payments ?? []).map((p) => [p.id, p.label]),
  );
  const measureMeta = (id: string) =>
    catalogue?.measures.find((m) => m.id === id) ?? { label: id, unit: "plain" };

  if (result.kind === "audit") {
    const max = Math.max(...rows.map((r) => num(r, "trips") ?? 0), 1);
    return (
      <div>
        {rows.map((r, idx) => (
          <div className="zrow" key={String(r.part ?? idx)}>
            <div className="rk">{String(idx + 1).padStart(2, "0")}</div>
            <div>
              <span className="zname">{str(r, "label")}</span>
              <div className="bar">
                <i
                  style={{
                    width: `${((num(r, "trips") ?? 0) / max) * 100}%`,
                  }}
                />
              </div>
            </div>
            <div className="zv">
              {fmt(num(r, "trips") ?? 0)}
              {num(r, "sum_fare") != null && (
                <span className="zsub" style={{ display: "block" }}>
                  {fmtValue("usd", num(r, "sum_fare"))}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p
        className="mono"
        style={{ fontSize: 12.5, color: "var(--bone-dim)", padding: "18px 0" }}
      >
        No trips matched — the active filters excluded every trip in this range.
      </p>
    );
  }

  const measures = result.spec?.measures ?? [];
  const dims = result.spec?.dimensions ?? [];
  const first = measures[0];
  const maxFirst = Math.max(...rows.map((r) => num(r, first) ?? 0), 1);
  // Cap what mounts: 150 rows is far more than the panel shows at
  // once, and the rest of the answer is in Export CSV.
  const ROW_CAP = 150;
  const shown = rows.slice(0, ROW_CAP);
  return (
    <div>
      {shown.map((r, i) => {
        const { main, sub } = rowLabel(r, dims, payments);
        const v = num(r, first);
        return (
          <div className="zrow" key={i}>
            <div className="rk">{String(i + 1).padStart(2, "0")}</div>
            <div>
              <span className="zname">{main}</span>
              {sub && <span className="zsub">{sub}</span>}
              <div className="bar">
                <i style={{ width: `${((v ?? 0) / maxFirst) * 100}%` }} />
              </div>
            </div>
            <div className="zv">
              {fmtValue(measureMeta(first).unit, v)}
              {measures.slice(1).map((m) => (
                <span className="zsub" key={m} style={{ display: "block" }}>
                  {measureMeta(m).label}{" "}
                  {fmtValue(measureMeta(m).unit, num(r, m))}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {rows.length > ROW_CAP && (
        <p
          className="mono"
          style={{
            fontSize: 11.5,
            color: "var(--bone-faint)",
            padding: "12px 0 4px",
            borderTop: "1px solid var(--line-soft)",
          }}
        >
          Showing {ROW_CAP} of {fmt(rows.length)} rows — the full answer is
          in Export CSV.
        </p>
      )}
    </div>
  );
}
