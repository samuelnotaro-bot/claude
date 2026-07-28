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
import { generateSynthesis } from "../synthesis.js";
import {
  toDayPoints,
  aggregateDayPoints,
  aggregateDayPointSeries,
  zeroFillDayPoints,
  METRIC_LABELS,
  type DayPoint,
  type Finding,
  type FindingMetric,
  type Scope,
} from "../trends.js";
import { excludeAnomalies, flagAnomalies } from "../anomaly.js";
import { checkGeoMismatches } from "../geoMismatch.js";
import { computeBotSignal } from "../bots.js";
import { backfillGaps } from "../sync.js";
import { probeOptionalMetrics } from "../piwik/client.js";
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
 * Sums an optional (Piwik-integration-dependent) field across a period,
 * staying null only when every single point is null (see trends.DayPoint) --
 * a null total means "this KPI has no data at all for this period", which
 * the UI shows as "non disponible" instead of a misleading 0.
 */
function sumNullable(points: DayPoint[], pick: (p: DayPoint) => number | null): number | null {
  let total: number | null = null;
  for (const p of points) {
    const v = pick(p);
    if (v === null) continue;
    total = (total ?? 0) + v;
  }
  return total;
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
  // These 3 (and lowEngagementSessions/Share, derived from organic/directBounces)
  // are nullable: null means "no data available for this period" (every
  // contributing day/site failed to fetch this metric -- see trends.DayPoint),
  // shown as "non disponible" in the UI instead of a misleading 0.
  aiReferralSessions: number | null;
  lowEngagementSessions: number | null;
  lowEngagementShare: number | null;
  searchConsoleClicks: number | null;
  searchConsoleImpressions: number | null;
}

function totalsOf(series: DayPoint[]): KpiTotals {
  const sessions = sum(series, (p) => p.sessions);
  const conversions = sum(series, (p) => p.goalConversions);
  const organicBouncesSum = sumNullable(series, (p) => p.organicBounces);
  const directBouncesSum = sumNullable(series, (p) => p.directBounces);
  const lowEngagementSessions =
    organicBouncesSum === null && directBouncesSum === null ? null : (organicBouncesSum ?? 0) + (directBouncesSum ?? 0);
  return {
    sessions,
    conversions,
    conversionRate: sessions > 0 ? conversions / sessions : 0,
    rfq: sum(series, (p) => p.rfqConversions),
    support: sum(series, (p) => p.supportConversions),
    downloads: sum(series, (p) => p.downloads),
    organicSessions: sum(series, (p) => p.channels.organic),
    aiReferralSessions: sumNullable(series, (p) => p.aiReferralSessions),
    lowEngagementSessions,
    lowEngagementShare: lowEngagementSessions === null ? null : sessions > 0 ? lowEngagementSessions / sessions : 0,
    searchConsoleClicks: sumNullable(series, (p) => p.searchConsoleClicks),
    searchConsoleImpressions: sumNullable(series, (p) => p.searchConsoleImpressions),
  };
}

