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
          <span className="dot" style={{ background: f.direction === "up" ? "var(--good)" : "var(--critical)" }} />
          <span>
            <strong>{f.entityName}</strong> — {f.label} {f.direction === "up" ? "↑" : "↓"} {formatPct(f.changePct)}
            {f.detail && <span className="finding-detail"> ({CHANNEL_LABELS[f.detail] ?? f.detail})</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
