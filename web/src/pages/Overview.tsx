import { useEffect, useState } from "react";
import { api, type Overview as OverviewData } from "../lib/api";
import { KpiTile } from "../components/KpiTile";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { FindingsList } from "../components/FindingsList";
import { formatCompactNumber, formatCompactNumberOrNA, formatPctOrNA } from "../lib/format";
import { usePeriod, periodComparisonLabel } from "../lib/periodContext";

const ANOMALY_TOOLTIP =
  "Seuls les pics de trafic statistiquement extrêmes sont exclus de ce calcul. Pour une fiabilité complète, vérifiez le filtre anti-bot dans Piwik Pro > Administration > Confidentialité.";

function anomalyNote(days: number): string {
  return `${days} jour${days > 1 ? "s" : ""} de pic trafic exclu${days > 1 ? "s" : ""} sur la période`;
}

export function Overview() {
  const { queryParams, compare, from, to } = usePeriod();
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fillingGaps, setFillingGaps] = useState(false);
  const [gapMessage, setGapMessage] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api
      .overview(queryParams)
      .then(setOverview)
      .catch((e) => setError(String(e)));
  }, [queryParams]);

  async function handleFillGaps() {
    setFillingGaps(true);
    setGapMessage(null);
    try {
      const result = await api.fillGaps();
      const parts: string[] = [];
      if (result.daysFilled === 0 && result.daysFailed === 0) {
        parts.push("Aucun trou détecté dans l'historique.");
      } else {
        if (result.daysFilled > 0) parts.push(`${result.daysFilled} jour(s) comblé(s)`);
        if (result.daysFailed > 0) parts.push(`${result.daysFailed} échec(s) Piwik Pro (relancez pour réessayer)`);
        if (result.daysRemaining > 0) parts.push(`${result.daysRemaining} pas encore tenté(s), relancez`);
      }
      setGapMessage(parts.join(" · ") + ".");
      api.overview(queryParams).then(setOverview);
    } catch (e) {
      setGapMessage(`Échec : ${String(e)}`);
    } finally {
      setFillingGaps(false);
    }
  }

  if (error) return <p className="empty-state">Erreur de chargement : {error}. Le serveur API tourne-t-il sur le bon port ?</p>;
  if (!overview) return <p className="empty-state">Chargement…</p>;

  const deltaLabel = periodComparisonLabel(compare);
  const periodLabel = from === to ? from : `${from} → ${to}`;

  return (
    <div>
      <div className="period-banner">
        <p className="chart-note" style={{ margin: 0 }}>
          Période affichée : {periodLabel} — {deltaLabel}
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {gapMessage && <span className="chart-note" style={{ margin: 0 }}>{gapMessage}</span>}
          <button className="secondary-btn" onClick={handleFillGaps} disabled={fillingGaps}>
            {fillingGaps ? "Vérification…" : "Combler les trous de données"}
          </button>
        </div>
      </div>

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
        <KpiTile
          label="Trafic référé par IA"
          value={formatCompactNumberOrNA(overview.aiReferralSessions)}
          deltaPct={overview.aiReferralSessionsChangePct}
          deltaLabel={deltaLabel}
          note={overview.aiReferralSessions === null ? "Requête Piwik Pro échouée -- voir /api/diagnostics/optional-metrics" : undefined}
        />
        <KpiTile
          label="Clics Search Console"
          value={formatCompactNumberOrNA(overview.searchConsoleClicks)}
          deltaPct={overview.searchConsoleClicksChangePct}
          deltaLabel={deltaLabel}
          note={overview.searchConsoleClicks === null ? "Intégration Search Console non configurée (Piwik Pro > Réglages > Intégrations) ou requête échouée -- voir /api/diagnostics/optional-metrics" : undefined}
        />
        <KpiTile label="Impressions Search Console" value={formatCompactNumberOrNA(overview.searchConsoleImpressions)} deltaPct={null} deltaLabel="" />
      </div>

      <h3 className="section-title">Signal bot</h3>
      <div className="kpi-grid">
        <KpiTile
          label="Trafic à faible engagement (organique/direct)"
          value={formatPctOrNA(overview.lowEngagementShare)}
          deltaPct={overview.lowEngagementShareChangePct}
          deltaIsGoodWhenUp={false}
          deltaLabel={deltaLabel}
          note={
            overview.lowEngagementShare === null
              ? "Requête Piwik Pro échouée -- voir /api/diagnostics/optional-metrics"
              : "Sessions rebond (1 page) sur les canaux organique/direct -- proxy de trafic non-humain. Détail dans l'onglet Bots."
          }
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
            <h2>Synthèse — plan d'action</h2>
            {overview.synthesisBullets.length === 0 ? (
              <p className="empty-state">Pas assez d'historique pour synthétiser cette période.</p>
            ) : (
              <ul className="bullet-list">
                {overview.synthesisBullets.map((b, i) => (
                  <li key={i}>
                    <span className="dot" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="card">
            <h2>Tendances les plus significatives — analyse & plan d'action</h2>
            <FindingsList findings={overview.findings} />
          </div>
        </div>
      </div>
    </div>
  );
}
