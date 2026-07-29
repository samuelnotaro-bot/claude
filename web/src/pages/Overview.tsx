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
  const [deepBackfilling, setDeepBackfilling] = useState(false);
  const [deepBackfillMessage, setDeepBackfillMessage] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    api
      .overview(queryParams)
      .then(setOverview)
      .catch((e) => setError(String(e)));
  }, [queryParams]);

  // Resume polling on mount if a job is already running server-side (e.g.
  // the button was clicked, then the page got reloaded) -- both are
  // background jobs precisely so leaving/reloading the page doesn't lose
  // them or reset the button to its idle state.
  useEffect(() => {
    api.deepBackfillStatus().then((status) => {
      if (status.running) {
        setDeepBackfilling(true);
        pollDeepBackfillStatus();
      }
    });
    api.fillGapsStatus().then((status) => {
      if (status.running) {
        setFillingGaps(true);
        pollFillGapsStatus();
      }
    });
  }, []);

  // A large multi-day, multi-site outage needs several rounds of backfillGaps
  // to fully close (each round caps itself at MAX_GAP_FILLS_PER_RUN) --
  // runGapFillLoop runs those rounds server-side in the background, so this
  // polls its status instead of requiring a human to keep re-clicking the
  // button every couple of minutes until it's done.
  function pollFillGapsStatus() {
    const check = async () => {
      let status;
      try {
        status = await api.fillGapsStatus();
      } catch {
        setTimeout(check, 8000);
        return;
      }
      if (status.running) {
        const r = status.result;
        setGapMessage(r ? `En cours… tour ${status.round}, ${r.daysFilled} jour(s) comblé(s) jusqu'ici.` : "En cours…");
        setTimeout(check, 4000);
        return;
      }
      setFillingGaps(false);
      if (status.error) {
        setGapMessage(`Échec : ${status.error}`);
      } else {
        const r = status.result;
        const parts: string[] = [];
        if (!r || (r.daysFilled === 0 && r.daysFailed === 0 && r.daysOutOfRetention === 0)) {
          parts.push("Aucun trou détecté dans l'historique.");
        } else {
          if (r.daysFilled > 0) parts.push(`${r.daysFilled} jour(s) comblé(s) en ${r.rounds} tour(s)`);
          if (r.daysFailed > 0) parts.push(`${r.daysFailed} échec(s) Piwik Pro (relancez pour réessayer)`);
          if (r.daysRemaining > 0) parts.push(`${r.daysRemaining} pas encore tenté(s), relancez`);
          if (r.daysOutOfRetention > 0)
            parts.push(`${r.daysOutOfRetention} jour(s) hors de la période de rétention Piwik Pro -- ne seront jamais disponibles`);
        }
        setGapMessage(parts.join(" · ") + ".");
      }
      api.overview(queryParams).then(setOverview);
    };
    check();
  }

  async function handleFillGaps() {
    setGapMessage(null);
    try {
      const res = await api.startFillGaps();
      if (res.alreadyRunning) {
        setGapMessage("Un comblement de trous est déjà en cours.");
      }
      setFillingGaps(true);
      pollFillGapsStatus();
    } catch (e) {
      setGapMessage(`Échec : ${String(e)}`);
    }
  }

  // A real 26-month backfill takes a couple of minutes even batched by date
  // range -- Render's free-plan proxy would kill a single blocking request
  // well before that finishes, and there's no Shell tab to run it any other
  // way. The button starts the job server-side and this polls its status
  // (same pattern as BackfillBanner) so the page refreshes itself instead of
  // needing a manual reload once it's done.
  function pollDeepBackfillStatus() {
    const check = async () => {
      let status;
      try {
        status = await api.deepBackfillStatus();
      } catch {
        setTimeout(check, 8000);
        return;
      }
      if (status.running) {
        setDeepBackfillMessage(`En cours… ${status.sitesDone}/${status.sitesTotal} site(s) traité(s).`);
        setTimeout(check, 4000);
        return;
      }
      setDeepBackfilling(false);
      if (status.error) {
        setDeepBackfillMessage(`Échec : ${status.error}`);
      } else if (!status.result?.extended) {
        setDeepBackfillMessage("Déjà à la limite de rétention Piwik Pro -- rien de plus ancien à récupérer.");
      } else {
        const r = status.result;
        setDeepBackfillMessage(
          `${r.dateFrom} → ${r.dateTo} récupéré pour ${r.sitesExtended} site(s)` +
            (r.failed > 0 ? ` -- ${r.failed} échec(s) Piwik Pro, relancez pour réessayer` : "") +
            (r.batchError ? ` -- erreur Piwik Pro : ${r.batchError}` : "") +
            "."
        );
      }
      api.overview(queryParams).then(setOverview);
    };
    check();
  }

  async function handleDeepBackfill() {
    setDeepBackfillMessage(null);
    try {
      const res = await api.startDeepBackfill();
      if (res.alreadyRunning) {
        setDeepBackfillMessage("Une extension d'historique est déjà en cours.");
      }
      setDeepBackfilling(true);
      pollDeepBackfillStatus();
    } catch (e) {
      setDeepBackfillMessage(`Échec : ${String(e)}`);
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
      <HeroBanner image="/coeurs.png" caption="Trafic, conversion et KPIs clés" />
      <div className="period-banner">
        <p className="chart-note" style={{ margin: 0 }}>
          Période affichée : {periodLabel} — {deltaLabel}
        </p>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {gapMessage && <span className="chart-note" style={{ margin: 0 }}>{gapMessage}</span>}
            <button className="secondary-btn" onClick={handleFillGaps} disabled={fillingGaps} title="Le serveur comble déjà les trous automatiquement en arrière-plan (au démarrage et toutes les 15 min) -- ce bouton force juste une passe immédiate au lieu d'attendre.">
              {fillingGaps ? "Comblement en cours…" : "Forcer un comblement immédiat"}
            </button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            {deepBackfillMessage && <span className="chart-note" style={{ margin: 0 }}>{deepBackfillMessage}</span>}
            <button
              className="secondary-btn"
              onClick={handleDeepBackfill}
              disabled={deepBackfilling}
              title="Le serveur étend déjà l'historique jusqu'à 26 mois automatiquement en arrière-plan -- ce bouton force juste une passe immédiate au lieu d'attendre."
            >
              {deepBackfilling ? "Extension en cours…" : "Forcer une extension immédiate"}
            </button>
          </div>
          <p className="chart-note" style={{ margin: 0, maxWidth: 420, textAlign: "right" }}>
            La récupération des 26 mois d'historique et le comblement des trous tournent automatiquement en
            arrière-plan (au démarrage puis toutes les 15 minutes tant que le service est éveillé) -- ces boutons ne
            sont là que pour forcer une passe immédiate plutôt que d'attendre.
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
