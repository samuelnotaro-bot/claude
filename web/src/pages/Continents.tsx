import { useEffect, useState } from "react";
import { api, type ContinentSummary, type DayPoint } from "../lib/api";
import { ContinentBarChart } from "../components/ContinentBarChart";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { formatCompactNumber, formatPct } from "../lib/format";

export function Continents() {
  const [continents, setContinents] = useState<ContinentSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [series, setSeries] = useState<DayPoint[]>([]);

  useEffect(() => {
    api.continents().then((data) => {
      setContinents(data);
      if (data.length > 0) setSelected(data[0].continent);
    });
  }, []);

  useEffect(() => {
    if (!selected) return;
    api.series("continent", selected, 60).then(setSeries);
  }, [selected]);

  return (
    <div>
      <div className="card">
        <h2>Sessions par continent (7 derniers jours)</h2>
        <ContinentBarChart data={continents} />
      </div>

      <div className="card">
        <h2>Détail par continent</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Continent</th>
              <th>Sites</th>
              <th>Sessions (7j)</th>
              <th>Δ vs 7j préc.</th>
              <th>Conversions (7j)</th>
              <th>Taux de conversion</th>
              <th title="Jours de pic trafic anormal exclus du calcul ci-dessus, sur les 30 derniers jours">Anomalies</th>
            </tr>
          </thead>
          <tbody>
            {continents.map((c) => (
              <tr key={c.continent} onClick={() => setSelected(c.continent)} style={{ fontWeight: c.continent === selected ? 600 : 400 }}>
                <td>{c.continent}</td>
                <td>{c.siteCount}</td>
                <td>{formatCompactNumber(c.sessionsLast7d)}</td>
                <td className={c.sessionsChangePct !== null && c.sessionsChangePct < 0 ? "delta-down" : "delta-up"}>
                  {formatPct(c.sessionsChangePct)}
                </td>
                <td>{formatCompactNumber(c.conversionsLast7d)}</td>
                <td>{(c.conversionRateLast7d * 100).toFixed(2)}%</td>
                <td>{c.excludedAnomalyDays > 0 ? `${c.excludedAnomalyDays} exclu(s)` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <>
          <div className="card">
            <h2>Trafic — {selected} (60 derniers jours)</h2>
            <p className="chart-note">Point rouge = pic de trafic anormal détecté sur un des sites de ce continent (exclu des KPIs ci-dessus).</p>
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
