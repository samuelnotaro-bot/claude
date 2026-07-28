import { useEffect, useMemo, useState } from "react";
import { api, type SiteSummary, type DayPoint } from "../lib/api";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { KpiTile } from "../components/KpiTile";
import { FindingsList } from "../components/FindingsList";
import { formatCompactNumber, formatCompactNumberOrNA, formatPct, formatPctOrNA, dataQualityNote } from "../lib/format";
import { usePeriod, periodComparisonLabel } from "../lib/periodContext";

type SortKey =
  | "name"
  | "region"
  | "sessions"
  | "sessionsChangePct"
  | "organicSessions"
  | "aiReferralSessions"
  | "searchConsoleClicks"
  | "lowEngagementShare"
  | "rfq"
  | "support"
  | "downloads"
  | "conversionRate";

const ANOMALY_HEADER_TITLE =
  "Jours où un pic de trafic anormal (signature de bot -- voir l'onglet Bots) a été détecté sur ce site et exclu des totaux de cette ligne.";
const MISSING_HEADER_TITLE =
  "Jours sans synchronisation Piwik Pro pour ce site sur la période sélectionnée -- les totaux de cette ligne sous-estiment les vrais chiffres Piwik Pro d'autant.";

export function Sites() {
  const { queryParams, compare } = usePeriod();
  const [sites, setSites] = useState<SiteSummary[]>([]);
  const [selected, setSelected] = useState<SiteSummary | null>(null);
  const [series, setSeries] = useState<DayPoint[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>("sessions");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  useEffect(() => {
    api.sitesSummary(queryParams).then((data) => {
      setSites(data);
      setSelected((current) => (current && data.find((s) => s.id === current.id)) || data[0] || null);
    });
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

  return (
    <div>
      <div className="card">
        <h2>Sites</h2>
        <p className="chart-note">
          Cliquez une ligne pour le détail. "Trafic IA" et "Signal bot" sont des estimations (pas des métriques natives Piwik
          Pro) -- voir la section détaillée sous le tableau pour l'explication complète de chaque colonne.
        </p>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th onClick={() => toggleSort("name")}>Site</th>
                <th onClick={() => toggleSort("region")}>Région</th>
                <th onClick={() => toggleSort("sessions")}>Sessions</th>
                <th onClick={() => toggleSort("sessionsChangePct")}>Δ {deltaLabel}</th>
                <th onClick={() => toggleSort("organicSessions")}>Trafic organique</th>
                <th onClick={() => toggleSort("aiReferralSessions")} title="Estimation -- reclassement par domaine référent connu, pas une métrique native Piwik Pro.">
                  Trafic IA
                </th>
                <th onClick={() => toggleSort("searchConsoleClicks")}>Clics Search Console</th>
                <th onClick={() => toggleSort("lowEngagementShare")} title="Estimation -- sessions rebond organique/direct, proxy de trafic non-humain. Détail dans l'onglet Bots.">
                  Signal bot
                </th>
                <th onClick={() => toggleSort("rfq")}>Devis</th>
                <th onClick={() => toggleSort("support")}>Support</th>
                <th onClick={() => toggleSort("downloads")}>Téléchargements</th>
                <th onClick={() => toggleSort("conversionRate")}>Taux de conversion</th>
                <th title={ANOMALY_HEADER_TITLE}>Pics exclus</th>
                <th title={MISSING_HEADER_TITLE}>Données manquantes</th>
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
                  <td>{formatCompactNumber(s.organicSessions)}</td>
                  <td>{formatCompactNumberOrNA(s.aiReferralSessions)}</td>
                  <td>{formatCompactNumberOrNA(s.searchConsoleClicks)}</td>
                  <td>{formatPctOrNA(s.lowEngagementShare)}</td>
                  <td>{formatCompactNumber(s.rfq)}</td>
                  <td>{formatCompactNumber(s.support)}</td>
                  <td>{formatCompactNumber(s.downloads)}</td>
                  <td>{(s.conversionRate * 100).toFixed(2)}%</td>
                  <td title={ANOMALY_HEADER_TITLE}>{s.excludedAnomalyDays > 0 ? s.excludedAnomalyDays : "—"}</td>
                  <td title={MISSING_HEADER_TITLE}>{s.missingDays > 0 ? s.missingDays : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <>
          <h3 className="section-title">Détail & tendances — {selected.name}</h3>
          {(() => {
            const note = dataQualityNote(selected.excludedAnomalyDays, selected.missingDays);
            return note ? <p className="data-quality-banner">⚠ {note}, sur les chiffres de {selected.name} ci-dessus.</p> : null;
          })()}
          <div className="kpi-grid">
            <KpiTile label="Trafic organique (SEO)" value={formatCompactNumber(selected.organicSessions)} deltaPct={selected.organicSessionsChangePct} deltaLabel={deltaLabel} />
            <KpiTile
              label="Trafic référé par IA (estimation)"
              value={formatCompactNumberOrNA(selected.aiReferralSessions)}
              deltaPct={selected.aiReferralSessionsChangePct}
              deltaLabel={deltaLabel}
              note="Pas une métrique native Piwik Pro : reclassement par domaine référent connu."
            />
            <KpiTile label="Clics Search Console" value={formatCompactNumberOrNA(selected.searchConsoleClicks)} deltaPct={selected.searchConsoleClicksChangePct} deltaLabel={deltaLabel} />
            <KpiTile
              label="Trafic à faible engagement (estimation signal bot)"
              value={formatPctOrNA(selected.lowEngagementShare)}
              deltaPct={selected.lowEngagementShareChangePct}
              deltaIsGoodWhenUp={false}
              deltaLabel={deltaLabel}
              note="Pas une métrique native Piwik Pro : sessions rebond sur organique/direct."
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
            <FindingsList findings={selected.findings} />
          </div>
        </>
      )}
    </div>
  );
}
