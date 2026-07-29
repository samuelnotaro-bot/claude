import {
  getSites,
  upsertSnapshot,
  getEarliestSnapshotDateBySite,
  getSnapshotDatesBySite,
  type SiteRecord,
} from "./repo.js";
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
  const sites = await getSites();
  if (sites.length === 0) return empty;

  const today = new Date().toISOString().slice(0, 10);

  // Always refresh today on top of the historical gap scan below -- today
  // is a partial day (still accumulating sessions in Piwik Pro) and is
  // never part of the [earliest, yesterday] gap-scan window, so without
  // this it would only ever get updated once a day by the cron.
  const todayResult = await syncDay(today);
  if (todayResult.ok > 0) clearCache();

  // Per-site earliest, not a single global MIN(date) -- once
  // extendHistoryToRetentionFloor has pushed some sites' history back to
  // ~2 years while others are still recent, a shared "earliest" balloons
  // the scan window to the full 2 years for every site, and it takes just
  // one site with a large legitimate gap (e.g. one still mid-extension) to
  // exhaust the whole per-run fill budget before a much smaller, more
  // urgent gap on another site is ever reached.
  const earliestBySite = await getEarliestSnapshotDateBySite(sites.map((s) => s.id));
  const sitesWithHistory = sites.filter((s) => earliestBySite.get(s.id));
  if (sitesWithHistory.length === 0) return { ...empty, daysFilled: todayResult.ok, daysFailed: todayResult.failed };

  const yesterday = addDaysIso(today, -1);
  const retentionFloor = addDaysIso(today, -config.piwikDataRetentionDays);
  let overallEarliest = earliestBySite.get(sitesWithHistory[0].id)!;
  for (const site of sitesWithHistory) {
    const e = earliestBySite.get(site.id)!;
    if (e < overallEarliest) overallEarliest = e;
  }
  if (overallEarliest > yesterday) return { ...empty, daysFilled: todayResult.ok, daysFailed: todayResult.failed };

  // One presence lookup covering every site's range at once (cheap local
  // DB read, not rate-limited Piwik Pro calls) -- each site's own scan
  // below only walks its own [siteEarliest, yesterday] slice of it.
  const datesBySite = await getSnapshotDatesBySite(
    sitesWithHistory.map((s) => s.id),
    overallEarliest,
    yesterday
  );

  const missingBySite = new Map<string, string[]>();
  let totalMissing = 0;
  let outOfRetention = 0;
  for (const site of sitesWithHistory) {
    const siteEarliest = earliestBySite.get(site.id)!;
    const present = datesBySite.get(site.id) ?? new Set<string>();
    const missing: string[] = [];
    for (let d = siteEarliest; d <= yesterday; d = addDaysIso(d, 1)) {
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

  if (totalMissing === 0) return { ...empty, daysOutOfRetention: outOfRetention, daysFilled: todayResult.ok, daysFailed: todayResult.failed };

  console.log(`[sync] found ${totalMissing} missing (site, day) pair(s) across ${missingBySite.size} site(s) within the ${config.piwikDataRetentionDays}-day retention window (+${outOfRetention} unfillable, out of retention); filling up to ${MAX_GAP_FILLS_PER_RUN} now...`);

  // Round-robin across sites (one missing day at a time), not one site
  // drained before the next -- guarantees every site with a gap gets
  // touched this run instead of the whole budget going to whichever site
  // happens to be first and have the largest backlog.
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const siteIdsWithGaps = [...missingBySite.keys()];
  const cursors = new Map<string, number>(siteIdsWithGaps.map((id) => [id, 0]));
  let filled = 0;
  let failed = 0;
  let attempted = 0;
  let progressed = true;
  while (attempted < MAX_GAP_FILLS_PER_RUN && progressed) {
    progressed = false;
    for (const siteId of siteIdsWithGaps) {
      if (attempted >= MAX_GAP_FILLS_PER_RUN) break;
      const missing = missingBySite.get(siteId)!;
      const cursor = cursors.get(siteId)!;
      if (cursor >= missing.length) continue;
      progressed = true;
      attempted++;
      cursors.set(siteId, cursor + 1);
      const result = await syncSiteDate(siteById.get(siteId)!, missing[cursor]);
      if (result.ok) filled++;
      else failed++;
    }
  }

  if (filled > 0) clearCache();
  const remaining = totalMissing - filled - failed;
  console.log(`[sync] gap fill done: ${filled} day(s) filled, ${failed} failed (will retry), ${remaining} not yet attempted, ${outOfRetention} out of retention (never fillable).`);
  return {
    sitesWithGaps: missingBySite.size,
    daysFilled: filled + todayResult.ok,
    daysRemaining: remaining,
    daysFailed: failed + todayResult.failed,
    daysOutOfRetention: outOfRetention,
  };
}

export interface ExtendHistoryResult {
  extended: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  daysAdded: number;
  sitesExtended: number;
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
 * excluding) each site's own earliest known date -- computed per site, not
 * from a single global MIN(date), because that global minimum is misleading
 * the moment sites don't all have the same amount of history (e.g. one site
 * picked up a handful of very old rows from an interrupted run while the
 * rest didn't: a global "earliest" would then look like it's already at the
 * retention floor and skip everyone, even though most sites still have a
 * large gap). On Render's free plan there's no Shell tab to run `npm run
 * backfill` manually, so this is exposed as POST /api/data/deep-backfill
 * (same dashboard auth as everything else) to be triggered from the UI.
 */
