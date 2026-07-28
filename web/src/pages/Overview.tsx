import { useEffect, useState } from "react";
import { api, type Overview as OverviewData } from "../lib/api";
import { KpiTile } from "../components/KpiTile";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { FindingsList } from "../components/FindingsList";
import { formatCompactNumber, formatCompactNumberOrNA, formatPctOrNA, dataQualityNote, anomalyInclusionNote } from "../lib/format";
import { usePeriod, periodComparisonLabel } from "../lib/periodContext";
import { HistoryWarningBanner } from "../components/HistoryWarningBanner";
import { DataOutageBanner } from "../components/DataOutageBanner";
import { HeroBanner } from "../components/HeroBanner";

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
      if (result.daysFilled === 0 && result.daysFailed === 0 && result.daysOutOfRetention === 0) {
        parts.push("Aucun trou détecté dans l'historique.");
      } else {
        if (result.daysFilled > 0) parts.push(`${result.daysFilled} jour(s) comblé(s)`);
        if (result.daysFailed > 0) parts.push(`${result.daysFailed} échec(s) Piwik Pro (relancez pour réessayer)`);
        if (result.daysRemaining > 0) parts.push(`${result.daysRemaining} pas encore tenté(s), relancez`);
        if (result.daysOutOfRetention > 0)
          parts.push(`${result.daysOutOfRetention} jour(s) hors de la période de rétention Piwik Pro -- ne seront jamais disponibles`);
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
  const qualityNote = dataQualityNote(overview.missingDays, overview.missingDaysOutOfRetention);
  const anomalyNote = anomalyInclusionNote(overview.flaggedAnomalyDays);

  return (
    <div>
      <HeroBanner image="/coeurs.png" />
      <div className="period-banner">
        <p className="chart-note" style={{ margin: 0 }}>
          Période affichée : {periodLabel} — {deltaLabel}
        </p>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {gapMessage && <span className="chart-note" style={{ margin: 0 }}>{gapMessage}</span>}
            <button className="secondary-btn" onClick={handleFillGaps} disabled={fillingGaps} title="Interroge Piwik Pro en direct, au rythme autorisé par votre limite d'appels -- peut prendre 1 à 2 minutes.">
              {fillingGaps ? "Vérification… (jusqu'à 1-2 min)" : "Combler les trous de données"}
            </button>
          </div>
          <p className="chart-note" style={{ margin: 0, maxWidth: 420, textAlign: "right" }}>
            Utile car ce service peut se mettre en veille (plan gratuit) et manquer la synchro automatique quotidienne --
            ce bouton relance la récupération manuellement plutôt que d'attendre le prochain réveil.
          </p>
        </div>
      </div>

      <HistoryWarningBanner
        historyOk={overview.historyOk}
        retentionLimited={overview.retentionLimited}
        comparisonFrom={overview.comparisonFrom}
        earliestDataDate={overview.earliestDataDate}
        retentionFloorDate={overview.retentionFloorDate}
      />

      <DataOutageBanner outages={overview.dataOutages} />

      {qualityNote && <p className="data-quality-banner">⚠ {qualityNote}, sur tous les chiffres ci-dessous.</p>}
      {anomalyNote && <p className="chart-note">ℹ {anomalyNote}.</p>}

      <h3 className="section-title">Trafic & conversion</h3>
      <div className="kpi-grid">
        <KpiTile label="Sessions" value={formatCompactNumber(overview.sessions)} deltaPct={overview.sessionsChangePct} deltaLabel={deltaLabel} />
        <KpiTile label="Taux de conversion global" value={`${(overview.conversionRate * 100).toFixed(2)}%`} deltaPct={overview.conversionRateChangePct} deltaLabel={deltaLabel} />
        <KpiTile label="Demandes de devis" value={formatCompactNumber(overview.rfq)} deltaPct={overview.rfqChangePct} deltaLabel={deltaLabel} note="Sous-ensemble des conversions Piwik Pro classé par mot-clé dans le nom de l'objectif (devis/quote)." />
        <KpiTile label="Demandes de support" value={formatCompactNumber(overview.support)} deltaPct={overview.supportChangePct} deltaLabel={deltaLabel} note="Sous-ensemble des conversions Piwik Pro classé par mot-clé dans le nom de l'objectif (support)." />
        <KpiTile label="Téléchargements" value={formatCompactNumber(overview.downloads)} deltaPct={overview.downloadsChangePct} deltaLabel={deltaLabel} />
      </div>

      <h3 className="section-title">SEO / GEO</h3>
      <div className="kpi-grid">
        <KpiTile label="Trafic organique (SEO)" value={formatCompactNumber(overview.organicSessions)} deltaPct={overview.organicSessionsChangePct} deltaLabel={deltaLabel} />
        <KpiTile
          label="Trafic référé par IA (estimation)"
          value={formatCompactNumberOrNA(overview.aiReferralSessions)}
          deltaPct={overview.aiReferralSessionsChangePct}
          deltaLabel={deltaLabel}
          note={
            overview.aiReferralSessions === null
              ? "Requête Piwik Pro échouée -- voir /api/diagnostics/optional-metrics"
              : "Pas une métrique native Piwik Pro : reclassement des sessions dont le référent correspond à une liste connue d'assistants IA (aiReferrers.ts)."
          }
        />
        <KpiTile
          label="Clics Search Console"
          value={formatCompactNumberOrNA(overview.searchConsoleClicks)}
          deltaPct={overview.searchConsoleClicksChangePct}
          deltaLabel={deltaLabel}
          note={overview.searchConsoleClicks === null ? "Intégration Search Console non configurée (Piwik Pro > Réglages > Intégrations) ou requête échouée -- voir /api/diagnostics/optional-metrics" : "Donnée native de l'intégration Search Console de Piwik Pro."}
        />
        <KpiTile label="Impressions Search Console" value={formatCompactNumberOrNA(overview.searchConsoleImpressions)} deltaPct={null} deltaLabel="" />
      </div>

      <h3 className="section-title">Signal bot</h3>
      <div className="kpi-grid">
        <KpiTile
          label="Trafic à faible engagement (estimation signal bot)"
          value={formatPctOrNA(overview.lowEngagementShare)}
          deltaPct={overview.lowEngagementShareChangePct}
          deltaIsGoodWhenUp={false}
          deltaLabel={deltaLabel}
          note={
            overview.lowEngagementShare === null
              ? "Requête Piwik Pro échouée -- voir /api/diagnostics/optional-metrics"
              : "Pas une métrique native Piwik Pro : sessions rebond (1 page) sur organique/direct, proxy de trafic non-humain. Détail dans l'onglet Bots."
          }
        />
      </div>

      <div className="grid-2">
        <div>
          <div className="card">
            <h2>Trafic global — {overview.series.length} jours</h2>
            <p className="chart-note">Point rouge = pic de trafic (&gt;35% au-dessus de la moyenne de la période) détecté sur l'ensemble des sites -- inclus dans les chiffres, détail dans l'onglet Bots.</p>
            <TrendChart data={overview.series} lines={[{ dataKey: "sessions", label: "Sessions", color: "var(--series-1)" }]} markAnomalies />
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
