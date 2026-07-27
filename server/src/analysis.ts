import { getSites, getSnapshotsForSite, saveSynthesis, type SnapshotRow } from "./repo.js";
import { toDayPoints, aggregateDayPoints, findTrendsForEntity, rankFindings, type Finding, type DayPoint } from "./trends.js";
import { excludeAnomalies } from "./anomaly.js";
import { generateSynthesis } from "./synthesis.js";
import type { Continent } from "./continent.js";

const HISTORY_DAYS = 70; // ~2 weeks recent + 8 weeks baseline

function dateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export interface AnalysisResult {
  findings: Finding[];
  siteSeries: Record<string, DayPoint[]>;
  regionSeries: Record<string, DayPoint[]>;
  globalSeries: DayPoint[];
}

export async function runTrendAnalysis(): Promise<AnalysisResult> {
  const sites = await getSites();
  const dateFrom = dateNDaysAgo(HISTORY_DAYS);
  const dateTo = dateNDaysAgo(0);

  const siteSeries: Record<string, DayPoint[]> = {};
  const siteRowsById: Record<string, SnapshotRow[]> = {};
  for (const site of sites) {
    const rawRows = await getSnapshotsForSite(site.id, dateFrom, dateTo);
    // Trend detection and the weekly synthesis must never mistake a traffic-flood
    // anomaly for a real trend -- see anomaly.ts for why (Piwik Pro's own bot
    // detection never fires on this data).
    const { clean } = excludeAnomalies(rawRows);
    siteRowsById[site.id] = clean;
    siteSeries[site.id] = toDayPoints(clean);
  }

  const regionGroups = new Map<Continent, string[]>();
  for (const site of sites) {
    const list = regionGroups.get(site.continent) ?? [];
    list.push(site.id);
    regionGroups.set(site.continent, list);
  }

  const regionSeries: Record<string, DayPoint[]> = {};
  for (const [region, siteIds] of regionGroups) {
    regionSeries[region] = aggregateDayPoints(siteIds.map((id) => siteRowsById[id]));
  }

  const globalSeries = aggregateDayPoints(Object.values(siteRowsById));

  const findings: Finding[] = [];
  for (const site of sites) {
    findings.push(...findTrendsForEntity(siteSeries[site.id], "site", site.id, site.name));
  }
  for (const [region, series] of Object.entries(regionSeries)) {
    findings.push(...findTrendsForEntity(series, "continent", region, region));
  }
  findings.push(...findTrendsForEntity(globalSeries, "global", "global", "Tous sites"));

  return { findings: rankFindings(findings), siteSeries, regionSeries, globalSeries };
}

export async function runSynthesis(): Promise<void> {
  const { findings, globalSeries } = await runTrendAnalysis();

  const last7 = globalSeries.slice(-7);
  const prev7 = globalSeries.slice(-14, -7);
  const sum = (pts: DayPoint[], pick: (p: DayPoint) => number) => pts.reduce((a, p) => a + pick(p), 0);

  const totalSessions = sum(last7, (p) => p.sessions);
  const prevTotalSessions = sum(prev7, (p) => p.sessions);
  const totalConversions = sum(last7, (p) => p.goalConversions);
  const prevConversions = sum(prev7, (p) => p.goalConversions);

  const globalOverview = {
    totalSessions,
    prevTotalSessions,
    conversionRate: totalSessions > 0 ? totalConversions / totalSessions : 0,
    prevConversionRate: prevTotalSessions > 0 ? prevConversions / prevTotalSessions : 0,
  };

  const { bullets, highlights } = generateSynthesis(findings, globalOverview);

  const periodFrom = last7[0]?.date ?? dateNDaysAgo(7);
  const periodTo = last7[last7.length - 1]?.date ?? dateNDaysAgo(0);
  await saveSynthesis({ periodFrom, periodTo, bullets, highlights });
}
