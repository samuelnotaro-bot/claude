import { getSites, upsertSnapshot } from "./repo.js";
import { fetchDailyMetrics } from "./metrics.js";

// Bounded concurrency across sites for a given day -- meaningfully faster than
// fully sequential against the real Piwik Pro API, while staying conservative
// enough to avoid tripping any API rate limit.
const CONCURRENCY = 5;

export async function syncDay(date: string): Promise<void> {
  const sites = await getSites();
  for (let i = 0; i < sites.length; i += CONCURRENCY) {
    const batch = sites.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (site) => {
        const metrics = await fetchDailyMetrics(site.id, date);
        await upsertSnapshot(metrics);
      })
    );
  }
}
