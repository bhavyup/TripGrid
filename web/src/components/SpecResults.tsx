import type { BuilderCatalogue, SpecJobPayload, SpecRow } from "../api";

const fmt = (n: number) => n.toLocaleString("en-US");
const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
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
      return v.toFixed(1);
    case "duration_s":
      return `${(v / 60).toFixed(1)} min`;
    case "mi":
      return Math.abs(v) >= 10000 ? fmt(Math.round(v)) : v.toFixed(2);
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
 * One renderer for every recipe answer. The rows are
 * self-describing; the catalogue supplies each measure's label
 * and unit. A single measure gets ranked bars; several measures
 * get a table; the junk audit gets its four verdict lines.
 */
export default function SpecResults({ payload, catalogue }: Props) {
  const { result } = payload;
  const rows = result.rows;
  const payments = new Map((catalogue?.payments ?? []).map((p) => [p.id, p.label]));
  const measureMeta = (id: string) =>
    catalogue?.measures.find((m) => m.id === id) ?? { label: id, unit: "plain" };

  if (result.kind === "audit") {
    const max = Math.max(...rows.map((r) => num(r, "trips") ?? 0), 1);
    return (
      <div>
        {rows.map((r) => (
          <div className="zrow" key={String(r.part)}>
            <div className="rk">§</div>
            <div>
              <span className="zname">{str(r, "label")}</span>
              <div className="bar">
                <i style={{ width: `${((num(r, "trips") ?? 0) / max) * 100}%` }} />
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
      <p className="mono" style={{ fontSize: 12.5, color: "var(--bone-dim)" }}>
        No trips matched — the filters excluded everything in this range.
      </p>
    );
  }

  const measures = result.spec?.measures ?? [];
  const dims = result.spec?.dimensions ?? [];
  const first = measures[0];

  if (measures.length <= 1) {
    const max = Math.max(...rows.map((r) => num(r, first) ?? 0), 1);
    const meta = measureMeta(first);
    return (
      <div>
        {rows.map((r, i) => {
          const { main, sub } = rowLabel(r, dims, payments);
          const v = num(r, first);
          return (
            <div className="zrow" key={i}>
              <div className="rk">{String(i + 1).padStart(2, "0")}</div>
              <div>
                <span className="zname">{main}</span>
                {sub && <span className="zsub">{sub}</span>}
                <div className="bar">
                  <i style={{ width: `${((v ?? 0) / max) * 100}%` }} />
                </div>
              </div>
              <div className="zv">{fmtValue(meta.unit, v)}</div>
            </div>
          );
        })}
      </div>
    );
  }

  const maxFirst = Math.max(...rows.map((r) => num(r, first) ?? 0), 1);
  return (
    <table className="ptable">
      <thead>
        <tr>
          <th>Group</th>
          {measures.map((m) => (
            <th className="num" key={m}>
              {measureMeta(m).label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const { main, sub } = rowLabel(r, dims, payments);
          return (
            <tr key={i}>
              <td className="who">
                {main}
                {sub && <span className="zsub"> — {sub}</span>}
                <div className="tipbar">
                  <i
                    style={{
                      width: `${((num(r, first) ?? 0) / maxFirst) * 100}%`,
                    }}
                  />
                </div>
              </td>
              {measures.map((m) => (
                <td className="num" key={m}>
                  {fmtValue(measureMeta(m).unit, num(r, m))}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
