import { useEffect, useState } from "react";
import { api, type Synthesis as SynthesisType, type PeriodSynthesis, type BotSignal, type GeoMismatch } from "../lib/api";
import { SynthesisPanel } from "../components/SynthesisPanel";
import { FindingsList } from "../components/FindingsList";
import { GeoMismatchPanel } from "../components/GeoMismatchPanel";
import { HistoryWarningBanner } from "../components/HistoryWarningBanner";
import { DataOutageBanner } from "../components/DataOutageBanner";
import { HeroBanner } from "../components/HeroBanner";
import { formatCompactNumber, formatDate } from "../lib/format";
import { usePeriod, periodComparisonLabel } from "../lib/periodContext";

export function Synthesis() {
  const { queryParams, compare, from, to } = usePeriod();
  const [periodSynthesis, setPeriodSynthesis] = useState<PeriodSynthesis | null>(null);
  const [botSignal, setBotSignal] = useState<BotSignal | null>(null);
  const [geoMismatches, setGeoMismatches] = useState<GeoMismatch[]>([]);
  const [history, setHistory] = useState<SynthesisType[]>([]);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    api.periodSynthesis(queryParams).then(setPeriodSynthesis);
    api.bots(queryParams).then(setBotSignal);
    // Geo-mismatch is intentionally NOT re-checked live here: a check hits
    // Piwik Pro directly and this app is bound by a strict per-minute rate
    // limit (see config.ts) -- reuse the last stored check (see checkedAt
    // below) instead of triggering one on every period change. Run a fresh
    // check from the Localisation tab when needed.
    api.geoMismatches().then(setGeoMismatches);
  }, [queryParams]);

  function loadHistory() {
    api.synthesisHistory(20).then(setHistory);
  }

  useEffect(loadHistory, []);

  async function handleGenerate() {
    setGenerating(true);
    try {
      await api.generateSynthesis();
      loadHistory();
    } finally {
      setGenerating(false);
    }
  }

  const deltaLabel = periodComparisonLabel(compare);
  const periodLabel = from === to ? from : `${from} → ${to}`;
  const geoCheckedAt = geoMismatches[0]?.checkedAt;

  return (
    <div>
      <HeroBanner image="/lesclientssavent.png" />
      <div className="card">
        <h2 style={{ marginBottom: 4 }}>Synthèse — {periodLabel}</h2>
        <p className="card-subtitle" style={{ margin: 0 }}>
          Consolidation de toutes les analyses de la période sélectionnée ({deltaLabel}) : trafic, conversion, SEO/GEO,
          signal bot et localisation. Change avec le sélecteur de période en haut de page.
        </p>
      </div>

      {!periodSynthesis ? (
        <p className="empty-state">Chargement…</p>
      ) : (
        <>
          <HistoryWarningBanner
            historyOk={periodSynthesis.historyOk}
            retentionLimited={periodSynthesis.retentionLimited}
            comparisonFrom={periodSynthesis.comparisonFrom}
            earliestDataDate={periodSynthesis.earliestDataDate}
            retentionFloorDate={periodSynthesis.retentionFloorDate}
          />

          <DataOutageBanner outages={periodSynthesis.dataOutages} />

          <div className="card">
            <h2>Résumé</h2>
            {periodSynthesis.bullets.length === 0 ? (
              <p className="empty-state">Pas assez d'historique pour synthétiser cette période.</p>
            ) : (
              <ul className="bullet-list">
                {periodSynthesis.bullets.map((b, i) => (
                  <li key={i}>
                    <span className="dot" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>Toutes les tendances notables — analyse & plan d'action</h2>
            <p className="chart-note">
              Trafic, conversion, devis/support/téléchargements, SEO/GEO (organique, IA, Search Console) et signal bot --
              tout ce qui dépasse le seuil de variation notable sur cette période, site par site, région par région et
              global.
            </p>
            <FindingsList findings={periodSynthesis.findings} />
          </div>

          <div className="card">
            <h2>Signal bot</h2>
            {!botSignal ? (
              <p className="empty-state">Chargement…</p>
            ) : (
              <>
                <p className="chart-note">
                  Part de trafic estimée bot sur la période :{" "}
                  <strong>
                    {botSignal.estimatedBotSharePct === null ? "non calculable (historique insuffisant)" : `${(botSignal.estimatedBotSharePct * 100).toFixed(1)}%`}
                  </strong>{" "}
                  ({formatCompactNumber(botSignal.totalExcessSessions)} sessions en excès / {formatCompactNumber(botSignal.totalSessions)} sessions totales).{" "}
                  {botSignal.trafficSpikes.length > 0
                    ? `${botSignal.trafficSpikes.length} pic(s) de trafic notable(s) détecté(s) sur la période.`
                    : "Aucun pic de trafic notable sur la période."}
                </p>
                {botSignal.trafficSpikes.length > 0 && (
                  <ul className="bullet-list">
                    {botSignal.trafficSpikes.slice(0, 3).map((s, i) => (
                      <li key={i}>
                        <span className="dot" style={{ background: "var(--warning)" }} />
                        <span>
                          <strong>{formatDate(s.date)}</strong> — {formatCompactNumber(s.sessions)} sessions ({(s.organicShare * 100).toFixed(0)}% organique)
                          {s.sites.length > 0 && <span className="finding-detail"> — {s.sites.map((x) => x.siteName).join(", ")}</span>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="chart-note">Détail complet (variations statistiques confirmées, méthode de détection) dans l'onglet Bots.</p>
              </>
            )}
          </div>

          <div className="card">
            <h2>Localisation</h2>
            <p className="chart-note">
              {geoCheckedAt
                ? `Dernier contrôle : ${new Date(geoCheckedAt).toLocaleString("fr-FR")} -- pas recalculé automatiquement pour la période sélectionnée (appels Piwik Pro limités). Lancez un nouveau contrôle depuis l'onglet Localisation pour une donnée à jour.`
                : "Aucun contrôle de géolocalisation n'a encore été lancé -- rendez-vous sur l'onglet Localisation."}
            </p>
            <GeoMismatchPanel mismatches={geoMismatches} />
          </div>
        </>
      )}

      <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>Journal historique (cron hebdomadaire)</h2>
          <p className="card-subtitle" style={{ margin: 0 }}>
            Archive générée automatiquement chaque semaine (moteur de règles statistiques, fenêtre 7j/7j fixe au moment de
            la génération) -- indépendante du sélecteur de période, conservée pour l'historique. La synthèse ci-dessus est
            la version à jour pour la période actuellement sélectionnée.
          </p>
        </div>
        <button className="primary-btn" onClick={handleGenerate} disabled={generating}>
          {generating ? "Génération…" : "Générer maintenant"}
        </button>
      </div>

      {history.length === 0 && (
        <div className="card">
          <p className="empty-state">Aucune synthèse dans le journal pour le moment.</p>
        </div>
      )}

      {history.map((s) => (
        <div className="card" key={s.id}>
          <SynthesisPanel synthesis={s} />
        </div>
      ))}
    </div>
  );
}