export async function extendHistoryToRetentionFloor(
  onSiteProgress?: (sitesDone: number, sitesTotal: number) => void
): Promise<ExtendHistoryResult> {
  const empty: ExtendHistoryResult = { extended: false, dateFrom: null, dateTo: null, daysAdded: 0, sitesExtended: 0, ok: 0, failed: 0 };
  const sites = await getSites();
  if (sites.length === 0) return empty;

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = addDaysIso(today, -1);
  const retentionFloor = addDaysIso(today, -config.piwikDataRetentionDays);
  const earliestBySite = await getEarliestSnapshotDateBySite(sites.map((s) => s.id));

  const targets = sites
    .map((site) => {
      const earliest = earliestBySite.get(site.id) ?? null;
      // No data at all yet for this site -> fetch the whole window, not just
      // "before" some earliest date that doesn't exist.
      const dateTo = earliest ? addDaysIso(earliest, -1) : yesterday;
      return { site, dateFrom: retentionFloor, dateTo };
    })
    .filter((t) => t.dateFrom <= t.dateTo); // already at (or past) the retention floor for this site

  if (targets.length === 0) return empty;

  console.log(`[sync] extending history back to the retention floor for ${targets.length}/${sites.length} site(s) (each site's own gap, from ${retentionFloor})...`);
  // Report the real total (sites that actually need work) right away --
  // otherwise the caller's status tracker starts at sites.length (every
  // site) and only corrects itself once the first batch finishes, which
  // looks like the run "shrank" or stalled rather than simply reporting the
  // true, smaller amount of work.
  onSiteProgress?.(0, targets.length);

  let ok = 0;
  let failed = 0;
  let done = 0;
  let batchError: string | undefined;
  let latestDateTo = targets[0].dateTo;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((t) => syncSiteRange(t.site, t.dateFrom, t.dateTo)));
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      ok += r.ok;
      failed += r.failed;
      done++;
      if (r.batchError && !batchError) batchError = r.batchError;
      if (batch[j].dateTo > latestDateTo) latestDateTo = batch[j].dateTo;
    }
    // Clear after every batch, not just once at the very end -- the whole
    // run can take well over an hour, and only invalidating the cache on
    // final completion meant newly-fetched data was already sitting in
    // Postgres but invisible on the dashboard (still served from the
    // pre-run cache) for the entire duration, making a genuinely working
    // run look like nothing was happening.
    clearCache();
    onSiteProgress?.(done, targets.length);
  }

  console.log(`[sync] history extension done: ${ok} (site, day) pair(s) filled across ${targets.length} site(s), ${failed} failed.${batchError ? ` First batch error: ${batchError}` : ""}`);
  return {
    extended: true,
    dateFrom: retentionFloor,
    dateTo: latestDateTo,
    daysAdded: daysBetweenInclusive(retentionFloor, latestDateTo),
    sitesExtended: targets.length,
    ok,
    failed,
    batchError,
  };
}
