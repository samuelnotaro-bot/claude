import type { FastifyInstance } from "fastify";
import {
  getSites,
  getSnapshotsForSites,
  getEarliestSnapshotDate,
  getLatestSynthesis,
  getSynthesisHistory,
  getGeoMismatches,
} from "../repo.js";
import { runTrendAnalysis, runSynthesis } from "../analysis.js";
import { toDayPoints, aggregateDayPoints, aggregateDayPointSeries, zeroFillDayPoints, type DayPoint } from "../trends.js";
import { excludeAnomalies, flagAnomalies } from "../anomaly.js";
import { checkGeoMismatches } from "../geoMismatch.js";
import { computeBotSignal } from "../bots.js";
import { getBackfillStatus } from "../backfillStatus.js";
import { config } from "../config.js";
import type { Continent } from "../continent.js";
import { cached, clearCache } from "../cache.js";
import {
  parsePeriodQuery,
  resolveComparisonRange,
  pctChange,
  hasEnoughHistoryFor,
  addDaysIso,
  ANOMALY_BASELINE_PADDING_DAYS,
  type PeriodQuery,
} from "../period.js";

function sum(points: DayPoint[], pick: (p: DayPoint) => number): number {
  return points.reduce((a, p) => a + pick(p), 0);
}

/**
 * Loads, cleans (traffic-flood anomalies excluded -- see anomaly.ts) and
 * zero-fills (see trends.zeroFillDayPoints) the current period and its
 * comparison period for a set of sites, in a single bulk DB round trip
 * instead of one query per site -- the main fix for slow dashboard loads.
 */
async function loadCleanSeriesBySite(
  siteIds: string[],
  period: PeriodQuery
): Promise<{
  currentBySite: Map<string, DayPoint[]>;
  compareBySite: Map<string, DayPoint[]>;
  excludedInCurrentBySite: Map<string, number>;
}> {
  const compareRange = resolveComparisonRange(period);
  const spanFrom = addDaysIso(compareRange.from, -ANOMALY_BASELINE_PADDING_DAYS);
  const bulk = await getSnapshotsForSites(siteIds, spanFrom, period.to);

  const currentBySite = new Map<string, DayPoint[]>();
  const compareBySite = new Map<string, DayPoint[]>();
  const excludedInCurrentBySite = new Map<string, number>();

  for (const id of siteIds) {
    const raw = bulk.get(id) ?? [];
    const { clean, anomalies } = excludeAnomalies(raw);
    const inRange = (date: string, from: string, to: string) => date >= from && date <= to;

    const currentRaw = clean.filter((r) => inRange(r.date, period.from, period.to));
    currentBySite.set(id, zeroFillDayPoints(toDayPoints(currentRaw), period.from, period.to));

    const compareRaw = clean.filter((r) => inRange(r.date, compareRange.from, compareRange.to));
    compareBySite.set(id, zeroFillDayPoints(toDayPoints(compareRaw), compareRange.from, compareRange.to));

    excludedInCurrentBySite.set(id, anomalies.filter((a) => inRange(a.date, period.from, period.to)).length);
  }

  return { currentBySite, compareBySite, excludedInCurrentBySite };
}

interface KpiTotals {
  sessions: number;
  conversions: number;
  conversionRate: number;
  rfq: number;
  support: number;
  downloads: number;
  organicSessions: number;
  aiReferralSessions: number;
  lowEngagementSessions: number;
  lowEngagementShare: number;
  searchConsoleClicks: number;
  searchConsoleImpressions: number;
}

function totalsOf(series: DayPoint[]): KpiTotals {
  const sessions = sum(series, (p) => p.sessions);
  const conversions = sum(series, (p) => p.goalConversions);
  const lowEngagementSessions = sum(series, (p) => p.organicBounces + p.directBounces);
  return {
    sessions,
    conversions,
    conversionRate: sessions > 0 ? conversions / sessions : 0,
    rfq: sum(series, (p) => p.rfqConversions),
    support: sum(series, (p) => p.supportConversions),
    downloads: sum(series, (p) => p.downloads),
    organicSessions: sum(series, (p) => p.channels.organic),
    aiReferralSessions: sum(series, (p) => p.aiReferralSessions),
    lowEngagementSessions,
    lowEngagementShare: sessions > 0 ? lowEngagementSessions / sessions : 0,
    searchConsoleClicks: sum(series, (p) => p.searchConsoleClicks),
    searchConsoleImpressions: sum(series, (p) => p.searchConsoleImpressions),
  };
}

