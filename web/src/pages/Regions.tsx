import { useEffect, useState } from "react";
import { api, type RegionSummary, type DayPoint } from "../lib/api";
import { RegionBarChart } from "../components/RegionBarChart";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { KpiTile } from "../components/KpiTile";
import { FindingsList } from "../components/FindingsList";
import { formatCompactNumber, formatCompactNumberOrNA, formatPct, formatPctOrNA } from "../lib/format";
import { usePeriod, periodComparisonLabel } from "../lib/periodContext";

export function Regions() {
  const { queryParams, compare } = usePeriod();
  const [regions, setRegions] = useState<RegionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [series, setSeries] = useState<DayPoint[]>([]);

  useEffect(() => {
    api.regions(queryParams).then((data) => {
      setRegions(data);
      setSelected((current) => (current && data.some((r) => r.region === current) ? current : data[0]?.region ?? null));
    });
  }, [queryParams]);

  useEffect(() => {
    if (!selected) return;
    api.series("region", selected, queryParams).then(setSeries);
  }, [selected, queryParams]);

  const deltaLabel = periodComparisonLabel(compare);
  const selectedRegion = regions.find((r) => r.region === selected) ?? null;

  return (
    <div>
      <div className="card">
        <h2>Sessions par région business</h2>
        <RegionBarChart data={regions} />
      </div>

      <div className="card">
        <h2>Détail par région business</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th>Région</th>
              <th>Sites</th>
              <th>Sessions</th>
              <th>Δ {deltaLabel}</th>
              <th>Conversions</th>
              <th>Taux de conversion</th>
              <th title="Jours de pic trafic anormal exclus du calcul ci-dessus">Anomalies</th>
            </tr>
          </thead>
          <tbody>
            {regions.map((r) => (
              <tr key={r.region} onClick={() => setSelected(r.region)} style={{ fontWeight: r.region === selected ? 600 : 400 }}>
                <td>{r.region}</td>
                <td>{r.siteCount}</td>
                <td>{formatCompactNumber(r.sessions)}</td>
                <td className={r.sessionsChangePct !== null && r.sessionsChangePct < 0 ? "delta-down" : "delta-up"}>
                  {formatPct(r.sessionsChangePct)}
                </td>
                <td>{formatCompactNumber(r.conversions)}</td>
                <td>{(r.conversionRate * 100).toFixed(2)}%</td>
                <td>{r.excludedAnomalyDays > 0 ? `${r.excludedAnomalyDays} exclu(s)` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedRegion && (
        <>
          <h3 className="section-title">SEO/GEO, signal bot & conversion — {selectedRegion.region}</h3>
          <div className="kpi-grid">
            <KpiTile label="Trafic organique (SEO)" value={formatCompactNumber(selectedRegion.organicSessions)} deltaPct={selectedRegion.organicSessionsChangePct} deltaLabel={deltaLabel} />
            <KpiTile label="Trafic référé par IA" value={formatCompactNumberOrNA(selectedRegion.aiReferralSessions)} deltaPct={selectedRegion.aiReferralSessionsChangePct} deltaLabel={deltaLabel} />
            <KpiTile label="Clics Search Console" value={formatCompactNumberOrNA(selectedRegion.searchConsoleClicks)} deltaPct={selectedRegion.searchConsoleClicksChangePct} deltaLabel={deltaLabel} />
            <KpiTile
              label="Trafic à faible engagement (signal bot)"
              value={formatPctOrNA(selectedRegion.lowEngagementShare)}
              deltaPct={selectedRegion.lowEngagementShareChangePct}
              deltaIsGoodWhenUp={false}
              deltaLabel={deltaLabel}
            />
            <KpiTile label="Demandes de devis" value={formatCompactNumber(selectedRegion.rfq)} deltaPct={selectedRegion.rfqChangePct} deltaLabel={deltaLabel} />
            <KpiTile label="Demandes de support" value={formatCompactNumber(selectedRegion.support)} deltaPct={selectedRegion.supportChangePct} deltaLabel={deltaLabel} />
            <KpiTile label="Téléchargements" value={formatCompactNumber(selectedRegion.downloads)} deltaPct={selectedRegion.downloadsChangePct} deltaLabel={deltaLabel} />
          </div>

          <div className="card">
            <h2>Trafic — {selected}</h2>
            <p className="chart-note">Point rouge = pic de trafic anormal détecté sur un des sites de cette région (exclu des KPIs ci-dessus).</p>
            <TrendChart data={series} lines={[{ dataKey: "sessions", label: "Sessions", color: "var(--series-1)" }]} markAnomalies />
          </div>
          <div className="card">
            <h2>Canaux d'acquisition — {selected}</h2>
            <ChannelMixChart data={series} />
          </div>
          <div className="card">
            <h2>Analyse & plan d'action — {selected}</h2>
            <FindingsList findings={selectedRegion.findings} />
          </div>
        </>
      )}
    </div>
  );
}
