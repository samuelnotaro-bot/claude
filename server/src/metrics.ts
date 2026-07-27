import { config } from "./config.js";
import * as piwik from "./piwik/client.js";
import { generateDemoMetrics, demoCountryBreakdown } from "./demoData.js";
import type { DailySiteMetrics, CountryBreakdown } from "./piwik/types.js";

export async function fetchDailyMetrics(siteId: string, date: string): Promise<DailySiteMetrics> {
  if (config.mode === "live") {
    return piwik.getDailyMetrics(siteId, date);
  }
  return generateDemoMetrics(siteId, date, new Date());
}

export async function fetchCountryBreakdown(siteId: string, dateFrom: string, dateTo: string): Promise<CountryBreakdown[]> {
  if (config.mode === "live") {
    return piwik.getCountryBreakdown(siteId, dateFrom, dateTo);
  }
  return demoCountryBreakdown(siteId);
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