/** Pairs each current KPI total with its %-change vs the comparison period (null when there isn't enough history yet, or when either side is unavailable -- see period.ts). */
function withChanges(current: KpiTotals, previous: KpiTotals, historyOk: boolean) {
  const chg = (a: number | null, b: number | null) => (historyOk ? pctChange(a, b) : null);
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

const PERIOD_FINDING_METRICS: { key: keyof KpiTotals; metric: FindingMetric; minAbsChangePct: number }[] = [
  { key: "sessions", metric: "sessions", minAbsChangePct: 0.12 },
  { key: "conversionRate", metric: "conversionRate", minAbsChangePct: 0.15 },
  { key: "conversions", metric: "goalConversions", minAbsChangePct: 0.15 },
  { key: "organicSessions", metric: "organicSessions", minAbsChangePct: 0.15 },
  { key: "aiReferralSessions", metric: "aiReferralSessions", minAbsChangePct: 0.2 },
  { key: "lowEngagementShare", metric: "lowEngagementShare", minAbsChangePct: 0.15 },
  { key: "searchConsoleClicks", metric: "searchConsoleClicks", minAbsChangePct: 0.15 },
  { key: "rfq", metric: "rfq", minAbsChangePct: 0.15 },
  { key: "support", metric: "support", minAbsChangePct: 0.15 },
  { key: "downloads", metric: "downloads", minAbsChangePct: 0.15 },
];

/**
 * Findings scoped to exactly the period/comparison the user selected, unlike
 * /api/findings (a fixed rolling 7-vs-7-day statistical view used only for
 * the cron-generated weekly synthesis history). Built directly from the same
 * KpiTotals already computed for the KPI tiles, so the "Analyse & plan
 * d'action" panels never show a different window than the numbers next to
 * them. No z-score/baseline requirement (arbitrary custom periods don't
 * necessarily have 8 weeks of trailing history to compute one from) --  just
 * a minimum relative-change threshold per metric.
 */
function buildPeriodFindings(scope: Scope, entityId: string, entityName: string, current: KpiTotals, previous: KpiTotals, historyOk: boolean): Finding[] {
  if (!historyOk) return [];
  const findings: Finding[] = [];
  for (const { key, metric, minAbsChangePct } of PERIOD_FINDING_METRICS) {
    const currentVal = current[key];
    const previousVal = previous[key];
    if (currentVal === null || previousVal === null) continue;
    const changePct = pctChange(currentVal, previousVal);
    if (changePct === null || Math.abs(changePct) < minAbsChangePct) continue;
    findings.push({
      scope,
      entityId,
      entityName,
      metric,
      label: METRIC_LABELS[metric],
      direction: changePct >= 0 ? "up" : "down",
      changePct,
      current: currentVal,
      previous: previousVal,
      impactScore: Math.abs(changePct) * Math.log10(Math.max(currentVal, previousVal, 1) + 1),
    });
  }
  return findings.sort((a, b) => b.impactScore - a.impactScore);
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
          findings: buildPeriodFindings("site", s.id, s.name, current, previous, historyOk),
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
        result.push({
          region,
          siteCount: siteIds.length,
          ...changes,
          excludedAnomalyDays,
          findings: buildPeriodFindings("continent", region, region, current, previous, historyOk),
        });
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
      const findings = buildPeriodFindings("global", "global", "Tous sites", current, previous, historyOk);

      // Synthesis bullets generated on the fly for exactly this period (reuses
      // the same rule engine as the cron-generated weekly synthesis_history,
      // see synthesis.ts) -- distinct from that stored weekly log, which stays
      // a fixed cadence for the dedicated Synthèses tab/history.
      const synthesisBullets = historyOk
        ? generateSynthesis(findings, {
            totalSessions: current.sessions,
            prevTotalSessions: previous.sessions,
            conversionRate: current.conversionRate,
            prevConversionRate: previous.conversionRate,
          }).bullets
        : [];

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
        findings,
        synthesisBullets,
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

  app.post<{ Querystring: { from?: string; to?: string; days?: string } }>("/api/geo-mismatches/check", async (req) => {
    const period = parsePeriodQuery(req.query);
    const result = await checkGeoMismatches(period.from, period.to);
    clearCache();
    return result;
  });

  app.get<{ Querystring: { from?: string; to?: string; days?: string } }>("/api/bots", async (req) => {
    const period = parsePeriodQuery(req.query);
    const cacheKey = `bots:${period.from}:${period.to}`;
    return cached(cacheKey, () => computeBotSignal(period));
  });

  // Manual trigger for the gap-scan backfill (see sync.ts#backfillGaps) so a
  // hole in the data (e.g. "no data July 1-19") can be closed on demand
  // instead of waiting for the next boot/wake-up.
  app.post("/api/data/fill-gaps", async () => {
    return backfillGaps();
  });

  // Runs the 3 optional Piwik Pro queries (AI-referral, channel bounces,
  // Search Console) for one real site and reports success/failure + the raw
  // error per query -- so a "0"/"non disponible" KPI on the dashboard can be
  // diagnosed directly instead of only ever showing up in server logs.
  // Meaningless in demo mode (no real Piwik Pro calls happen at all).
  app.get("/api/diagnostics/optional-metrics", async (_req, reply) => {
    if (config.mode !== "live") {
      return reply.code(400).send({ error: "Diagnostics only meaningful in PIWIK_MODE=live." });
    }
    const sites = await getSites();
    if (sites.length === 0) return reply.code(404).send({ error: "No tracked sites." });
    const yesterday = addDaysIso(new Date().toISOString().slice(0, 10), -1);
    return probeOptionalMetrics(sites[0].id, sites[0].name, yesterday);
  });
}
