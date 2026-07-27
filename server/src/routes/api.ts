import type { FastifyInstance } from "fastify";
import { getSites, getSnapshotsForSite, getLatestSynthesis, getSynthesisHistory } from "../repo.js";
import { runTrendAnalysis, runSynthesis } from "../analysis.js";
import { toDayPoints, aggregateDayPoints } from "../trends.js";
import type { Continent } from "../continent.js";

function lastNDaysRange(n: number): [string, string] {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - n);
  return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/sites", async () => {
    return getSites();
  });

  app.get("/api/sites/summary", async () => {
    const sites = getSites();
    const [from, to] = lastNDaysRange(14);
    return sites.map((s) => {
      const series = toDayPoints(getSnapshotsForSite(s.id, from, to));
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
      };
    });
  });

  app.get("/api/continents", async () => {
    const sites = getSites();
    const [from, to] = lastNDaysRange(14);
    const byContinent = new Map<Continent, string[]>();
    for (const s of sites) {
      const list = byContinent.get(s.continent) ?? [];
      list.push(s.id);
      byContinent.set(s.continent, list);
    }
    const result = [];
    for (const [continent, siteIds] of byContinent) {
      const rows = siteIds.map((id) => getSnapshotsForSite(id, from, to));
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
      });
    }
    result.sort((a, b) => b.sessionsLast7d - a.sessionsLast7d);
    return result;
  });

  app.get("/api/overview", async () => {
    const sites = getSites();
    const [from, to] = lastNDaysRange(14);
    const rows = sites.map((s) => getSnapshotsForSite(s.id, from, to));
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
    };
  });

  app.get<{ Querystring: { scope: "site" | "continent" | "global"; id?: string; days?: string } }>(
    "/api/series",
    async (req, reply) => {
      const { scope, id, days } = req.query;
      const n = days ? Number(days) : 60;
      const [from, to] = lastNDaysRange(n);

      if (scope === "site") {
        if (!id) return reply.code(400).send({ error: "id is required for scope=site" });
        return toDayPoints(getSnapshotsForSite(id, from, to));
      }
      const sites = getSites();
      const filtered = scope === "continent" ? sites.filter((s) => s.continent === id) : sites;
      const rows = filtered.map((s) => getSnapshotsForSite(s.id, from, to));
      return aggregateDayPoints(rows);
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
