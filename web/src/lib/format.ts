export function formatCompactNumber(n: number): string {
  return new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** Like formatCompactNumber, but shows "non disponible" for a null value (a Piwik query failed / integration not configured) instead of a misleading "0". */
export function formatCompactNumberOrNA(n: number | null): string {
  return n === null ? "non disponible" : formatCompactNumber(n);
}

/** Like a percentage formatter, but shows "non disponible" for a null value instead of a misleading "0.0%". */
export function formatPctOrNA(n: number | null, digits = 1): string {
  return n === null ? "non disponible" : `${(n * 100).toFixed(digits)}%`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("fr-FR").format(Math.round(n));
}

export function formatPct(n: number | null, digits = 1): string {
  if (n === null || Number.isNaN(n)) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

/**
 * Disclosure of what makes the totals on a view *not* a complete pass-through
 * of Piwik Pro's own numbers: days with no synced data at all (the totals
 * likely undercount the real Piwik Pro figures by however many days are
 * missing). Missing days are split into those Piwik Pro can still provide (a
 * sync gap, fixable by "Combler les trous de données") and those older than
 * the account's data retention window (missingDaysOutOfRetention -- Piwik Pro
 * no longer has this data at all, so it will never be filled, no matter how
 * many times a gap-fill retries it). Returns null when nothing applies, i.e.
 * the totals are a complete sum.
 *
 * Traffic-spike days are NOT part of this: they're included in the totals
 * (see anomaly.ts), just flagged for the charts/Bots tab -- see
 * anomalyInclusionNote below for that separate, non-warning note.
 */
export function dataQualityNote(missingDays: number, missingDaysOutOfRetention = 0): string | null {
  const parts: string[] = [];
  const fixableMissing = missingDays - missingDaysOutOfRetention;
  if (fixableMissing > 0) {
    parts.push(`${fixableMissing} jour${fixableMissing > 1 ? "s" : ""} de données manquant${fixableMissing > 1 ? "s" : ""} (non encore synchronisé${fixableMissing > 1 ? "s" : ""} -- totaux sous-estimés d'autant)`);
  }
  if (missingDaysOutOfRetention > 0) {
    parts.push(
      `${missingDaysOutOfRetention} jour${missingDaysOutOfRetention > 1 ? "s" : ""} de données définitivement indisponible${missingDaysOutOfRetention > 1 ? "s" : ""} (hors période de rétention Piwik Pro -- ne sera${missingDaysOutOfRetention > 1 ? "ont" : ""} jamais synchronisé${missingDaysOutOfRetention > 1 ? "s" : ""})`
    );
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Neutral (non-warning) note that N day(s) in the totals were an unusually
 * high traffic spike (>35% above average, see anomaly.ts) -- informational
 * only, since those days are included in the totals, not excluded.
 */
export function anomalyInclusionNote(flaggedAnomalyDays: number): string | null {
  if (flaggedAnomalyDays <= 0) return null;
  return `${flaggedAnomalyDays} jour${flaggedAnomalyDays > 1 ? "s" : ""} de pic de trafic inhabituel inclus dans ces chiffres (voir l'onglet Bots)`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(d);
}
