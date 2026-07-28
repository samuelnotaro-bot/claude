import type { Finding } from "../lib/api";
import { formatPct } from "../lib/format";

const CHANNEL_LABELS: Record<string, string> = {
  organic: "organique",
  direct: "direct",
  referral: "référent",
  paid: "payant",
  social: "social",
  email: "email",
};

export function FindingsList({ findings, emptyLabel = "Aucune tendance notable détectée sur cette sélection." }: { findings: Finding[]; emptyLabel?: string }) {
  if (findings.length === 0) return <p className="empty-state">{emptyLabel}</p>;
  return (
    <ul className="bullet-list">
      {findings.map((f, i) => (
        <li key={i}>
          <span className="dot" style={{ background: f.suspect ? "var(--warning)" : f.direction === "up" ? "var(--good)" : "var(--critical)" }} />
          <span>
            <div>
              {f.suspect && <span title="Variation extrême, probablement un artefact de données -- voir l'explication ci-dessous.">⚠ </span>}
              <strong>{f.entityName}</strong> — {f.label} {f.direction === "up" ? "↑" : "↓"} {formatPct(f.changePct)}
              {f.detail && <span className="finding-detail"> ({CHANNEL_LABELS[f.detail] ?? f.detail})</span>}
            </div>
            {f.explanation && <div className="finding-explanation">{f.explanation}</div>}
          </span>
        </li>
      ))}
    </ul>
  );
}
