import { getSites, upsertSnapshot, getEarliestSnapshotDate, getSnapshotDatesBySite, type SiteRecord } from "./repo.js";
import { fetchDailyMetrics } from "./metrics.js";
import { clearCache } from "./cache.js";
import { addDaysIso } from "./period.js";
import { config } from "./config.js";

// Bounded concurrency across sites for a given day -- meaningfully faster than
// fully sequential against the real Piwik Pro API, while staying conservative
// enough to avoid tripping any API rate limit.
const CONCURRENCY = 5;

/**
 * Fetches+stores one site/day. Never throws -- a transient Piwik Pro error
 * (rate limit, network blip, one bad site/date combo) must not take down the
 * rest of the batch it's running in. Returns whether it worked so the caller
 * can report real failure counts instead of an all-or-nothing result.
 */
async function syncSiteDate(site: SiteRecord, date: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const metrics = await fetchDailyMetrics(site.id, date);
    await upsertSnapshot(metrics);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sync] failed to fetch ${site.name}/${date}, skipping (will retry on next run): ${message}`);
    return { ok: false, error: message };
  }
}

/**
 * Syncs one day for every site. Previously a single failing site aborted the
 * whole day (Promise.all rejects on the first failure, and the `for` loop
 * over concurrency batches stops there too) -- on a real Piwik Pro org with
 * ~20 sites, one transient error meant every site *after* it in that day's
 * run silently never got synced, which is how holes crept into the history.
 * Each site/day is now isolated: a failure is logged and skipped, the rest
 * of the batch and the rest of the day still run.
 */
export async function syncDay(date: string): Promise<{ ok: number; failed: number }> {
  const sites = await getSites();
  let ok = 0;
  let failed = 0;
  for (let i = 0; i < sites.length; i += CONCURRENCY) {
    const batch = sites.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((site) => syncSiteDate(site, date)));
    for (const r of results) {
      if (r.ok) ok++;
      else failed++;
    }
  }
  return { ok, failed };
}

// Upper bound on how many (site, day) fetches a single gap-fill run performs.
// Each fill makes ~6 Piwik Pro calls (totals, channels, goals, downloads,
// AI-referral, bounces, Search Console), all paced through the same
// per-minute rate limit (see piwik/client.ts) -- at the default 60/min that's
// roughly 10 fills/minute, so 25 keeps a single run (boot, or the "Combler
// les trous" button click) to a couple of minutes instead of tying up the
// request for as long as a big gap would otherwise take. A large gap just
// keeps closing further on each subsequent run.
const MAX_GAP_FILLS_PER_RUN = 25;

export interface GapFillResult {
  sitesWithGaps: number;
  daysFilled: number;
  daysRemaining: number;
  /** Attempts that failed this run (transient Piwik Pro error) -- stay "missing" and get retried on the next run, see syncSiteDate. */
  daysFailed: number;
  /**
   * Missing (site, day) pairs older than PIWIK_DATA_RETENTION_DAYS -- Piwik
   * Pro no longer has this data at all, so retrying them would just waste
   * rate-limited API budget forever. Not attempted, not counted in
   * daysRemaining: these will never fill, and the UI should say so instead of
   * implying "not yet" like it does for daysRemaining.
   */
  daysOutOfRetention: number;
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
  const empty: GapFillResult = { sitesWithGaps: 0, daysFilled: 0, daysRemaining: 0, daysFailed: 0, daysOutOfRetention: 0 };
  const [sites, earliest] = await Promise.all([getSites(), getEarliestSnapshotDate()]);
  if (sites.length === 0 || !earliest) return empty;

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = addDaysIso(today, -1);
  if (earliest > yesterday) return empty;

  const retentionFloor = addDaysIso(today, -config.piwikDataRetentionDays);

  const datesBySite = await getSnapshotDatesBySite(
    sites.map((s) => s.id),
    earliest,
    yesterday
  );

  const missingBySite = new Map<string, string[]>();
  let totalMissing = 0;
  let outOfRetention = 0;
  for (const site of sites) {
    const present = datesBySite.get(site.id) ?? new Set<string>();
    const missing: string[] = [];
    for (let d = earliest; d <= yesterday; d = addDaysIso(d, 1)) {
      if (present.has(d)) continue;
      if (d < retentionFloor) {
        // Piwik Pro will never return this date again -- don't attempt it,
        // don't count it as "remaining" (that implies it just needs a retry).
        outOfRetention++;
        continue;
      }
      missing.push(d);
    }
    if (missing.length > 0) {
      missingBySite.set(site.id, missing);
      totalMissing += missing.length;
    }
  }

  if (totalMissing === 0) return { ...empty, daysOutOfRetention: outOfRetention };

  console.log(`[sync] found ${totalMissing} missing (site, day) pair(s) across ${missingBySite.size} site(s) within the ${config.piwikDataRetentionDays}-day retention window (+${outOfRetention} unfillable, out of retention); filling up to ${MAX_GAP_FILLS_PER_RUN} now...`);

  let filled = 0;
  let failed = 0;
  let attempted = 0;
  outer: for (const site of sites) {
    const missing = missingBySite.get(site.id);
    if (!missing) continue;
    for (const date of missing) {
      if (attempted >= MAX_GAP_FILLS_PER_RUN) break outer;
      attempted++;
      const result = await syncSiteDate(site, date);
      if (result.ok) filled++;
      else failed++;
    }
  }

  if (filled > 0) clearCache();
  const remaining = totalMissing - filled - failed;
  console.log(`[sync] gap fill done: ${filled} day(s) filled, ${failed} failed (will retry), ${remaining} not yet attempted, ${outOfRetention} out of retention (never fillable).`);
  return { sitesWithGaps: missingBySite.size, daysFilled: filled, daysRemaining: remaining, daysFailed: failed, daysOutOfRetention: outOfRetention };
}
