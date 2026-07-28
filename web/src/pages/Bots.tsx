import { useEffect, useState } from "react";
import { api, type BotSignal } from "../lib/api";
import { KpiTile } from "../components/KpiTile";
import { HeroBanner } from "../components/HeroBanner";
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
      <HeroBanner image="/reunioncrise.png" caption="Analyse du trafic suspect" />
      <div className="card">
        <h2>Détection de trafic bot</h2>
        <p className="card-subtitle" style={{ margin: "-6px 0 0" }}>
          Grosses variations de trafic organique et direct sur {from} → {to}, et estimation du trafic bot par rapport au trafic
          total mesuré. Un "pic" = un jour à plus de 35% au-dessus de la moyenne de la période -- une seule règle simple, pas de
          blocklist, voir README pour le détail.
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
            <h2>Pics de trafic — vue globale ({signal.trafficSpikes.length})</h2>
            <p className="chart-note">
              Jours où le trafic de l'ensemble des sites dépasse de plus de 35% la moyenne de la période sélectionnée, avec la
              répartition organique/direct et les sites individuellement concernés ce jour-là.
            </p>
            {signal.trafficSpikes.length === 0 ? (
              <p className="empty-state">Pas assez de jours dans la période sélectionnée pour calculer une moyenne, ou aucun pic notable.</p>
            ) : (
              <ul className="bullet-list">
                {signal.trafficSpikes.map((spike, i) => (
                  <li key={i}>
                    <span className="dot" style={{ background: "var(--warning)" }} />
                    <span>
                      <strong>{formatDate(spike.date)}</strong> — {formatCompactNumber(spike.sessions)} sessions (moyenne période :{" "}
                      {formatCompactNumber(spike.averageSessions)}) · {(spike.organicShare * 100).toFixed(0)}% organique ·{" "}
                      {(spike.directShare * 100).toFixed(0)}% direct
                      {spike.sites.length > 0 && (
                        <span className="finding-detail">
                          {" "}
                          — sites concernés : {spike.sites.map((s) => s.siteName).join(", ")}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card">
            <h2>Pics de trafic — par site ({signal.anomalies.length})</h2>
            <p className="chart-note">
              Même règle (&gt;35% au-dessus de la moyenne de la période) appliquée site par site plutôt qu'à l'ensemble --
              détecte un pic localisé à un seul site même quand le total global reste normal.
            </p>
            {signal.anomalies.length === 0 ? (
              <p className="empty-state">Aucun pic détecté site par site sur cette période.</p>
            ) : (
              <div className="table-scroll">
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
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
