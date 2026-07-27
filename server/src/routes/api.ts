import type { FastifyInstance } from "fastify";
import { getSites, getSnapshotsForSite, getLatestSynthesis, getSynthesisHistory, type SnapshotRow } from "../repo.js";
import { runTrendAnalysis, runSynthesis } from "../analysis.js";
import { toDayPoints, aggregateDayPoints } from "../trends.js";
import { excludeAnomalies, flagAnomalies } from "../anomaly.js";
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
function cleanRowsForSite(siteId: string, windowDays: number): { rows: SnapshotRow[]; excludedInWindow: number } {
  const [from, to] = lastNDaysRange(windowDays + ANOMALY_BASELINE_PADDING_DAYS);
  const raw = getSnapshotsForSite(siteId, from, to);
  const { clean, anomalies } = excludeAnomalies(raw);
  const [windowFrom] = lastNDaysRange(windowDays);
  const excludedInWindow = anomalies.filter((a) => a.date >= windowFrom).length;
  return { rows: clean.slice(-windowDays), excludedInWindow };
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/sites", async () => {
    return getSites();
  });

  app.get("/api/sites/summary", async () => {
    const sites = getSites();
    return sites.map((s) => {
      const { rows, excludedInWindow } = cleanRowsForSite(s.id, 14);
      const series = toDayPoints(rows);
      const last7 = series.slice(-7);
      const prev7 = series.slice(-14, -7);
      const sum = (pts: typeof series, pick: (p: (typeof series)[number]) => number) => pts.reduce((a, p) => a + pick(p), 0);
      const sessions = sum(last7, (p) => p.sessions);
      const prevSessions = sum(prev7, (p) => p.sessions);
      const conversions = sum(last7, (p) => p.goalConversions);
      return {
        id: s.id,
        name: s.name,
        continent: s.continent,
        sessionsLast7d: sessions,
        sessionsChangePct: prevSessions > 0 ? (sessions - prevSessions) / prevSessions : null,
        conversionsLast7d: conversions,
        conversionRateLast7d: sessions > 0 ? conversions / sessions : 0,
        excludedAnomalyDays: excludedInWindow,
      };
    });
  });

  app.get("/api/continents", async () => {
    const sites = getSites();
    const byContinent = new Map<Continent, string[]>();
    for (const s of sites) {
      const list = byContinent.get(s.continent) ?? [];
      list.push(s.id);
      byContinent.set(s.continent, list);
    }
    const result = [];
    for (const [continent, siteIds] of byContinent) {
      const rows: SnapshotRow[][] = [];
      let excludedAnomalyDays = 0;
      for (const id of siteIds) {
        const cleaned = cleanRowsForSite(id, 14);
        rows.push(cleaned.rows);
        excludedAnomalyDays += cleaned.excludedInWindow;
      }
      const series = aggregateDayPoints(rows);
      const last7 = series.slice(-7);
      const prev7 = series.slice(-14, -7);
      const sum = (pts: typeof series, pick: (p: (typeof series)[number]) => number) => pts.reduce((a, p) => a + pick(p), 0);
      const sessions = sum(last7, (p) => p.sessions);
      const prevSessions = sum(prev7, (p) => p.sessions);
      const conversions = sum(last7, (p) => p.goalConversions);
      result.push({
        continent,
        siteCount: siteIds.length,
        sessionsLast7d: sessions,
        sessionsChangePct: prevSessions > 0 ? (sessions - prevSessions) / prevSessions : null,
        conversionsLast7d: conversions,
        conversionRateLast7d: sessions > 0 ? conversions / sessions : 0,
        excludedAnomalyDays,
      });
    }
    result.sort((a, b) => b.sessionsLast7d - a.sessionsLast7d);
    return result;
  });

  app.get("/api/overview", async () => {
    const sites = getSites();
    const rows: SnapshotRow[][] = [];
    let excludedAnomalyDays = 0;
    for (const s of sites) {
      const cleaned = cleanRowsForSite(s.id, 14);
      rows.push(cleaned.rows);
      excludedAnomalyDays += cleaned.excludedInWindow;
    }
    const series = aggregateDayPoints(rows);
    const last7 = series.slice(-7);
    const prev7 = series.slice(-14, -7);
    const sum = (pts: typeof series, pick: (p: (typeof series)[number]) => number) => pts.reduce((a, p) => a + pick(p), 0);
    const sessions = sum(last7, (p) => p.sessions);
    const prevSessions = sum(prev7, (p) => p.sessions);
    const conversions = sum(last7, (p) => p.goalConversions);
    const prevConversions = sum(prev7, (p) => p.goalConversions);
    const conversionRate = sessions > 0 ? conversions / sessions : 0;
    const prevConversionRate = prevSessions > 0 ? prevConversions / prevSessions : 0;
    return {
      siteCount: sites.length,
      sessionsLast7d: sessions,
      sessionsChangePct: prevSessions > 0 ? (sessions - prevSessions) / prevSessions : null,
      conversionsLast7d: conversions,
      conversionsChangePct: prevConversions > 0 ? (conversions - prevConversions) / prevConversions : null,
      conversionRateLast7d: conversionRate,
      conversionRateChangePct: prevConversionRate > 0 ? (conversionRate - prevConversionRate) / prevConversionRate : null,
      series,
      excludedAnomalyDays,
    };
  });

  app.get<{ Querystring: { scope: "site" | "continent" | "global"; id?: string; days?: string } }>(
    "/api/series",
    async (req, reply) => {
      const { scope, id, days } = req.query;
      const n = days ? Number(days) : 60;
      const [from, to] = lastNDaysRange(n);

      // This endpoint feeds the detail/analyst view: it intentionally returns raw,
      // unfiltered data (unlike sites/summary, continents, overview) but flags
      // anomalous days so the chart can highlight them instead of silently hiding them.
      const [paddedFrom] = lastNDaysRange(n + ANOMALY_BASELINE_PADDING_DAYS);

      if (scope === "site") {
        if (!id) return reply.code(400).send({ error: "id is required for scope=site" });
        const raw = getSnapshotsForSite(id, paddedFrom, to);
        const anomalousDates = new Set(flagAnomalies(raw).keys());
        return toDayPoints(raw, anomalousDates).slice(-n);
      }
      const sites = getSites();
      const filtered = scope === "continent" ? sites.filter((s) => s.continent === id) : sites;
      const rows = filtered.map((s) => getSnapshotsForSite(s.id, paddedFrom, to));
      const anomalousDatesBySite = rows.map((r) => new Set(flagAnomalies(r).keys()));
      return aggregateDayPoints(rows, anomalousDatesBySite).slice(-n);
    }
  );

  app.get<{ Querystring: { limit?: string } }>("/api/findings", async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const { findings } = runTrendAnalysis();
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
    runSynthesis();
    return getLatestSynthesis();
  });
}
