import { useEffect, useState } from "react";
import { api, type RegionSummary, type DayPoint } from "../lib/api";
import { RegionBarChart } from "../components/RegionBarChart";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { formatCompactNumber, formatPct } from "../lib/format";
import { usePeriod, periodComparisonLabel } from "../lib/periodContext";

export function Regions() {
  const { days } = usePeriod();
  const [regions, setRegions] = useState<RegionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [series, setSeries] = useState<DayPoint[]>([]);

  useEffect(() => {
    api.regions(days).then((data) => {
      setRegions(data);
      setSelected((current) => (current && data.some((r) => r.region === current) ? current : data[0]?.region ?? null));
    });
  }, [days]);

  useEffect(() => {
    if (!selected) return;
    api.series("region", selected, 60).then(setSeries);
  }, [selected]);

  return (
    <div>
      <div className="card">
        <h2>Sessions par région business ({days} derniers jours)</h2>
        <RegionBarChart data={regions} />
      </div>

      <div className="card">
        <h2>Détail par région business</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Région</th>
              <th>Sites</th>
              <th>Sessions ({days}j)</th>
              <th>Δ {periodComparisonLabel(days)}</th>
              <th>Conversions ({days}j)</th>
              <th>Taux de conversion</th>
              <th title={`Jours de pic trafic anormal exclus du calcul ci-dessus, sur les ${days} derniers jours`}>Anomalies</th>
            </tr>
          </thead>
          <tbody>
            {regions.map((r) => (
              <tr key={r.region} onClick={() => setSelected(r.region)} style={{ fontWeight: r.region === selected ? 600 : 400 }}>
                <td>{r.region}</td>
                <td>{r.siteCount}</td>
                <td>{formatCompactNumber(r.sessionsLast7d)}</td>
                <td className={r.sessionsChangePct !== null && r.sessionsChangePct < 0 ? "delta-down" : "delta-up"}>
                  {formatPct(r.sessionsChangePct)}
                </td>
                <td>{formatCompactNumber(r.conversionsLast7d)}</td>
                <td>{(r.conversionRateLast7d * 100).toFixed(2)}%</td>
                <td>{r.excludedAnomalyDays > 0 ? `${r.excludedAnomalyDays} exclu(s)` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <>
          <div className="card">
            <h2>Trafic — {selected} (60 derniers jours)</h2>
            <p className="chart-note">Point rouge = pic de trafic anormal détecté sur un des sites de cette région (exclu des KPIs ci-dessus).</p>
            <TrendChart data={series} lines={[{ dataKey: "sessions", label: "Sessions", color: "var(--series-1)" }]} markAnomalies />
          </div>
          <div className="card">
            <h2>Canaux d'acquisition — {selected}</h2>
            <ChannelMixChart data={series} />
          </div>
        </>
      )}
    </div>
  );
}
