import type { GeoMismatch } from "../lib/api";

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export function GeoMismatchPanel({ mismatches }: { mismatches: GeoMismatch[] }) {
  if (mismatches.length === 0) {
    return <p className="empty-state">Aucun écart de géolocalisation détecté sur les sites suivis (seuil : 20% de trafic inattendu).</p>;
  }
  return (
    <ul className="bullet-list geo-mismatch-list">
      {mismatches.map((m) => (
        <li key={m.siteId} className="geo-mismatch-item">
          <span className="dot" style={{ background: "var(--critical)" }} />
          <span>
            <div>
              <strong>{m.siteName}</strong> — {pct(m.topUnexpectedShare)} du trafic vient de <strong>{m.topUnexpectedCountry}</strong>,
              un pays inattendu (attendu : {m.expectedLabel}).
            </div>
            <div className="geo-mismatch-split">
              Dans ce pays : {pct(m.unexpectedOrganicShare)} organique · {pct(m.unexpectedDirectShare)} direct
            </div>
            <div className="geo-mismatch-plan">{m.actionPlan}</div>
          </span>
        </li>
      ))}
    </ul>
  );
}