/** Pairs each current KPI total with its %-change vs the comparison period (null when there isn't enough history yet -- see period.ts). */
function withChanges(current: KpiTotals, previous: KpiTotals, historyOk: boolean) {
  const chg = (a: number, b: number) => (historyOk ? pctChange(a, b) : null);
  return {
    sessions: current.sessions,
    sessionsChangePct: chg(current.sessions, previous.sessions),
    conversions: current.conversions,
    conversionsChangePct: chg(current.conversions, previous.conversions),
    conversionRate: current.conversionRate,
    conversionRateChangePct: chg(current.conversionRate, previous.conversionRate),
    rfq: current.rfq,
    rfqChangePct: chg(current.rfq, previous.rfq),
    support: current.support,
    supportChangePct: chg(current.support, previous.support),
    downloads: current.downloads,
    downloadsChangePct: chg(current.downloads, previous.downloads),
    organicSessions: current.organicSessions,
    organicSessionsChangePct: chg(current.organicSessions, previous.organicSessions),
    aiReferralSessions: current.aiReferralSessions,
    aiReferralSessionsChangePct: chg(current.aiReferralSessions, previous.aiReferralSessions),
    lowEngagementSessions: current.lowEngagementSessions,
    lowEngagementShare: current.lowEngagementShare,
    lowEngagementShareChangePct: chg(current.lowEngagementShare, previous.lowEngagementShare),
    searchConsoleClicks: current.searchConsoleClicks,
    searchConsoleClicksChangePct: chg(current.searchConsoleClicks, previous.searchConsoleClicks),
    searchConsoleImpressions: current.searchConsoleImpressions,
  };
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true, mode: config.mode }));

  app.get("/api/backfill/status", async () => getBackfillStatus());

  app.get("/api/sites", async () => {
    return getSites();
  });

  app.get<{ Querystring: { from?: string; to?: string; compare?: string; days?: string } }>("/api/sites/summary", async (req) => {
    const period = parsePeriodQuery(req.query);
    const cacheKey = `sites:${period.from}:${period.to}:${period.compare}`;
    return cached(cacheKey, async () => {
      const [sites, earliestDate] = await Promise.all([getSites(), getEarliestSnapshotDate()]);
      const compareRange = resolveComparisonRange(period);
      const historyOk = hasEnoughHistoryFor(compareRange.from, earliestDate);
      const { currentBySite, compareBySite, excludedInCurrentBySite } = await loadCleanSeriesBySite(
        sites.map((s) => s.id),
        period
      );
      return sites.map((s) => {
        const current = totalsOf(currentBySite.get(s.id) ?? []);
        const previous = totalsOf(compareBySite.get(s.id) ?? []);
        const changes = withChanges(current, previous, historyOk);
        return {
          id: s.id,
          name: s.name,
          region: s.continent,
          ...changes,
          excludedAnomalyDays: excludedInCurrentBySite.get(s.id) ?? 0,
        };
      });
    });
  });

  app.get<{ Querystring: { from?: string; to?: string; compare?: string; days?: string } }>("/api/regions", async (req) => {
    const period = parsePeriodQuery(req.query);
    const cacheKey = `regions:${period.from}:${period.to}:${period.compare}`;
    return cached(cacheKey, async () => {
      const [sites, earliestDate] = await Promise.all([getSites(), getEarliestSnapshotDate()]);
      const compareRange = resolveComparisonRange(period);
      const historyOk = hasEnoughHistoryFor(compareRange.from, earliestDate);
      const byRegion = new Map<Continent, string[]>();
      for (const s of sites) {
        const list = byRegion.get(s.continent) ?? [];
        list.push(s.id);
        byRegion.set(s.continent, list);
      }
      const { currentBySite, compareBySite, excludedInCurrentBySite } = await loadCleanSeriesBySite(
        sites.map((s) => s.id),
        period
      );
      const result = [];
      for (const [region, siteIds] of byRegion) {
        const currentSeries = aggregateDayPointSeries(siteIds.map((id) => currentBySite.get(id) ?? []));
        const compareSeries = aggregateDayPointSeries(siteIds.map((id) => compareBySite.get(id) ?? []));
        const current = totalsOf(currentSeries);
        const previous = totalsOf(compareSeries);
        const changes = withChanges(current, previous, historyOk);
        const excludedAnomalyDays = siteIds.reduce((a, id) => a + (excludedInCurrentBySite.get(id) ?? 0), 0);
        result.push({ region, siteCount: siteIds.length, ...changes, excludedAnomalyDays });
      }
      result.sort((a, b) => b.sessions - a.sessions);
      return result;
    });
  });

  app.get<{ Querystring: { from?: string; to?: string; compare?: string; days?: string } }>("/api/overview", async (req) => {
    const period = parsePeriodQuery(req.query);
    const cacheKey = `overview:${period.from}:${period.to}:${period.compare}`;
    return cached(cacheKey, async () => {
      const [sites, earliestDate] = await Promise.all([getSites(), getEarliestSnapshotDate()]);
      const compareRange = resolveComparisonRange(period);
      const historyOk = hasEnoughHistoryFor(compareRange.from, earliestDate);
      const { currentBySite, compareBySite, excludedInCurrentBySite } = await loadCleanSeriesBySite(
        sites.map((s) => s.id),
        period
      );
      const currentSeries = aggregateDayPointSeries(sites.map((s) => currentBySite.get(s.id) ?? []));
      const compareSeries = aggregateDayPointSeries(sites.map((s) => compareBySite.get(s.id) ?? []));
      const current = totalsOf(currentSeries);
      const previous = totalsOf(compareSeries);
      const changes = withChanges(current, previous, historyOk);
      const excludedAnomalyDays = sites.reduce((a, s) => a + (excludedInCurrentBySite.get(s.id) ?? 0), 0);

      return {
        periodFrom: period.from,
        periodTo: period.to,
        compare: period.compare,
        comparisonFrom: compareRange.from,
        comparisonTo: compareRange.to,
        siteCount: sites.length,
        ...changes,
        series: currentSeries,
        excludedAnomalyDays,
      };
    });
  });

  app.get<{ Querystring: { scope: "site" | "region" | "global"; id?: string; from?: string; to?: string; days?: string } }>(
    "/api/series",
    async (req, reply) => {
      const { scope, id } = req.query;
      const period = parsePeriodQuery(req.query);
      const paddedFrom = addDaysIso(period.from, -ANOMALY_BASELINE_PADDING_DAYS);

      // This endpoint feeds the detail/analyst view: it intentionally returns raw,
      // unfiltered data (unlike sites/summary, regions, overview) but flags
      // anomalous days so the chart can highlight them instead of silently hiding them.
      if (scope === "site") {
        if (!id) return reply.code(400).send({ error: "id is required for scope=site" });
        const bulk = await getSnapshotsForSites([id], paddedFrom, period.to);
        const raw = bulk.get(id) ?? [];
        const anomalousDates = new Set(flagAnomalies(raw).keys());
        const inRange = raw.filter((r) => r.date >= period.from && r.date <= period.to);
        return zeroFillDayPoints(toDayPoints(inRange, anomalousDates), period.from, period.to);
      }
      const sites = await getSites();
      const filtered = scope === "region" ? sites.filter((s) => s.continent === id) : sites;
      const bulk = await getSnapshotsForSites(
        filtered.map((s) => s.id),
        paddedFrom,
        period.to
      );
      const rowsBySite = filtered.map((s) => bulk.get(s.id) ?? []);
      const anomalousDatesBySite = rowsBySite.map((r) => new Set(flagAnomalies(r).keys()));
      const inRangeBySite = rowsBySite.map((rows) => rows.filter((r) => r.date >= period.from && r.date <= period.to));
      const aggregated = aggregateDayPoints(inRangeBySite, anomalousDatesBySite);
      return zeroFillDayPoints(aggregated, period.from, period.to);
    }
  );

  app.get<{ Querystring: { limit?: string } }>("/api/findings", async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const { findings } = await runTrendAnalysis();
    return findings.slice(0, limit);
  });

  app.get("/api/synthesis/latest", async () => {
    return getLatestSynthesis();
  });

  app.get<{ Querystring: { limit?: string } }>("/api/synthesis/history", async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    return getSynthesisHistory(limit);
  });

  app.post("/api/synthesis/generate", async () => {
    await runSynthesis();
    clearCache();
    return getLatestSynthesis();
  });

  app.get("/api/geo-mismatches", async () => {
    return getGeoMismatches();
  });

  app.post("/api/geo-mismatches/check", async () => {
    const result = await checkGeoMismatches();
    clearCache();
    return result;
  });

  app.get<{ Querystring: { from?: string; to?: string; days?: string } }>("/api/bots", async (req) => {
    const period = parsePeriodQuery(req.query);
    const cacheKey = `bots:${period.from}:${period.to}`;
    return cached(cacheKey, () => computeBotSignal(period));
  });
}
