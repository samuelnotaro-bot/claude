import type { Synthesis } from "../lib/api";
import { formatDate } from "../lib/format";

export function SynthesisPanel({ synthesis }: { synthesis: Synthesis | null }) {
  if (!synthesis) {
    return <p className="empty-state">Aucune synthèse disponible pour le moment. Lancez le backfill (`npm run backfill`) puis générez une synthèse.</p>;
  }
  return (
    <div>
      <div className="synthesis-meta">
        Période analysée : {formatDate(synthesis.periodFrom)} → {formatDate(synthesis.periodTo)} · générée le{" "}
        {new Date(synthesis.generatedAt).toLocaleString("fr-FR")}
      </div>
      <ul className="bullet-list">
        {synthesis.bullets.map((b, i) => (
          <li key={i}>
            <span className="dot" />
            <span>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
