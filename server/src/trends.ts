import type { SnapshotRow } from "./repo.js";
import type { Channel } from "./piwik/types.js";

export interface DayPoint {
  date: string;
  sessions: number;
  users: number;
  pageviews: number;
  goalConversions: number;
  conversionRate: number;
  bounceRate: number;
  channels: Record<Channel, number>;
  rfqConversions: number;
  supportConversions: number;
  downloads: number;
  /** True when this day (or, for an aggregate point, at least one contributing site) was flagged as a traffic-flood anomaly. See anomaly.ts. */
  isAnomaly?: boolean;
}

export type Scope = "site" | "continent" | "global";

export interface Finding {
  scope: Scope;
  entityId: string;
  entityName: string;
  metric: "sessions" | "conversionRate" | "goalConversions" | "channelMix";
  label: string; // human metric label, e.g. "trafic (sessions)"
  direction: "up" | "down";
  changePct: number | null; // week-over-week % change
  current: number;
  previous: number;
  impactScore: number; // used to rank findings by significance
  detail?: string; // extra context, e.g. which channel shifted
}

const METRIC_LABELS: Record<Finding["metric"], string> = {
  sessions: "trafic (sessions)",
  conversionRate: "taux de conversion",
  goalConversions: "conversions",
  channelMix: "répartition des canaux d'acquisition",
};

export function toDayPoints(rows: SnapshotRow[], anomalousDates?: Set<string>): DayPoint[] {
  return rows.map((r) => ({
    date: r.date,
    sessions: r.sessions,
    users: r.users,
    pageviews: r.pageviews,
    goalConversions: r.goalConversions,
    conversionRate: r.sessions > 0 ? r.goalConversions / r.sessions : 0,
    bounceRate: r.bounceRate,
    channels: r.channels,
    rfqConversions: r.rfqConversions,
    supportConversions: r.supportConversions,
    downloads: r.downloads,
    isAnomaly: anomalousDates?.has(r.date) ?? false,
  }));
}

/**
 * Merges same-date rows from multiple sites into continent/global daily points.
 * `anomalousDatesBySite`, when given, must be index-aligned with `rowsBySite`; an
 * aggregate point is marked `isAnomaly` if any contributing site was flagged that day.
 */
export function aggregateDayPoints(rowsBySite: SnapshotRow[][], anomalousDatesBySite?: (Set<string> | undefined)[]): DayPoint[] {
  const byDate = new Map<string, DayPoint>();
  rowsBySite.forEach((rows, siteIndex) => {
    const anomalousDates = anomalousDatesBySite?.[siteIndex];
    for (const r of rows) {
      const existing = byDate.get(r.date);
      const base: DayPoint = existing ?? {
        date: r.date,
        sessions: 0,
        users: 0,
        pageviews: 0,
        goalConversions: 0,
        conversionRate: 0,
        bounceRate: 0,
        channels: { organic: 0, direct: 0, referral: 0, paid: 0, social: 0, email: 0, other: 0 },
        rfqConversions: 0,
        supportConversions: 0,
        downloads: 0,
        isAnomaly: false,
      };
      base.sessions += r.sessions;
      base.users += r.users;
      base.pageviews += r.pageviews;
      base.goalConversions += r.goalConversions;
      base.rfqConversions += r.rfqConversions;
      base.supportConversions += r.supportConversions;
      base.downloads += r.downloads;
      for (const ch of Object.keys(base.channels) as Channel[]) {
        base.channels[ch] += r.channels[ch];
      }
      if (anomalousDates?.has(r.date)) base.isAnomaly = true;
      byDate.set(r.date, base);
    }
  });
  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const p of points) p.conversionRate = p.sessions > 0 ? p.goalConversions / p.sessions : 0;
  return points;
}

