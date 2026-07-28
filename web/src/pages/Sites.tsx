import { useEffect, useMemo, useState } from "react";
import { api, type SiteSummary, type DayPoint, type Finding } from "../lib/api";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { KpiTile } from "../components/KpiTile";
import { FindingsList } from "../components/FindingsList";
import { formatCompactNumber, formatPct } from "../lib/format";
import { usePeriod, periodComparisonLabel } from "../lib/periodContext";

type SortKey = "name" | "region" | "sessions" | "sessionsChangePct" | "conversionRate";

export function Sites() {
  const { queryParams, compare } = usePeriod();
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [selected, setSelected] = useState<SiteSummary | null>(null);
  const [series, setSeries] = useState<DayPoint[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("sessions");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  useEffect(() => {
    api.sitesSummary(queryParams).then((data) => {
      setSites(data);
      setSelected((current) => (current && data.find((s) => s.id === current.id)) || data[0] || null);
    });
    api.findings(200).then(setFindings);
  }, [queryParams]);

  useEffect(() => {
    if (!selected) return;
    api.series("site", selected.id, queryParams).then(setSeries);
  }, [selected, queryParams]);

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

  const deltaLabel = periodComparisonLabel(compare);
  const siteFindings = findings.filter((f) => f.entityId === selected?.id);

  return (
    <div>
      <div className="card">
        <h2>Sites</h2>
        <table className="data-table">
          <thead>
            <tr>
              <th onClick={() => toggleSort("name")}>Site</th>
              <th onClick={() => toggleSort("region")}>Région</th>
              <th onClick={() => toggleSort("sessions")}>Sessions</th>
              <th onClick={() => toggleSort("sessionsChangePct")}>Δ {deltaLabel}</th>
              <th onClick={() => toggleSort("conversionRate")}>Taux de conversion</th>
              <th title="Jours de pic trafic anormal exclus du calcul ci-dessus">Anomalies</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <tr key={s.id} onClick={() => setSelected(s)} style={{ fontWeight: s.id === selected?.id ? 600 : 400 }}>
                <td>{s.name}</td>
                <td>{s.region}</td>
                <td>{formatCompactNumber(s.sessions)}</td>
                <td className={s.sessionsChangePct !== null && s.sessionsChangePct < 0 ? "delta-down" : "delta-up"}>
                  {formatPct(s.sessionsChangePct)}
                </td>
                <td>{(s.conversionRate * 100).toFixed(2)}%</td>
                <td>{s.excludedAnomalyDays > 0 ? `${s.excludedAnomalyDays} exclu(s)` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <>
          <h3 className="section-title">SEO/GEO, signal bot & conversion — {selected.name}</h3>
          <div className="kpi-grid">
            <KpiTile label="Trafic organique (SEO)" value={formatCompactNumber(selected.organicSessions)} deltaPct={selected.organicSessionsChangePct} deltaLabel={deltaLabel} />
            <KpiTile label="Trafic référé par IA" value={formatCompactNumber(selected.aiReferralSessions)} deltaPct={selected.aiReferralSessionsChangePct} deltaLabel={deltaLabel} />
            <KpiTile label="Clics Search Console" value={formatCompactNumber(selected.searchConsoleClicks)} deltaPct={selected.searchConsoleClicksChangePct} deltaLabel={deltaLabel} />
            <KpiTile
              label="Trafic à faible engagement (signal bot)"
              value={`${(selected.lowEngagementShare * 100).toFixed(1)}%`}
              deltaPct={selected.lowEngagementShareChangePct}
              deltaIsGoodWhenUp={false}
              deltaLabel={deltaLabel}
            />
            <KpiTile label="Demandes de devis" value={formatCompactNumber(selected.rfq)} deltaPct={selected.rfqChangePct} deltaLabel={deltaLabel} />
            <KpiTile label="Demandes de support" value={formatCompactNumber(selected.support)} deltaPct={selected.supportChangePct} deltaLabel={deltaLabel} />
            <KpiTile label="Téléchargements" value={formatCompactNumber(selected.downloads)} deltaPct={selected.downloadsChangePct} deltaLabel={deltaLabel} />
          </div>

          <div className="card">
            <h2>Trafic — {selected.name}</h2>
            <p className="chart-note">Point rouge = pic de trafic anormal détecté (exclu des KPIs ci-dessus, visible ici pour analyse).</p>
            <TrendChart data={series} lines={[{ dataKey: "sessions", label: "Sessions", color: "var(--series-1)" }]} markAnomalies />
          </div>
          <div className="card">
            <h2>Taux de conversion — {selected.name}</h2>
            <TrendChart
              data={series.map((d) => ({ ...d, conversionRatePct: (d.conversionRate as number) * 100 }))}
              lines={[{ dataKey: "conversionRatePct", label: "Taux de conversion (%)", color: "var(--series-6)" }]}
              valueFormatter={(n) => `${n.toFixed(1)}%`}
            />
          </div>
          <div className="card">
            <h2>Canaux d'acquisition — {selected.name}</h2>
            <ChannelMixChart data={series} />
          </div>
          <div className="card">
            <h2>Analyse & plan d'action — {selected.name}</h2>
            <FindingsList findings={siteFindings} />
          </div>
        </>
      )}
    </div>
  );
}
