import type { JobPayload, ZoneMap } from "../api";

const fmt = (n: number) => n.toLocaleString("en-US");
const money = (n: number) => `$${n.toFixed(2)}`;

const PAYMENT_LABELS: Record<number, string> = {
  0: "Not recorded",
  1: "Credit card",
  2: "Cash",
  3: "No charge",
  4: "Dispute",
  5: "Unknown",
  6: "Voided trip",
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

interface Props {
  payload: JobPayload;
  zones: ZoneMap;
}

export default function Results({ payload, zones }: Props) {
  const r = payload.result;

  if (r.kind === "q1") {
    const monthTotals = r.matrix.map((row) => row.reduce((a, b) => a + b, 0));
    const maxMonth = Math.max(...monthTotals);
    const zoneTotals: { id: number; total: number }[] = [];
    for (let z = 1; z < r.matrix[0].length; z++) {
      let total = 0;
      for (let m = 0; m < 12; m++) total += r.matrix[m][z];
      if (total > 0) zoneTotals.push({ id: z, total });
    }
    zoneTotals.sort((a, b) => b.total - a.total);
    const top = zoneTotals.slice(0, 10);
    const topMax = top[0]?.total ?? 1;
    return (
      <div className="split2">
        <div>
          <span className="label">Trips per month</span>
          <div className="monthbars">
            {monthTotals.map((t, i) => (
              <div className="mb" key={i} title={`${MONTHS[i]} — ${fmt(t)} trips`}>
                <i style={{ height: `${Math.max(2, (t / maxMonth) * 130)}px` }} />
                <span>{MONTHS[i]}</span>
              </div>
            ))}
          </div>
          <p className="mono" style={{ marginTop: 12, fontSize: 12, color: "var(--bone-dim)" }}>
            TOTAL — {fmt(r.total)} TRIPS
          </p>
        </div>
        <div>
          <span className="label">Busiest pickup zones</span>
          <div style={{ marginTop: 8 }}>
            {top.map((z, i) => (
              <div className="zrow" key={z.id}>
                <div className="rk">{String(i + 1).padStart(2, "0")}</div>
                <div>
                  <span className="zname">{zones[String(z.id)]?.zone ?? `Zone ${z.id}`}</span>
                  <span className="zsub">{zones[String(z.id)]?.borough ?? ""}</span>
                  <div className="bar">
                    <i style={{ width: `${(z.total / topMax) * 100}%` }} />
                  </div>
                </div>
                <div className="zv">{fmt(z.total)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (r.kind === "q2") {
    const rows = [...r.rows].sort((a, b) => b.trips - a.trips);
    const maxTip = Math.max(...rows.map((x) => x.tip_pct), 1);
    return (
      <table className="ptable">
        <thead>
          <tr>
            <th>Payment type</th>
            <th className="num">Trips</th>
            <th className="num">Avg fare</th>
            <th className="num">Tip share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.payment_type}>
              <td className="who">{PAYMENT_LABELS[row.payment_type] ?? `Type ${row.payment_type}`}</td>
              <td className="num">{fmt(row.trips)}</td>
              <td className="num">{money(row.avg_fare)}</td>
              <td className="num">
                {row.tip_pct.toFixed(1)}%
                <div className="tipbar">
                  <i style={{ width: `${(row.tip_pct / maxTip) * 100}%` }} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (r.kind === "q3") {
    const max = r.rows[0]?.trips ?? 1;
    return (
      <div>
        {r.rows.map((row, i) => (
          <div className="zrow" key={row.zone}>
            <div className="rk">{String(i + 1).padStart(2, "0")}</div>
            <div>
              <span className="zname">{row.zone}</span>
              <span className="zsub">{row.borough}</span>
              <div className="bar">
                <i style={{ width: `${(row.trips / max) * 100}%` }} />
              </div>
            </div>
            <div className="zv">{fmt(row.trips)}</div>
          </div>
        ))}
      </div>
    );
  }

  // q4 — exact fare percentiles per borough
  const maxP99 = Math.max(...r.rows.map((x) => x.p99), 1);
  return (
    <table className="ptable">
      <thead>
        <tr>
          <th>Borough</th>
          <th className="num">Trips</th>
          <th className="num">Distinct fares</th>
          <th style={{ minWidth: 190 }}>Fare spread — p50 · p90 · p99</th>
          <th className="num">p50</th>
          <th className="num">p90</th>
          <th className="num">p99</th>
        </tr>
      </thead>
      <tbody>
        {r.rows.map((row) => (
          <tr key={row.borough}>
            <td className="who">{row.borough}</td>
            <td className="num">{fmt(row.trips)}</td>
            <td className="num">{fmt(row.distinct_fares)}</td>
            <td>
              <div className="pct-track">
                <div className="rail" />
                <div className="tick p99" style={{ left: `${(row.p99 / maxP99) * 100}%` }} />
                <div className="tick p90" style={{ left: `${(row.p90 / maxP99) * 100}%` }} />
                <div className="tick p50" style={{ left: `${(row.p50 / maxP99) * 100}%` }} />
              </div>
            </td>
            <td className="num">{money(row.p50)}</td>
            <td className="num">{money(row.p90)}</td>
            <td className="num">{money(row.p99)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