function sum(points: DayPoint[], pick: (p: DayPoint) => number): number {
  return points.reduce((acc, p) => acc + pick(p), 0);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((acc, v) => acc + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function lastNDays(points: DayPoint[], n: number, offset = 0): DayPoint[] {
  const end = points.length - offset;
  const start = Math.max(0, end - n);
  return points.slice(start, end);
}

/**
 * Compares the most recent 7-day window against the prior 7-day window for a metric,
 * flags it as a finding when the change is both statistically unusual (z-score of the
 * recent daily average against the trailing 8-week baseline) and large enough to matter.
 */
function detectMetricTrend(
  points: DayPoint[],
  pick: (p: DayPoint) => number,
  metric: Finding["metric"],
  scope: Scope,
  entityId: string,
  entityName: string,
  minAbsChangePct: number
): Finding | null {
  if (points.length < 14) return null;

  const recent = lastNDays(points, 7);
  const previous = lastNDays(points, 7, 7);
  const currentTotal = sum(recent, pick);
  const previousTotal = sum(previous, pick);

  if (previousTotal === 0 && currentTotal === 0) return null;
  const changePct = previousTotal === 0 ? null : (currentTotal - previousTotal) / previousTotal;
  if (changePct === null) return null;
  if (Math.abs(changePct) < minAbsChangePct) return null;

  const baselineDaily = lastNDays(points, 56, 7).map(pick); // up to 8 weeks before the last 7 days
  const baselineMean = mean(baselineDaily);
  const baselineStd = stddev(baselineDaily, baselineMean);
  const recentDailyAvg = currentTotal / recent.length;
  const z = baselineStd === 0 ? (recentDailyAvg === baselineMean ? 0 : Infinity) : (recentDailyAvg - baselineMean) / baselineStd;

  // Require some statistical signal, not just noise -- but don't demand it for very large % moves.
  if (Math.abs(z) < 1 && Math.abs(changePct) < minAbsChangePct * 2) return null;

  const impactScore = Math.abs(changePct) * Math.log10(Math.max(currentTotal, previousTotal, 1) + 1);

  return {
    scope,
    entityId,
    entityName,
    metric,
    label: METRIC_LABELS[metric],
    direction: changePct >= 0 ? "up" : "down",
    changePct,
    current: currentTotal,
    previous: previousTotal,
    impactScore,
  };
}

function detectChannelMixShift(
  points: DayPoint[],
  scope: Scope,
  entityId: string,
  entityName: string
): Finding | null {
  if (points.length < 14) return null;
  const recent = lastNDays(points, 7);
  const previous = lastNDays(points, 7, 7);

  const shareOf = (pts: DayPoint[], ch: Channel) => {
    const total = sum(pts, (p) => p.sessions);
    if (total === 0) return 0;
    return sum(pts, (p) => p.channels[ch]) / total;
  };

  let biggestShift: { channel: Channel; delta: number } | null = null;
  for (const ch of ["organic", "direct", "referral", "paid", "social", "email"] as Channel[]) {
    const delta = shareOf(recent, ch) - shareOf(previous, ch);
    if (!biggestShift || Math.abs(delta) > Math.abs(biggestShift.delta)) {
      biggestShift = { channel: ch, delta };
    }
  }
  if (!biggestShift || Math.abs(biggestShift.delta) < 0.06) return null; // require >=6pt share move

  const currentSessions = sum(recent, (p) => p.sessions);
  const impactScore = Math.abs(biggestShift.delta) * 10 * Math.log10(currentSessions + 1);

  return {
    scope,
    entityId,
    entityName,
    metric: "channelMix",
    label: METRIC_LABELS.channelMix,
    direction: biggestShift.delta >= 0 ? "up" : "down",
    changePct: biggestShift.delta,
    current: currentSessions,
    previous: currentSessions,
    impactScore,
    detail: biggestShift.channel,
  };
}

export function findTrendsForEntity(
  points: DayPoint[],
  scope: Scope,
  entityId: string,
  entityName: string
): Finding[] {
  const findings: Finding[] = [];
  const traffic = detectMetricTrend(points, (p) => p.sessions, "sessions", scope, entityId, entityName, 0.12);
  const conv = detectMetricTrend(points, (p) => p.conversionRate, "conversionRate", scope, entityId, entityName, 0.15);
  const goals = detectMetricTrend(points, (p) => p.goalConversions, "goalConversions", scope, entityId, entityName, 0.15);
  const channelShift = detectChannelMixShift(points, scope, entityId, entityName);
  for (const f of [traffic, conv, goals, channelShift]) if (f) findings.push(f);
  return findings;
}

export function rankFindings(findings: Finding[], limit?: number): Finding[] {
  const sorted = [...findings].sort((a, b) => b.impactScore - a.impactScore);
  return limit ? sorted.slice(0, limit) : sorted;
}
