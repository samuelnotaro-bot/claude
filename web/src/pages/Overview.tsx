import { useEffect, useState } from "react";
import { api, type Overview as OverviewData, type Finding, type Synthesis } from "../lib/api";
import { KpiTile } from "../components/KpiTile";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { SynthesisPanel } from "../components/SynthesisPanel";
import { FindingsList } from "../components/FindingsList";
import { formatCompactNumber } from "../lib/format";
import { usePeriod, periodComparisonLabel } from "../lib/periodContext";

const ANOMALY_TOOLTIP =
  "Seuls les pics de trafic statistiquement extrêmes sont exclus de ce calcul. Pour une fiabilité complète, vérifiez le filtre anti-bot dans Piwik Pro > Administration > Confidentialité.";

function anomalyNote(days: number): string {
  return `${days} jour${days > 1 ? "s" : ""} de pic trafic exclu${days > 1 ? "s" : ""} sur la période`;
}

export function Overview() {
  const { queryParams, compare, from, to } = usePeriod();
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [synthesis, setSynthesis] = useState<Synthesis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    Promise.all([api.overview(queryParams), api.findings(8), api.latestSynthesis()])
      .then(([o, f, s]) => {
        setOverview(o);
        setFindings(f.filter((x) => x.scope === "global"));
        setSynthesis(s);
      })
      .catch((e) => setError(String(e)));
  }, [queryParams]);

  if (error) return <p className="empty-state">Erreur de chargement : {error}. Le serveur API tourne-t-il sur le bon port ?</p>;
  if (!overview) return <p className="empty-state">Chargement…</p>;

  const deltaLabel = periodComparisonLabel(compare);
  const periodLabel = from === to ? from : `${from} → ${to}`;

  return (
    <div>
      <p className="chart-note">Période affichée : {periodLabel} — {deltaLabel}</p>

      <h3 className="section-title">Trafic & conversion</h3>
      <div className="kpi-grid">
        <KpiTile
          label="Sessions"
          value={formatCompactNumber(overview.sessions)}
          deltaPct={overview.sessionsChangePct}
          deltaLabel={deltaLabel}
          note={overview.excludedAnomalyDays > 0 ? anomalyNote(overview.excludedAnomalyDays) : undefined}
          noteTooltip={ANOMALY_TOOLTIP}
        />
        <KpiTile label="Taux de conversion global" value={`${(overview.conversionRate * 100).toFixed(2)}%`} deltaPct={overview.conversionRateChangePct} deltaLabel={deltaLabel} />
        <KpiTile label="Demandes de devis" value={formatCompactNumber(overview.rfq)} deltaPct={overview.rfqChangePct} deltaLabel={deltaLabel} />
        <KpiTile label="Demandes de support" value={formatCompactNumber(overview.support)} deltaPct={overview.supportChangePct} deltaLabel={deltaLabel} />
        <KpiTile label="Téléchargements" value={formatCompactNumber(overview.downloads)} deltaPct={overview.downloadsChangePct} deltaLabel={deltaLabel} />
      </div>

      <h3 className="section-title">SEO / GEO</h3>
      <div className="kpi-grid">
        <KpiTile label="Trafic organique (SEO)" value={formatCompactNumber(overview.organicSessions)} deltaPct={overview.organicSessionsChangePct} deltaLabel={deltaLabel} />
        <KpiTile label="Trafic référé par IA" value={formatCompactNumber(overview.aiReferralSessions)} deltaPct={overview.aiReferralSessionsChangePct} deltaLabel={deltaLabel} />
        <KpiTile
          label="Clics Search Console"
          value={formatCompactNumber(overview.searchConsoleClicks)}
          deltaPct={overview.searchConsoleClicksChangePct}
          deltaLabel={deltaLabel}
          note={overview.searchConsoleClicks === 0 ? "Intégration Search Console non configurée sur les sites suivis (Piwik Pro > Réglages > Intégrations)" : undefined}
        />
        <KpiTile label="Impressions Search Console" value={formatCompactNumber(overview.searchConsoleImpressions)} deltaPct={null} deltaLabel="" />
      </div>

      <h3 className="section-title">Signal bot</h3>
      <div className="kpi-grid">
        <KpiTile
          label="Trafic à faible engagement (organique/direct)"
          value={`${(overview.lowEngagementShare * 100).toFixed(1)}%`}
          deltaPct={overview.lowEngagementShareChangePct}
          deltaIsGoodWhenUp={false}
          deltaLabel={deltaLabel}
          note="Sessions rebond (1 page) sur les canaux organique/direct -- proxy de trafic non-humain. Détail dans l'onglet Bots."
        />
      </div>

      <div className="grid-2">
        <div>
          <div className="card">
            <h2>Trafic global — {overview.series.length} jours</h2>
            <TrendChart data={overview.series} lines={[{ dataKey: "sessions", label: "Sessions", color: "var(--series-1)" }]} />
          </div>
          <div className="card">
            <h2>Répartition des canaux d'acquisition (tous sites)</h2>
            <ChannelMixChart data={overview.series} />
          </div>
        </div>
        <div>
          <div className="card">
            <h2>Synthèse hebdomadaire — plan d'action</h2>
            <SynthesisPanel synthesis={synthesis} />
          </div>
          <div className="card">
            <h2>Tendances les plus significatives — analyse & plan d'action</h2>
            <FindingsList findings={findings} />
          </div>
        </div>
      </div>
    </div>
  );
}
