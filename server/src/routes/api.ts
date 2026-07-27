import type { FastifyInstance } from "fastify";
import { getSites, getSnapshotsForSite, getLatestSynthesis, getSynthesisHistory, getGeoMismatches, type SnapshotRow } from "../repo.js";
import { runTrendAnalysis, runSynthesis } from "../analysis.js";
import { toDayPoints, aggregateDayPoints } from "../trends.js";
import { excludeAnomalies, flagAnomalies } from "../anomaly.js";
import { checkGeoMismatches } from "../geoMismatch.js";
import type { Continent } from "../continent.js";

function lastNDaysRange(n: number): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - n);
  return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
}

// Must be >= anomaly.ts's BASELINE_WINDOW so there's enough trailing history to
// tell a real anomaly from noise for every day in the requested window.
const ANOMALY_BASELINE_PADDING_DAYS = 28;

/**
 * Fetches a site's recent snapshots with traffic-flood anomalies (see anomaly.ts)
 * removed, fetching extra trailing history so the anomaly detector has a real
 * baseline to compare against. Returns only the last `windowDays` clean rows, plus
 * how many of the excluded days fall inside that window (for the UI badge).
 */
async function cleanRowsForSite(siteId: string, windowDays: number): Promise<{ rows: SnapshotRow[]; excludedInWindow: number }> {
  const [from, to] = lastNDaysRange(windowDays + ANOMALY_BASELINE_PADDING_DAYS);
  const raw = await getSnapshotsForSite(siteId, from, to);
  const { clean, anomalies } = excludeAnomalies(raw);
  const [windowFrom] = lastNDaysRange(windowDays);
  const excludedInWindow = anomalies.filter((a) => a.date >= windowFrom).length;
  return { rows: clean.slice(-windowDays), excludedInWindow };
}

/**
 * % change vs the previous period, or null when there isn't enough history to compare
 * fairly (a partial previous period -- e.g. picking "90 derniers jours" before 180 days
 * of data have accumulated -- would otherwise produce a wildly misleading percentage).
 */
