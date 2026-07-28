import { getSites, upsertSnapshot, getLatestSnapshotDate } from "./repo.js";
import { fetchDailyMetrics } from "./metrics.js";
import { clearCache } from "./cache.js";

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

// Upper bound on how many missing days a single catch-up run will fetch, so a
// service left asleep for a very long time doesn't trigger a huge burst of API
// calls on the next wake -- it'll just catch up further on the next wake after that.
const MAX_CATCHUP_DAYS = 30;

/**
 * Fills any daily snapshots missing between the last synced date and
 * yesterday. On Render's free plan the scheduled fetch (see scheduler.ts) only
 * fires if the process happens to be awake at its cron time -- since the
 * service spins down after inactivity, a plain cron schedule alone silently
 * produces gaps in the data, which in turn broke period-over-period
 * comparisons (a short window with a missing day never had "enough" data).
 * Called once at boot (see index.ts) so the very next wake-up closes any gap
 * instead of waiting for the next scheduled fetch to happen to land while awake.
 */
export async function catchUpMissingDays(): Promise<void> {
  const latest = await getLatestSnapshotDate();
  if (!latest) return; // no data at all yet -- handled by the initial backfill instead

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = yesterday.toISOString().slice(0, 10);
  if (latest >= yesterdayIso) return; // already up to date

  const missing: string[] = [];
  const cursor = new Date(latest + "T00:00:00Z");
  cursor.setDate(cursor.getDate() + 1);
  while (cursor.toISOString().slice(0, 10) <= yesterdayIso && missing.length < MAX_CATCHUP_DAYS) {
    missing.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 1);
  }

  console.log(`[sync] catching up ${missing.length} day(s) of missing data (${missing[0]} -> ${missing[missing.length - 1]})...`);
  for (const date of missing) {
    await syncDay(date);
  }
  clearCache();
  console.log("[sync] catch-up done.");
}
