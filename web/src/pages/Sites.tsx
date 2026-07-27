import { useEffect, useMemo, useState } from "react";
import { api, type SiteSummary, type DayPoint } from "../lib/api";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { formatCompactNumber, formatPct } from "../lib/format";

type SortKey = "name" | "continent" | "sessionsLast7d" | "sessionsChangePct" | "conversionRateLast7d";

export function Sites() {
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [selected, setSelected] = useState<SiteSummary | null>(null);
  const [series, setSeries] = useState<DayPoint[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("sessionsLast7d");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  useEffect(() => {
    api.sitesSummary().then((data) => {
      setSites(data);
      if (data.length > 0) setSelected(data[0]);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.series("site", selected.id, 60).then(setSeries);
  }, [selected]);

  const sorted = useMemo(() => {
    const copy = [...sites];
    copy.sort((a, b) => {
      const av = a[sortKey] ?? -Infinity;
      const bv = b[sortKey] ?? -Infinity;
      if (typeof av === "string") return sortDir * String(av).localeCompare(String(bv));
      return sortDir * ((av as number) - (bv as number));
    });
    return copy;
  }, [sites, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1) as 1 | -1);
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Sites — dernière semaine</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort("name")}>Site</th>
              <th onClick={() => toggleSort("continent")}>Continent</th>
              <th onClick={() => toggleSort("sessionsLast7d")}>Sessions (7j)</th>
              <th onClick={() => toggleSort("sessionsChangePct")}>Δ vs 7j préc.</th>
              <th onClick={() => toggleSort("conversionRateLast7d")}>Taux de conversion</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.id} onClick={() => setSelected(s)} style={{ fontWeight: s.id === selected?.id ? 600 : 400 }}>
                <td>{s.name}</td>
                <td>{s.continent}</td>
                <td>{formatCompactNumber(s.sessionsLast7d)}</td>
                <td className={s.sessionsChangePct !== null && s.sessionsChangePct < 0 ? "delta-down" : "delta-up"}>
                  {formatPct(s.sessionsChangePct)}
                </td>
                <td>{(s.conversionRateLast7d * 100).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <>
          <div className="card">
            <h2>Trafic — {selected.name} (60 derniers jours)</h2>
            <TrendChart data={series} lines={[{ dataKey: "sessions", label: "Sessions", color: "var(--series-1)" }]} />
          </div>
          <div className="card">
            <h2>Taux de conversion — {selected.name}</h2>
            <TrendChart
              data={series.map((d) => ({ ...d, conversionRatePct: d.conversionRate * 100 }))}
              lines={[{ dataKey: "conversionRatePct", label: "Taux de conversion (%)", color: "var(--series-6)" }]}
              valueFormatter={(n) => `${n.toFixed(1)}%`}
            />
          </div>
          <div className="card">
            <h2>Canaux d'acquisition — {selected.name}</h2>
            <ChannelMixChart data={series} />
          </div>
        </>
      )}
    </div>
  );
}
