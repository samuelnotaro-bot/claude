import { getSites, upsertSnapshot } from "./repo.js";
import { fetchDailyMetrics } from "./metrics.js";

export async function syncDay(date: string): Promise<void> {
  const sites = await getSites();
  for (const site of sites) {
    const metrics = await fetchDailyMetrics(site.id, date);
    await upsertSnapshot(metrics);
  }
}
