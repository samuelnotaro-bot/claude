import { getSites, upsertSnapshot, getEarliestSnapshotDate, getSnapshotDatesBySite, type SiteRecord } from "./repo.js";
import { fetchDailyMetrics } from "./metrics.js";
import { clearCache } from "./cache.js";
import { addDaysIso } from "./period.js";

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

async function syncSiteDate(site: SiteRecord, date: string): Promise<void> {
  const metrics = await fetchDailyMetrics(site.id, date);
  await upsertSnapshot(metrics);
}

// Upper bound on how many (site, day) fetches a single gap-fill run performs,
// so a very large or very old gap doesn't trigger a huge burst of API calls in
// one go -- it just keeps closing the gap further on each subsequent run
// (boot, or the "Combler les trous" button) instead of doing it all at once.
const MAX_GAP_FILLS_PER_RUN = 300;

export interface GapFillResult {
  sitesWithGaps: number;
  daysFilled: number;
  daysRemaining: number;
}

/**
 * Finds every (site, date) pair missing between the earliest data on record
 * and yesterday -- not just a trailing "latest -> yesterday" range -- and
 * fetches those specific days for those specific sites.
 *
 * A plain daily cron (see scheduler.ts) only runs if the process happens to
 * be awake at its scheduled time; on Render's free plan the service spins
 * down after inactivity, so a run can be skipped entirely, or a transient
 * Piwik Pro API error can fail one site's fetch without failing the rest.
 * Either way, the result is a silent hole *inside* otherwise-complete
 * history (not just at the tail), which both hides real periods of data
 * ("no data from July 1 to 19") and quietly wrecks period-over-period
 * comparisons (a window with a hole in it is not a fair comparison).
 *
 * Called once at boot (see index.ts) and available on demand via
 * POST /api/data/fill-gaps so a gap can be closed immediately instead of
 * waiting for the next wake-up.
 */
export async function backfillGaps(): Promise<GapFillResult> {
  const [sites, earliest] = await Promise.all([getSites(), getEarliestSnapshotDate()]);
  if (sites.length === 0 || !earliest) return { sitesWithGaps: 0, daysFilled: 0, daysRemaining: 0 };

  const yesterday = addDaysIso(new Date().toISOString().slice(0, 10), -1);
  if (earliest > yesterday) return { sitesWithGaps: 0, daysFilled: 0, daysRemaining: 0 };

  const datesBySite = await getSnapshotDatesBySite(
    sites.map((s) => s.id),
    earliest,
    yesterday
  );

  const missingBySite = new Map<string, string[]>();
  let totalMissing = 0;
  for (const site of sites) {
    const present = datesBySite.get(site.id) ?? new Set<string>();
    const missing: string[] = [];
    for (let d = earliest; d <= yesterday; d = addDaysIso(d, 1)) {
      if (!present.has(d)) missing.push(d);
    }
    if (missing.length > 0) {
      missingBySite.set(site.id, missing);
      totalMissing += missing.length;
    }
  }

  if (totalMissing === 0) return { sitesWithGaps: 0, daysFilled: 0, daysRemaining: 0 };

  console.log(`[sync] found ${totalMissing} missing (site, day) pair(s) across ${missingBySite.size} site(s); filling up to ${MAX_GAP_FILLS_PER_RUN} now...`);

  let filled = 0;
  outer: for (const site of sites) {
    const missing = missingBySite.get(site.id);
    if (!missing) continue;
    for (const date of missing) {
      if (filled >= MAX_GAP_FILLS_PER_RUN) break outer;
      await syncSiteDate(site, date);
      filled++;
    }
  }

  if (filled > 0) clearCache();
  const remaining = totalMissing - filled;
  console.log(`[sync] gap fill done: ${filled} day(s) filled, ${remaining} still remaining (will continue on next run).`);
  return { sitesWithGaps: missingBySite.size, daysFilled: filled, daysRemaining: remaining };
}
