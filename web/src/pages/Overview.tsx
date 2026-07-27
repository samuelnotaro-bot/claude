import { useEffect, useState } from "react";
import { api, type Overview as OverviewData, type Finding, type Synthesis } from "../lib/api";
import { KpiTile } from "../components/KpiTile";
import { TrendChart } from "../components/TrendChart";
import { ChannelMixChart } from "../components/ChannelMixChart";
import { SynthesisPanel } from "../components/SynthesisPanel";
import { formatCompactNumber, formatPct } from "../lib/format";

const ANOMALY_TOOLTIP =
  "Seuls les pics de trafic statistiquement extrêmes sont exclus de ce calcul. Pour une fiabilité complète, vérifiez le filtre anti-bot dans Piwik Pro > Administration > Confidentialité.";

function anomalyNote(days: number): string {
  return `${days} jour${days > 1 ? "s" : ""} de pic trafic exclu${days > 1 ? "s" : ""} ce mois-ci`;
}

export function Overview() {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [synthesis, setSynthesis] = useState<Synthesis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.overview(), api.findings(6), api.latestSynthesis()])
      .then(([o, f, s]) => {
        setOverview(o);
        setFindings(f);
        setSynthesis(s);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <p className="empty-state">Erreur de chargement : {error}. Le serveur API tourne-t-il sur le bon port ?</p>;
  if (!overview) return <p className="empty-state">Chargement…</p>;

  return (
    <div>
      <div className="kpi-grid">
        <KpiTile
          label="Sessions (7 derniers jours)"
          value={formatCompactNumber(overview.sessionsLast7d)}
          deltaPct={overview.sessionsChangePct}
          note={overview.excludedAnomalyDays > 0 ? anomalyNote(overview.excludedAnomalyDays) : undefined}
          noteTooltip={ANOMALY_TOOLTIP}
        />
        <KpiTile label="Conversions (7 derniers jours)" value={formatCompactNumber(overview.conversionsLast7d)} deltaPct={overview.conversionsChangePct} />
        <KpiTile
          label="Taux de conversion global"
          value={`${(overview.conversionRateLast7d * 100).toFixed(2)}%`}
          deltaPct={overview.conversionRateChangePct}
          note={overview.excludedAnomalyDays > 0 ? anomalyNote(overview.excludedAnomalyDays) : undefined}
          noteTooltip={ANOMALY_TOOLTIP}
        />
        <KpiTile label="Sites suivis" value={String(overview.siteCount)} deltaPct={null} />
      </div>

      <div className="grid-2">
        <div>
          <div className="card">
            <h2>Trafic global — 14 derniers jours</h2>
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
            <h2>Tendances les plus significatives</h2>
            {findings.length === 0 && <p className="empty-state">Aucune tendance notable détectée.</p>}
            <ul className="bullet-list">
              {findings.map((f, i) => (
                <li key={i}>
                  <span className="dot" style={{ background: f.direction === "up" ? "var(--good)" : "var(--critical)" }} />
                  <span>
                    <strong>{f.entityName}</strong> — {f.label} {f.direction === "up" ? "↑" : "↓"} {formatPct(f.changePct)}
                    {f.detail && <span className="finding-detail"> ({f.detail})</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
