import { useEffect, useState } from "react";
import { api, type BotSignal } from "../lib/api";
import { KpiTile } from "../components/KpiTile";
import { formatCompactNumber, formatDate } from "../lib/format";
import { usePeriod, periodComparisonLabel } from "../lib/periodContext";

const CHANNEL_LABELS: Record<string, string> = { organic: "organique", direct: "direct" };

export function Bots() {
  const { queryParams, compare, from, to } = usePeriod();
  const [signal, setSignal] = useState<BotSignal | null>(null);

  useEffect(() => {
    api.bots(queryParams).then(setSignal);
  }, [queryParams]);

  const deltaLabel = periodComparisonLabel(compare);

  return (
    <div>
      <div className="card">
        <h2>Détection de trafic bot</h2>
        <p className="card-subtitle" style={{ margin: "-6px 0 0" }}>
          Grosses variations de trafic organique et direct sur {from} → {to}, et estimation du trafic bot par rapport au trafic
          total mesuré. Voir README pour la méthode de détection (statistique, pas de blocklist).
        </p>
      </div>

      {!signal ? (
        <p className="empty-state">Chargement…</p>
      ) : (
        <>
          <div className="kpi-grid" style={{ marginTop: 16 }}>
            <KpiTile
              label="Part de trafic estimée bot"
              value={signal.estimatedBotSharePct === null ? "—" : `${(signal.estimatedBotSharePct * 100).toFixed(1)}%`}
              deltaPct={null}
              deltaLabel=""
              deltaIsGoodWhenUp={false}
              note={`${formatCompactNumber(signal.totalExcessSessions)} sessions en excès / ${formatCompactNumber(signal.totalSessions)} sessions totales sur la période`}
            />
            <KpiTile
              label="Trafic à faible engagement (signal secondaire)"
              value={`${(signal.lowEngagementShare * 100).toFixed(1)}%`}
              deltaPct={signal.lowEngagementShareChangePct}
              deltaIsGoodWhenUp={false}
              deltaLabel={deltaLabel}
              note="Sessions rebond (1 page) sur organique/direct -- tendance douce, à lire avec les pics ci-dessous."
            />
          </div>

          <div className="card">
            <h2>Variations détectées ({signal.anomalies.length})</h2>
            {signal.anomalies.length === 0 ? (
              <p className="empty-state">Aucune variation statistiquement anormale détectée sur cette période.</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Région</th>
                    <th>Date</th>
                    <th>Canal</th>
                    <th>Sessions</th>
                    <th>Référence</th>
                    <th>Excès</th>
                  </tr>
                </thead>
                <tbody>
                  {signal.anomalies.map((a, i) => (
                    <tr key={i}>
                      <td>{a.siteName}</td>
                      <td>{a.region}</td>
                      <td>{formatDate(a.date)}</td>
                      <td>{a.channels.map((c) => CHANNEL_LABELS[c] ?? c).join(" + ")}</td>
                      <td>{formatCompactNumber(a.sessions)}</td>
                      <td>{formatCompactNumber(a.baselineSessions)}</td>
                      <td>{formatCompactNumber(a.excessSessions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
