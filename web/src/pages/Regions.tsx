import { useEffect, useState } from "react";
import { api, type RegionSummary, type DayPoint } from "../lib/api";
import { RegionBarChart } from "../components/RegionBarChart";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { KpiTile } from "../components/KpiTile";
import { FindingsList } from "../components/FindingsList";
import { formatCompactNumber, formatCompactNumberOrNA, formatPct, formatPctOrNA, dataQualityNote, anomalyInclusionNote } from "../lib/format";
import { usePeriod, periodComparisonLabel } from "../lib/periodContext";
import { DataOutageBanner } from "../components/DataOutageBanner";
import { HeroBanner } from "../components/HeroBanner";

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
      <HeroBanner image="/lundicatastrophe.png" caption="Performance par région" />
      <div className="card">
        <h2>Sessions par région business</h2>
        <RegionBarChart data={regions} />
      </div>

      <div className="card">
        <h2>Détail par région business</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Région</th>
                <th>Sites</th>
                <th>Sessions</th>
                <th>Δ {deltaLabel}</th>
                <th>Conversions</th>
                <th>Taux de conversion</th>
                <th title="Jours où un pic de trafic (>35% au-dessus de la moyenne -- voir l'onglet Bots) a été détecté sur un des sites de cette région. Inclus dans les totaux de cette ligne, pas exclu.">
                  Pics détectés
                </th>
                <th title="Jours sans synchronisation Piwik Pro pour un des sites de cette région sur la période -- les totaux de cette ligne sous-estiment les vrais chiffres Piwik Pro d'autant.">
                  Données manquantes
                </th>
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
                  <td>{r.flaggedAnomalyDays > 0 ? r.flaggedAnomalyDays : "—"}</td>
                  <td>{r.missingDays > 0 ? r.missingDays : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedRegion && (
        <>
          <h3 className="section-title">SEO/GEO, signal bot & conversion — {selectedRegion.region}</h3>
          <DataOutageBanner outages={selectedRegion.dataOutages} />
          {(() => {
            const note = dataQualityNote(selectedRegion.missingDays, selectedRegion.missingDaysOutOfRetention);
            return note ? <p className="data-quality-banner">⚠ {note}, sur les chiffres de {selectedRegion.region} ci-dessous.</p> : null;
          })()}
          {(() => {
            const note = anomalyInclusionNote(selectedRegion.flaggedAnomalyDays);
            return note ? <p className="chart-note">ℹ {note}.</p> : null;
          })()}
          <div className="kpi-grid">
            <KpiTile label="Trafic organique (SEO)" value={formatCompactNumber(selectedRegion.organicSessions)} deltaPct={selectedRegion.organicSessionsChangePct} deltaLabel={deltaLabel} />
            <KpiTile
              label="Trafic référé par IA (estimation)"
              value={formatCompactNumberOrNA(selectedRegion.aiReferralSessions)}
              deltaPct={selectedRegion.aiReferralSessionsChangePct}
              deltaLabel={deltaLabel}
              note="Pas une métrique native Piwik Pro : reclassement par domaine référent connu."
            />
            <KpiTile label="Clics Search Console" value={formatCompactNumberOrNA(selectedRegion.searchConsoleClicks)} deltaPct={selectedRegion.searchConsoleClicksChangePct} deltaLabel={deltaLabel} />
            <KpiTile
              label="Trafic à faible engagement (estimation signal bot)"
              value={formatPctOrNA(selectedRegion.lowEngagementShare)}
              deltaPct={selectedRegion.lowEngagementShareChangePct}
              deltaIsGoodWhenUp={false}
              deltaLabel={deltaLabel}
              note="Pas une métrique native Piwik Pro : sessions rebond sur organique/direct."
            />
            <KpiTile label="Demandes de devis" value={formatCompactNumber(selectedRegion.rfq)} deltaPct={selectedRegion.rfqChangePct} deltaLabel={deltaLabel} />
            <KpiTile label="Demandes de support" value={formatCompactNumber(selectedRegion.support)} deltaPct={selectedRegion.supportChangePct} deltaLabel={deltaLabel} />
            <KpiTile label="Téléchargements" value={formatCompactNumber(selectedRegion.downloads)} deltaPct={selectedRegion.downloadsChangePct} deltaLabel={deltaLabel} />
          </div>

          <div className="card">
            <h2>Trafic — {selected}</h2>
            <p className="chart-note">Point rouge = pic de trafic (&gt;35% au-dessus de la moyenne de la période) détecté sur la région dans son ensemble -- inclus dans les KPIs ci-dessus, pas exclu.</p>
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
