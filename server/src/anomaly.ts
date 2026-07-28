/**
 * Minimal shape flagAnomalies actually needs -- both SnapshotRow (per-site,
 * per-day raw data) and DayPoint (an already-aggregated region/global series,
 * see trends.ts) satisfy this, so the exact same flood test can run on a
 * region/global's own totals instead of only per-site.
 */
export interface AnomalySourceRow {
  date: string;
  sessions: number;
  channels: Record<string, number>;
}

// A "pic" is simply a day whose sessions beat the average of the rows it's
// compared against by more than 35% -- deliberately simple (no z-score, no
// channel-concentration signature) so the same rule works identically
// everywhere: chart red dots, the Bots tab, KPI counts. Callers decide what
// "the average" means by which rows they pass in (typically the currently
// selected/displayed period) -- see routes/api.ts and bots.ts.
export const SPIKE_RATIO_THRESHOLD = 1.35;
const MIN_ROWS_FOR_AVERAGE = 3; // fewer than this and "average" isn't meaningful

export type AnomalyChannel = "organic" | "direct";

export interface AnomalyInfo {
  sessions: number;
  baselineSessions: number;
  /** Which channel(s) made up at least half of that day's sessions -- informational only, not a condition for flagging. */
  channels: AnomalyChannel[];
}

/**
 * Flags days where sessions exceed 135% of the average of the given rows --
 * see SPIKE_RATIO_THRESHOLD. Simple on purpose: earlier versions used a
 * statistical z-score + channel-concentration signature, which required 14+
 * days of trailing history, was expensive to reason about, and -- when
 * applied to a region/global aggregate by OR-ing individual sites' flags --
 * produced a red dot on nearly every day once a region had more than a
 * handful of sites (the union of many independent low-probability events
 * approaches certainty). This version has none of those failure modes: it's
 * one rule, applied identically whether the rows are one site or an
 * already-aggregated region/global total.
 */
export function flagAnomalies(rows: AnomalySourceRow[]): Map<string, AnomalyInfo> {
  if (rows.length < MIN_ROWS_FOR_AVERAGE) return new Map();
  const avg = mean(rows.map((r) => r.sessions));
  const flagged = new Map<string, AnomalyInfo>();
  if (avg <= 0) return flagged;

  for (const row of rows) {
    if (row.sessions <= avg * SPIKE_RATIO_THRESHOLD) continue;
    const channels: AnomalyChannel[] = [];
    if (row.sessions > 0) {
      for (const channel of ["organic", "direct"] as AnomalyChannel[]) {
        if ((row.channels[channel] ?? 0) / row.sessions >= 0.5) channels.push(channel);
      }
    }
    flagged.set(row.date, { sessions: row.sessions, baselineSessions: Math.round(avg), channels });
  }

  return flagged;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