function pctChange(current: number, previous: number, previousPoints: unknown[], periodDays: number): number | null {
  if (previousPoints.length < periodDays) return null;
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/sites", async () => {
    return getSites();
  });

  // Presets shown in the UI period selector. An unrecognized/missing value falls
  // back to 7 days (previous default behavior).
  const VALID_PERIOD_DAYS = new Set([7, 30, 90, 365]);
  function periodDaysFromQuery(days?: string): number {
    const n = days ? Number(days) : 7;
    return VALID_PERIOD_DAYS.has(n) ? n : 7;
  }

  app.get<{ Querystring: { days?: string } }>("/api/sites/summary", async (req) => {
    const periodDays = periodDaysFromQuery(req.query.days);
    const sites = await getSites();
    return Promise.all(
      sites.map(async (s) => {
        const { rows, excludedInWindow } = await cleanRowsForSite(s.id, periodDays * 2);
        const series = toDayPoints(rows);
        const current = series.slice(-periodDays);
        const previous = series.slice(-periodDays * 2, -periodDays);
        const sum = (pts: typeof series, pick: (p: (typeof series)[number]) => number) => pts.reduce((a, p) => a + pick(p), 0);
        const sessions = sum(current, (p) => p.sessions);
        const prevSessions = sum(previous, (p) => p.sessions);
        const conversions = sum(current, (p) => p.goalConversions);
        return {
          id: s.id,
          name: s.name,
          region: s.continent,
          sessionsLast7d: sessions,
          sessionsChangePct: pctChange(sessions, prevSessions, previous, periodDays),
          conversionsLast7d: conversions,
          conversionRateLast7d: sessions > 0 ? conversions / sessions : 0,
          excludedAnomalyDays: excludedInWindow,
        };
      })
    );
  });

  app.get<{ Querystring: { days?: string } }>("/api/regions", async (req) => {
    const periodDays = periodDaysFromQuery(req.query.days);
    const sites = await getSites();
    const byRegion = new Map<Continent, string[]>();
    for (const s of sites) {
      const list = byRegion.get(s.continent) ?? [];
      list.push(s.id);
      byRegion.set(s.continent, list);
    }
    const result = [];
    for (const [region, siteIds] of byRegion) {
      const cleaned = await Promise.all(siteIds.map((id) => cleanRowsForSite(id, periodDays * 2)));
      const rows = cleaned.map((c) => c.rows);
      const excludedAnomalyDays = cleaned.reduce((a, c) => a + c.excludedInWindow, 0);
      const series = aggregateDayPoints(rows);
      const current = series.slice(-periodDays);
      const previous = series.slice(-periodDays * 2, -periodDays);
      const sum = (pts: typeof series, pick: (p: (typeof series)[number]) => number) => pts.reduce((a, p) => a + pick(p), 0);
      const sessions = sum(current, (p) => p.sessions);
      const prevSessions = sum(previous, (p) => p.sessions);
      const conversions = sum(current, (p) => p.goalConversions);
      result.push({
        region,
        siteCount: siteIds.length,
        sessionsLast7d: sessions,
        sessionsChangePct: pctChange(sessions, prevSessions, previous, periodDays),
        conversionsLast7d: conversions,
        conversionRateLast7d: sessions > 0 ? conversions / sessions : 0,
        excludedAnomalyDays,
      });
    }
    result.sort((a, b) => b.sessionsLast7d - a.sessionsLast7d);
    return result;
  });

  app.get<{ Querystring: { days?: string } }>("/api/overview", async (req) => {
    const periodDays = periodDaysFromQuery(req.query.days);
    const sites = await getSites();
    const cleaned = await Promise.all(sites.map((s) => cleanRowsForSite(s.id, periodDays * 2)));
    const rows = cleaned.map((c) => c.rows);
    const excludedAnomalyDays = cleaned.reduce((a, c) => a + c.excludedInWindow, 0);
    const series = aggregateDayPoints(rows);
    const current = series.slice(-periodDays);
    const previous = series.slice(-periodDays * 2, -periodDays);
    const sum = (pts: typeof series, pick: (p: (typeof series)[number]) => number) => pts.reduce((a, p) => a + pick(p), 0);
    const sessions = sum(current, (p) => p.sessions);
    const prevSessions = sum(previous, (p) => p.sessions);
    const conversions = sum(current, (p) => p.goalConversions);
    const prevConversions = sum(previous, (p) => p.goalConversions);
    const conversionRate = sessions > 0 ? conversions / sessions : 0;
    const prevConversionRate = prevSessions > 0 ? prevConversions / prevSessions : 0;
    const rfq = sum(current, (p) => p.rfqConversions);
    const prevRfq = sum(previous, (p) => p.rfqConversions);
    const support = sum(current, (p) => p.supportConversions);
    const prevSupport = sum(previous, (p) => p.supportConversions);
    const downloads = sum(current, (p) => p.downloads);
    const prevDownloads = sum(previous, (p) => p.downloads);
    return {
      periodDays,
      siteCount: sites.length,
      sessionsLast7d: sessions,
      sessionsChangePct: pctChange(sessions, prevSessions, previous, periodDays),
      conversionsLast7d: conversions,
      conversionsChangePct: pctChange(conversions, prevConversions, previous, periodDays),
      conversionRateLast7d: conversionRate,
      conversionRateChangePct: pctChange(conversionRate, prevConversionRate, previous, periodDays),
      rfqLast7d: rfq,
      rfqChangePct: pctChange(rfq, prevRfq, previous, periodDays),
      supportLast7d: support,
      supportChangePct: pctChange(support, prevSupport, previous, periodDays),
      downloadsLast7d: downloads,
      downloadsChangePct: pctChange(downloads, prevDownloads, previous, periodDays),
      series,
      excludedAnomalyDays,
    };
  });

  app.get<{ Querystring: { scope: "site" | "region" | "global"; id?: string; days?: string } }>(
    "/api/series",
    async (req, reply) => {
      const { scope, id, days } = req.query;
      const n = days ? Number(days) : 60;
      const [, to] = lastNDaysRange(n);

      // This endpoint feeds the detail/analyst view: it intentionally returns raw,
      // unfiltered data (unlike sites/summary, regions, overview) but flags
      // anomalous days so the chart can highlight them instead of silently hiding them.
      const [paddedFrom] = lastNDaysRange(n + ANOMALY_BASELINE_PADDING_DAYS);

      if (scope === "site") {
        if (!id) return reply.code(400).send({ error: "id is required for scope=site" });
        const raw = await getSnapshotsForSite(id, paddedFrom, to);
        const anomalousDates = new Set(flagAnomalies(raw).keys());
        return toDayPoints(raw, anomalousDates).slice(-n);
      }
      const sites = await getSites();
      const filtered = scope === "region" ? sites.filter((s) => s.continent === id) : sites;
      const rows = await Promise.all(filtered.map((s) => getSnapshotsForSite(s.id, paddedFrom, to)));
      const anomalousDatesBySite = rows.map((r) => new Set(flagAnomalies(r).keys()));
      return aggregateDayPoints(rows, anomalousDatesBySite).slice(-n);
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
    return getLatestSynthesis();
  });

  app.get("/api/geo-mismatches", async () => {
    return getGeoMismatches();
  });

  app.post("/api/geo-mismatches/check", async () => {
    return checkGeoMismatches();
  });
}
