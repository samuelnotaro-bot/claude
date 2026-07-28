import { getSites, getSnapshotsForSites, type SiteRecord } from "./repo.js";
import { flagAnomalies, type AnomalyChannel } from "./anomaly.js";
import { aggregateDayPoints } from "./trends.js";
import type { SnapshotRow } from "./repo.js";
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

export interface TrafficSpikeSite {
  siteId: string;
  siteName: string;
  sessions: number;
  averageSessions: number;
}

export interface TrafficSpikeEntry {
  date: string;
  sessions: number;
  /** Average daily sessions (all sites) over the selected period, for context. */
  averageSessions: number;
  organicShare: number;
  directShare: number;
  /** Sites whose own sessions that day were notably above their own period average -- "quels sites sont concernés". */
  sites: TrafficSpikeSite[];
}

export interface BotSignalResult {
  periodFrom: string;
  periodTo: string;
  totalSessions: number;
  totalExcessSessions: number;
  /** Share of measured traffic in the period attributed to flagged organic/direct floods (null if there's no traffic to divide by). */
  estimatedBotSharePct: number | null;
  anomalies: BotAnomalyEntry[];
  /**
   * Always-available "top traffic growth days" for the selected period (day
   * vs. period average, with organic/direct split and the sites involved) --
   * unlike `anomalies`, this doesn't require 14-56 days of trailing baseline
   * or the strict channel-concentration signature, so it still surfaces
   * something on a short history or a spike that doesn't fit that exact
   * pattern.
   */
  trafficSpikes: TrafficSpikeEntry[];
  /** Secondary, softer signal: trend of low-engagement (bounced) organic/direct sessions vs the previous period. */
  lowEngagementShare: number;
  lowEngagementShareChangePct: number | null;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

// A day must beat the period's own daily average by at least this much to
// count as a "spike" worth listing -- deliberately lenient (no statistical
// baseline requirement) compared to anomaly.ts's flood detector.
const SPIKE_MIN_RATIO_OVER_AVERAGE = 1.15;
const SPIKE_SITE_MIN_RATIO_OVER_AVERAGE = 1.3;
const MAX_SPIKES = 8;
const MAX_SITES_PER_SPIKE = 5;

function computeTrafficSpikes(sites: SiteRecord[], rowsBySite: Map<string, SnapshotRow[]>, from: string, to: string): TrafficSpikeEntry[] {
  const inRangeBySite = new Map<string, SnapshotRow[]>();
  for (const site of sites) {
    inRangeBySite.set(
      site.id,
      (rowsBySite.get(site.id) ?? []).filter((r) => r.date >= from && r.date <= to)
    );
  }

  const global = aggregateDayPoints(sites.map((s) => inRangeBySite.get(s.id) ?? []));
  if (global.length < 3) return []; // too short a period for "average" to mean anything

  const globalAverage = mean(global.map((p) => p.sessions));
  if (globalAverage <= 0) return [];

  const siteAverages = new Map<string, number>();
  for (const site of sites) {
    siteAverages.set(site.id, mean((inRangeBySite.get(site.id) ?? []).map((r) => r.sessions)));
  }

  const spikes: TrafficSpikeEntry[] = [];
  for (const p of global) {
    if (p.sessions < globalAverage * SPIKE_MIN_RATIO_OVER_AVERAGE) continue;

    const sitesInvolved: TrafficSpikeSite[] = [];
    for (const site of sites) {
      const row = (inRangeBySite.get(site.id) ?? []).find((r) => r.date === p.date);
      const siteAvg = siteAverages.get(site.id) ?? 0;
      if (!row || siteAvg <= 0) continue;
      if (row.sessions >= siteAvg * SPIKE_SITE_MIN_RATIO_OVER_AVERAGE) {
        sitesInvolved.push({ siteId: site.id, siteName: site.name, sessions: row.sessions, averageSessions: Math.round(siteAvg) });
      }
    }
    sitesInvolved.sort((a, b) => b.sessions - b.averageSessions - (a.sessions - a.averageSessions)); // descending excess over each site's own average

    spikes.push({
      date: p.date,
      sessions: p.sessions,
      averageSessions: Math.round(globalAverage),
      organicShare: p.sessions > 0 ? p.channels.organic / p.sessions : 0,
      directShare: p.sessions > 0 ? p.channels.direct / p.sessions : 0,
      sites: sitesInvolved.slice(0, MAX_SITES_PER_SPIKE),
    });
  }

  spikes.sort((a, b) => b.sessions - b.averageSessions - (a.sessions - a.averageSessions));
  return spikes.slice(0, MAX_SPIKES);
}

/**
 * Drives the dedicated "Bots" tab: lists large organic/direct traffic swings
 * (see anomaly.ts -- generalized to flag either channel, not just organic),
 * quantifies the excess volume as a share of total measured traffic, a
 * lenient "top traffic growth days" list that doesn't need a long baseline,
 * plus a softer secondary signal (bounce-heavy sessions on organic/direct).
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

  const trafficSpikes = computeTrafficSpikes(sites, bulk, period.from, period.to);

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
    const bounced = points.reduce((a, p) => a + (p.organicBounces ?? 0) + (p.directBounces ?? 0), 0);
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
    trafficSpikes,
    lowEngagementShare,
    lowEngagementShareChangePct,
  };
}
