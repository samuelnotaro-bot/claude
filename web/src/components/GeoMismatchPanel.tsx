import type { GeoMismatch } from "../lib/api";

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export function GeoMismatchPanel({ mismatches }: { mismatches: GeoMismatch[] }) {
  if (mismatches.length === 0) {
    return <p className="empty-state">Aucun écart de géolocalisation détecté sur les sites suivis.</p>;
  }
  return (
    <ul className="bullet-list">
      {mismatches.map((m) => (
        <li key={m.siteId}>
          <span className="dot" style={{ background: "var(--critical)" }} />
          <span>
            <strong>{m.siteName}</strong> — {pct(m.topUnexpectedShare)} du trafic vient de <strong>{m.topUnexpectedCountry}</strong>,
            un pays inattendu (attendu : {m.expectedLabel}).
          </span>
        </li>
      ))}
    </ul>
  );
}
