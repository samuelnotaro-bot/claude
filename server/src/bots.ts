import { getSites, getSnapshotsForSites } from "./repo.js";
import { flagAnomalies, type AnomalyChannel } from "./anomaly.js";
import { aggregateDayPoints } from "./trends.js";
import { resolveComparisonRange, pctChange, addDaysIso, ANOMALY_BASELINE_PADDING_DAYS, type PeriodQuery } from "./period.js";

export interface BotAnomalyEntry {
  siteId: string;
  siteName: string;
  region: string;
  date: string;
  channels: AnomalyChannel[];
  sessions: number;
  baselineSessions: number;
  /** Sessions above the site's own trailing baseline that day -- the quantity attributed to the bot wave. */
  excessSessions: number;
}

export interface BotSignalResult {
  periodFrom: string;
  periodTo: string;
  totalSessions: number;
  totalExcessSessions: number;
  /** Share of measured traffic in the period attributed to flagged organic/direct floods (null if there's no traffic to divide by). */
  estimatedBotSharePct: number | null;
  anomalies: BotAnomalyEntry[];
  /** Secondary, softer signal: trend of low-engagement (bounced) organic/direct sessions vs the previous period. */
  lowEngagementShare: number;
  lowEngagementShareChangePct: number | null;
}

/**
 * Drives the dedicated "Bots" tab: lists large organic/direct traffic swings
 * (see anomaly.ts -- generalized to flag either channel, not just organic) and
 * quantifies the excess volume as a share of total measured traffic, plus a
 * softer secondary signal (bounce-heavy sessions on organic/direct).
 */
export async function computeBotSignal(period: PeriodQuery): Promise<BotSignalResult> {
  const sites = await getSites();
  const paddedFrom = addDaysIso(period.from, -ANOMALY_BASELINE_PADDING_DAYS);
  const bulk = await getSnapshotsForSites(
    sites.map((s) => s.id),
    paddedFrom,
    period.to
  );

  const anomalies: BotAnomalyEntry[] = [];
  let totalSessions = 0;

  for (const site of sites) {
    const raw = bulk.get(site.id) ?? [];
    const inPeriod = raw.filter((r) => r.date >= period.from && r.date <= period.to);
    totalSessions += inPeriod.reduce((a, r) => a + r.sessions, 0);

    const flagged = flagAnomalies(raw);
    for (const [date, info] of flagged) {
      if (date < period.from || date > period.to) continue;
      anomalies.push({
        siteId: site.id,
        siteName: site.name,
        region: site.continent,
        date,
        channels: info.channels,
        sessions: info.sessions,
        baselineSessions: info.baselineSessions,
        excessSessions: Math.max(0, info.sessions - info.baselineSessions),
      });
    }
  }

  anomalies.sort((a, b) => b.excessSessions - a.excessSessions);
  const totalExcessSessions = anomalies.reduce((a, e) => a + e.excessSessions, 0);
  const estimatedBotSharePct = totalSessions > 0 ? totalExcessSessions / totalSessions : null;

  // Secondary signal: always compared against the immediately preceding period
  // of the same length, regardless of the dashboard-wide comparison mode --
  // this is a short-term trend indicator, not a KPI meant for YoY reading.
  const compareRange = resolveComparisonRange({ ...period, compare: "previous_period" });
  const compareBulk = await getSnapshotsForSites(
    sites.map((s) => s.id),
    compareRange.from,
    compareRange.to
  );
  const aggregatedCurrent = aggregateDayPoints(
    sites.map((s) => (bulk.get(s.id) ?? []).filter((r) => r.date >= period.from && r.date <= period.to))
  );
  const aggregatedCompare = aggregateDayPoints(sites.map((s) => compareBulk.get(s.id) ?? []));
  const shareOf = (points: typeof aggregatedCurrent) => {
    const s = points.reduce((a, p) => a + p.sessions, 0);
    const bounced = points.reduce((a, p) => a + p.organicBounces + p.directBounces, 0);
    return s > 0 ? bounced / s : 0;
  };
  const lowEngagementShare = shareOf(aggregatedCurrent);
  const lowEngagementShareChangePct = pctChange(lowEngagementShare, shareOf(aggregatedCompare));

  return {
    periodFrom: period.from,
    periodTo: period.to,
    totalSessions,
    totalExcessSessions,
    estimatedBotSharePct,
    anomalies,
    lowEngagementShare,
    lowEngagementShareChangePct,
  };
}
