import { config } from "./config.js";
import * as piwik from "./piwik/client.js";
import { generateDemoMetrics } from "./demoData.js";
import type { DailySiteMetrics } from "./piwik/types.js";

export async function fetchDailyMetrics(siteId: string, date: string): Promise<DailySiteMetrics> {
  if (config.mode === "live") {
    return piwik.getDailyMetrics(siteId, date);
  }
  return generateDemoMetrics(siteId, date, new Date());
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
