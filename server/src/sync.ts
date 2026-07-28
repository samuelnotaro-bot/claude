import { getSites, upsertSnapshot, getEarliestSnapshotDate, getSnapshotDatesBySite, type SiteRecord } from "./repo.js";
import { fetchDailyMetrics, fetchMetricsRange } from "./metrics.js";
import { clearCache } from "./cache.js";
import { addDaysIso, daysBetweenInclusive } from "./period.js";
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

// Falling back to the per-day loop only makes sense when that fallback stays
// cheap: a wrong column id (or any other systematic failure) fails the exact
// same way for every date in the range, so for a genuinely long range (the
// 26-month deep-backfill) the "safe" fallback is actually the trap -- it
// silently commits to potentially thousands of sequential rate-limited calls
// per site, which looks indistinguishable from "stuck" for hours. Only fall
// back for ranges short enough that the worst case is still fast.
const MAX_RANGE_DAYS_FOR_PER_DAY_FALLBACK = 14;

/**
 * Fetches+stores one site's whole [dateFrom, dateTo] range in a handful of
 * batched Piwik Pro requests (see metrics.fetchMetricsRange). Falls back to
 * the proven per-day loop only for short ranges (see
 * MAX_RANGE_DAYS_FOR_PER_DAY_FALLBACK) -- for a longer range, a batch
 * failure is reported immediately instead, with the real Piwik Pro error, so
 * a bad assumption in the batching code (e.g. a wrong column id) surfaces
 * fast rather than turning into a multi-hour silent fallback.
 */
async function syncSiteRange(site: SiteRecord, dateFrom: string, dateTo: string): Promise<{ ok: number; failed: number; batchError?: string }> {
  try {
    const days = await fetchMetricsRange(site.id, dateFrom, dateTo);
    for (const day of days) await upsertSnapshot(day);
    return { ok: days.length, failed: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const rangeDays = daysBetweenInclusive(dateFrom, dateTo);
    if (rangeDays > MAX_RANGE_DAYS_FOR_PER_DAY_FALLBACK) {
      console.warn(`[sync] range batch failed for ${site.name} ${dateFrom}..${dateTo} (${rangeDays} days) -- too long to fall back per-day, reporting failure: ${message}`);
      return { ok: 0, failed: rangeDays, batchError: message };
    }
    console.warn(`[sync] range batch failed for ${site.name} ${dateFrom}..${dateTo}, falling back to per-day fetch: ${message}`);
  }
  let ok = 0;
  let failed = 0;
  for (let d = dateFrom; d <= dateTo; d = addDaysIso(d, 1)) {
    const r = await syncSiteDate(site, d);
    if (r.ok) ok++;
    else failed++;
  }
  return { ok, failed };
}

/**
 * Same as syncDay but for a whole date range, one batched request set per
 * site instead of one per (site, day). onSiteProgress (optional) fires after
 * each concurrency batch of sites finishes -- used to drive a UI progress
 * bar for the deep-backfill route (see routes/api.ts), which can take a
 * couple of minutes against the real Piwik Pro API.
 */
export async function syncDateRange(
  dateFrom: string,
  dateTo: string,
  onSiteProgress?: (sitesDone: number, sitesTotal: number) => void
): Promise<{ ok: number; failed: number; batchError?: string }> {
  const sites = await getSites();
  let ok = 0;
  let failed = 0;
  let done = 0;
  let batchError: string | undefined;
  for (let i = 0; i < sites.length; i += CONCURRENCY) {
    const batch = sites.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((site) => syncSiteRange(site, dateFrom, dateTo)));
    for (const r of results) {
      ok += r.ok;
      failed += r.failed;
      done++;
      if (r.batchError && !batchError) batchError = r.batchError;
    }
    onSiteProgress?.(done, sites.length);
  }
  return { ok, failed, batchError };
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

export interface ExtendHistoryResult {
  extended: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  daysAdded: number;
  ok: number;
  failed: number;
  /** Real Piwik Pro error from the first failed range batch, if any -- see MAX_RANGE_DAYS_FOR_PER_DAY_FALLBACK. */
  batchError?: string;
}

/**
 * backfillGaps only fills holes *inside* the already-known history (between
 * the earliest snapshot on record and yesterday) -- it never reaches further
 * back than that earliest date, so on an instance whose initial backfill only
 * covered e.g. the last 90 days, the "Combler les trous de données" button
 * can never surface anything older than that, even though Piwik Pro itself
 * keeps up to PIWIK_DATA_RETENTION_DAYS.
 *
 * This extends the *other* direction: from the retention floor up to (but
 * excluding) the current earliest date, in one batched syncDateRange call --
 * on Render's free plan there's no Shell tab to run `npm run backfill`
 * manually, so this is exposed as POST /api/data/deep-backfill (same
 * dashboard auth as everything else) to be triggered from the UI instead.
 */
export async function extendHistoryToRetentionFloor(
  onSiteProgress?: (sitesDone: number, sitesTotal: number) => void
): Promise<ExtendHistoryResult> {
  const empty: ExtendHistoryResult = { extended: false, dateFrom: null, dateTo: null, daysAdded: 0, ok: 0, failed: 0 };
  const earliest = await getEarliestSnapshotDate();
  if (!earliest) return empty;

  const today = new Date().toISOString().slice(0, 10);
  const retentionFloor = addDaysIso(today, -config.piwikDataRetentionDays);
  const dateTo = addDaysIso(earliest, -1);
  if (retentionFloor > dateTo) return empty; // already at (or past) the retention floor, nothing older to fetch

  const dateFrom = retentionFloor;
  console.log(`[sync] extending history back to the retention floor: ${dateFrom} -> ${dateTo} (${daysBetweenInclusive(dateFrom, dateTo)} day(s), batched by date range)...`);
  const result = await syncDateRange(dateFrom, dateTo, onSiteProgress);
  clearCache();
  console.log(`[sync] history extension done: ${result.ok} (site, day) pair(s) filled, ${result.failed} failed.${result.batchError ? ` First batch error: ${result.batchError}` : ""}`);
  return { extended: true, dateFrom, dateTo, daysAdded: daysBetweenInclusive(dateFrom, dateTo), ok: result.ok, failed: result.failed, batchError: result.batchError };
}
