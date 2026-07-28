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
 * Combined disclosure of everything that makes the totals on a view *not* a
 * raw pass-through of Piwik Pro's own numbers: statistically-flagged
 * traffic-flood days excluded on purpose (see anomaly.ts), and days with no
 * synced data at all (a sync gap -- the totals below likely undercount the
 * real Piwik Pro figures by however many days are missing). Returns null
 * when neither applies, i.e. the totals are a complete, unmodified sum.
 */
export function dataQualityNote(excludedAnomalyDays: number, missingDays: number): string | null {
  const parts: string[] = [];
  if (excludedAnomalyDays > 0) {
    parts.push(`${excludedAnomalyDays} jour${excludedAnomalyDays > 1 ? "s" : ""} de pic trafic anormal exclu${excludedAnomalyDays > 1 ? "s" : ""} des totaux`);
  }
  if (missingDays > 0) {
    parts.push(`${missingDays} jour${missingDays > 1 ? "s" : ""} de données manquant${missingDays > 1 ? "s" : ""} (non encore synchronisé${missingDays > 1 ? "s" : ""} -- totaux sous-estimés d'autant)`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(d);
}
