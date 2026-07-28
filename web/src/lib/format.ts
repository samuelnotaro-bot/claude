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

export function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(d);
}
