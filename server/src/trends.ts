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
  /**
   * These 5 fields come from Piwik Pro queries that can fail independently of
   * the core metrics above (wrong/unsupported column, an integration like GSC
   * not configured for a given site, ...) -- see piwik/client.ts. `null` means
   * "not available", distinct from a confirmed `0`, so the UI can show "non
   * disponible" instead of a misleading zero. Aggregation treats null as "no
   * contribution" and only produces a null total when *every* contributing
   * point is null (see addNullable below).
   */
  aiReferralSessions: number | null;
  organicBounces: number | null;
  directBounces: number | null;
  searchConsoleClicks: number | null;
  searchConsoleImpressions: number | null;
  /** True when this day (or, for an aggregate point, at least one contributing site) was flagged as a traffic-flood anomaly. See anomaly.ts. */
  isAnomaly?: boolean;
  /** True when this date has no underlying snapshot row at all (zero-filled -- see zeroFillDayPoints). Lets the UI/validity checks tell "genuinely zero traffic" apart from "no data collected that day". */
  isMissing?: boolean;
}

/** Sums two optional (Piwik-integration-dependent) values, staying null only when both sides are null -- see the DayPoint doc comment above. */
function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

export type Scope = "site" | "continent" | "global";

export type FindingMetric =
  | "sessions"
  | "conversionRate"
  | "goalConversions"
  | "channelMix"
  | "organicSessions"
  | "aiReferralSessions"
  | "lowEngagementShare"
  | "searchConsoleClicks"
  | "rfq"
  | "support"
  | "downloads"
  | "organicSearchConsoleGap";

export interface Finding {
  scope: Scope;
  entityId: string;
  entityName: string;
  metric: FindingMetric;
  label: string; // human metric label, e.g. "trafic (sessions)"
  direction: "up" | "down";
  changePct: number | null; // week-over-week % change
  current: number;
  previous: number;
  impactScore: number; // used to rank findings by significance
  detail?: string; // extra context, e.g. which channel shifted
  /** "Why" -- which child entities (sites within a region/global finding) drove this change, when computable. See routes/api.ts#explainFinding. */
  explanation?: string;
}

export const METRIC_LABELS: Record<FindingMetric, string> = {
  sessions: "trafic (sessions)",
  conversionRate: "taux de conversion",
  goalConversions: "conversions",
  channelMix: "répartition des canaux d'acquisition",
  organicSessions: "trafic organique (SEO)",
  aiReferralSessions: "trafic référé par des IA",
  lowEngagementShare: "part de trafic à faible engagement (signal bot)",
  searchConsoleClicks: "clics Search Console",
  rfq: "demandes de devis",
  support: "demandes de support",
  downloads: "téléchargements",
  organicSearchConsoleGap: "écart trafic organique vs clics Search Console",
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
    aiReferralSessions: r.aiReferralSessions,
    organicBounces: r.organicBounces,
    directBounces: r.directBounces,
    searchConsoleClicks: r.searchConsoleClicks,
    searchConsoleImpressions: r.searchConsoleImpressions,
    isAnomaly: anomalousDates?.has(r.date) ?? false,
  }));
}

function emptyDayPoint(date: string): DayPoint {
  return {
    date,
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
    // null, not 0: a zero-filled/missing day has no data at all, it isn't a
    // confirmed zero for these optional metrics either (see DayPoint above).
    aiReferralSessions: null,
    organicBounces: null,
    directBounces: null,
    searchConsoleClicks: null,
    searchConsoleImpressions: null,
    isAnomaly: false,
    isMissing: true,
  };
}

