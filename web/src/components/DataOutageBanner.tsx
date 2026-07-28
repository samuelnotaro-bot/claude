import type { DataOutage } from "../lib/api";
import { formatDate } from "../lib/format";

/**
 * Prominent alert for sites with 4+ consecutive days of no real data --
 * distinct from the lighter data-quality-banner note (sync gap/retention):
 * this means a specific site (a country, a region) likely has a broken
 * tracking tag or a real outage right now, not just "a few days undercounted".
 */
export function DataOutageBanner({ outages }: { outages: DataOutage[] }) {
  if (outages.length === 0) return null;
  return (
    <div className="data-outage-banner">
      <strong>⚠ Panne de données détectée</strong>
      <ul className="bullet-list">
        {outages.map((o, i) => (
          <li key={i}>
            <span className="dot" style={{ background: "var(--critical)" }} />
            <span>
              <strong>{o.siteName}</strong> ({o.region}) — aucune donnée du {formatDate(o.dateFrom)} au {formatDate(o.dateTo)} ({o.days} jours
              {o.context === "compare" ? ", période de comparaison" : o.context === "current" ? ", période actuelle" : ""}) --
              probablement un tag de suivi cassé ou une intégration Piwik Pro interrompue, à vérifier en priorité.
              {o.context === "compare" && " Toute variation % affichée pour ce site est probablement faussée par ce trou."}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
