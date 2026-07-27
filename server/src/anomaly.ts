import type { SnapshotRow } from "./repo.js";

const MIN_BASELINE_DAYS = 14;
const BASELINE_WINDOW = 28;
const SESSION_ZSCORE_THRESHOLD = 3;
const SESSION_RATIO_FALLBACK = 4; // used when the baseline is too stable (stddev ~= 0) to compute a z-score
const ORGANIC_SHARE_DELTA = 0.08; // organic share must be at least 8pts above the site's own recent baseline

/**
 * Flags day-level traffic-flood anomalies.
 *
 * Confirmed against real Piwik Pro data on this organization: recurring multi-day
 * floods (5x-140x normal session volume) landing almost entirely in the "organic"
 * channel, that collapse the conversion rate without any real business signal --
 * and that Piwik Pro's own bot detection (`visitor_type` dimension) never flags,
 * since it only catches user-agents that declare themselves as known crawlers.
 *
 * A day is flagged only when BOTH hold, so a genuine traffic win (a real campaign,
 * a viral page) is never excluded: real spikes rarely concentrate this heavily
 * into a single channel the way these floods do.
 *  1. sessions are statistically far above the site's trailing baseline;
 *  2. the organic channel's share of sessions is well above that same baseline.
 */
export function flagAnomalies(rows: SnapshotRow[]): Map<string, { sessions: number; baselineSessions: number }> {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const flagged = new Map<string, { sessions: number; baselineSessions: number }>();

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    const baseline = sorted.slice(Math.max(0, i - BASELINE_WINDOW), i).filter((r) => !flagged.has(r.date));
    if (baseline.length < MIN_BASELINE_DAYS) continue;

    const sessionsBaseline = baseline.map((r) => r.sessions);
    const sessionsMean = mean(sessionsBaseline);
    const sessionsStd = stddev(sessionsBaseline, sessionsMean);
    const sessionsSpike =
      sessionsStd > 0
        ? (row.sessions - sessionsMean) / sessionsStd > SESSION_ZSCORE_THRESHOLD
        : sessionsMean > 0 && row.sessions > sessionsMean * SESSION_RATIO_FALLBACK;
    if (!sessionsSpike) continue;

    const organicShare = (r: SnapshotRow) => (r.sessions > 0 ? r.channels.organic / r.sessions : 0);
    const baselineOrganicShare = mean(baseline.map(organicShare));
    if (organicShare(row) - baselineOrganicShare <= ORGANIC_SHARE_DELTA) continue;

    flagged.set(row.date, { sessions: row.sessions, baselineSessions: Math.round(sessionsMean) });
  }

  return flagged;
}

export function excludeAnomalies(rows: SnapshotRow[]): {
  clean: SnapshotRow[];
  anomalies: { date: string; sessions: number; baselineSessions: number }[];
} {
  const flagged = flagAnomalies(rows);
  if (flagged.size === 0) return { clean: rows, anomalies: [] };
  return {
    clean: rows.filter((r) => !flagged.has(r.date)),
    anomalies: [...flagged.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