function addDaysIso(date: string, delta: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * Fills any calendar day between `from` and `to` (inclusive) missing from
 * `points` with a zero-valued point, so callers always get a continuous,
 * fixed-length series to sum/compare regardless of sync gaps (e.g. a day the
 * Render free-tier instance was asleep through its scheduled fetch -- see
 * scheduler.ts / the boot-time catch-up sync in index.ts). Missing days are
 * marked `isMissing` rather than silently blended in as "real zero traffic".
 */
export function zeroFillDayPoints(points: DayPoint[], from: string, to: string): DayPoint[] {
  const byDate = new Map(points.map((p) => [p.date, p]));
  const filled: DayPoint[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) {
    filled.push(byDate.get(d) ?? emptyDayPoint(d));
  }
  return filled;
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
        aiReferralSessions: null,
        organicBounces: null,
        directBounces: null,
        searchConsoleClicks: null,
        searchConsoleImpressions: null,
        isAnomaly: false,
      };
      base.sessions += r.sessions;
      base.users += r.users;
      base.pageviews += r.pageviews;
      base.goalConversions += r.goalConversions;
      base.rfqConversions += r.rfqConversions;
      base.supportConversions += r.supportConversions;
      base.downloads += r.downloads;
      base.aiReferralSessions = addNullable(base.aiReferralSessions, r.aiReferralSessions);
      base.organicBounces = addNullable(base.organicBounces, r.organicBounces);
      base.directBounces = addNullable(base.directBounces, r.directBounces);
      base.searchConsoleClicks = addNullable(base.searchConsoleClicks, r.searchConsoleClicks);
      base.searchConsoleImpressions = addNullable(base.searchConsoleImpressions, r.searchConsoleImpressions);
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

/**
 * Sums multiple already-zero-filled DayPoint series (one per site, all covering
 * the same [from, to] range -- see zeroFillDayPoints) index-wise into one
 * aggregate series. Distinct from aggregateDayPoints, which merges raw
 * SnapshotRow[][] by date instead: this is the version to use once data has
 * already been converted to DayPoint (see routes/api.ts's loadCleanSeriesBySite).
 */
export function aggregateDayPointSeries(seriesBySite: DayPoint[][]): DayPoint[] {
  const length = seriesBySite[0]?.length ?? 0;
  const result: DayPoint[] = [];
  for (let i = 0; i < length; i++) {
    const date = seriesBySite[0][i].date;
    const base = emptyDayPoint(date);
    base.isMissing = false;
    for (const series of seriesBySite) {
      const p = series[i];
      if (!p) continue;
      base.sessions += p.sessions;
      base.users += p.users;
      base.pageviews += p.pageviews;
      base.goalConversions += p.goalConversions;
      base.rfqConversions += p.rfqConversions;
      base.supportConversions += p.supportConversions;
      base.downloads += p.downloads;
      base.aiReferralSessions = addNullable(base.aiReferralSessions, p.aiReferralSessions);
      base.organicBounces = addNullable(base.organicBounces, p.organicBounces);
      base.directBounces = addNullable(base.directBounces, p.directBounces);
      base.searchConsoleClicks = addNullable(base.searchConsoleClicks, p.searchConsoleClicks);
      base.searchConsoleImpressions = addNullable(base.searchConsoleImpressions, p.searchConsoleImpressions);
      for (const ch of Object.keys(base.channels) as Channel[]) base.channels[ch] += p.channels[ch];
      if (p.isAnomaly) base.isAnomaly = true;
    }
    base.conversionRate = base.sessions > 0 ? base.goalConversions / base.sessions : 0;
    result.push(base);
  }
  return result;
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
  metric: FindingMetric,
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

function lowEngagementShare(p: DayPoint): number {
  if (p.organicBounces === null && p.directBounces === null) return 0;
  return p.sessions > 0 ? ((p.organicBounces ?? 0) + (p.directBounces ?? 0)) / p.sessions : 0;
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
  const organic = detectMetricTrend(points, (p) => p.channels.organic, "organicSessions", scope, entityId, entityName, 0.15);
  const aiReferral = detectMetricTrend(points, (p) => p.aiReferralSessions ?? 0, "aiReferralSessions", scope, entityId, entityName, 0.2);
  const botSignal = detectMetricTrend(points, lowEngagementShare, "lowEngagementShare", scope, entityId, entityName, 0.15);
  const gscClicks = detectMetricTrend(points, (p) => p.searchConsoleClicks ?? 0, "searchConsoleClicks", scope, entityId, entityName, 0.15);
  for (const f of [traffic, conv, goals, channelShift, organic, aiReferral, botSignal, gscClicks]) if (f) findings.push(f);
  return findings;
}

export function rankFindings(findings: Finding[], limit?: number): Finding[] {
  const sorted = [...findings].sort((a, b) => b.impactScore - a.impactScore);
  return limit ? sorted.slice(0, limit) : sorted;
}
