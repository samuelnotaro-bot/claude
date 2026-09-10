import { config } from "./config.js";
import * as piwik from "./piwik/client.js";
import { generateDemoMetrics, demoCountryChannelBreakdown } from "./demoData.js";
import type { DailySiteMetrics } from "./piwik/types.js";
import type { CountryChannelRow } from "./piwik/client.js";

export async function fetchDailyMetrics(siteId: string, date: string): Promise<DailySiteMetrics> {
  if (config.mode === "live") {
    return piwik.getDailyMetrics(siteId, date);
  }
  return generateDemoMetrics(siteId, date, new Date());
}

/**
 * Same data as fetchDailyMetrics, one entry per day in [dateFrom, dateTo],
 * batched into a handful of Piwik Pro requests instead of one call per day
 * (see piwik/client.ts getMetricsRange) -- what makes a real multi-month
 * backfill practical. In demo mode this is just cheap local generation, no
 * batching concern.
 */
export async function fetchMetricsRange(siteId: string, dateFrom: string, dateTo: string): Promise<DailySiteMetrics[]> {
  if (config.mode === "live") {
    return piwik.getMetricsRange(siteId, dateFrom, dateTo);
  }
  const now = new Date();
  return dateRange(new Date(dateFrom), new Date(dateTo)).map((date) => generateDemoMetrics(siteId, date, now));
}

/**
 * Same data as fetchMetricsRange, for every site in `siteIds` in one pass
 * (see piwik/client.ts#getMetricsRangeAllSites) -- queries a Roll-Up
 * Reporting property once per query type/chunk instead of once per query
 * type/chunk/site, when config.piwikRollupSiteId is configured. Demo mode
 * has no roll-up concept, so it just generates each site's data locally
 * and groups it the same way, no batching concern either way.
 */
export async function fetchMetricsRangeAllSites(
  rollupSiteId: string,
  dateFrom: string,
  dateTo: string,
  siteIds: Set<string>
): Promise<Map<string, DailySiteMetrics[]>> {
  if (config.mode === "live") {
    return piwik.getMetricsRangeAllSites(rollupSiteId, dateFrom, dateTo, siteIds);
  }
  const now = new Date();
  const dates = dateRange(new Date(dateFrom), new Date(dateTo));
  const result = new Map<string, DailySiteMetrics[]>();
  for (const siteId of siteIds) {
    result.set(siteId, dates.map((date) => generateDemoMetrics(siteId, date, now)));
  }
  return result;
}

export async function fetchCountryChannelBreakdown(siteId: string, dateFrom: string, dateTo: string): Promise<CountryChannelRow[]> {
  if (config.mode === "live") {
    return piwik.getCountryChannelBreakdown(siteId, dateFrom, dateTo);
  }
  return demoCountryChannelBreakdown(siteId);
}

export function dateRange(from: Date, to: Date): string[] {
  const dates: string[] = [];
  const cur = new Date(from);
  while (cur <= to) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}
