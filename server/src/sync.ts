import {
  getSites,
  upsertSnapshot,
  getEarliestSnapshotDateBySite,
  getSnapshotDatesBySite,
  getZeroSessionDatesBySite,
  type SiteRecord,
} from "./repo.js";
import { fetchDailyMetrics, fetchMetricsRange, fetchMetricsRangeAllSites } from "./metrics.js";
import { clearCache } from "./cache.js";
import { addDaysIso, daysBetweenInclusive, effectiveHistoryFloor } from "./period.js";
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

// Per-day fetching alone cannot realistically cover 26 months of history:
// ~790 days x ~20 sites x ~7 Piwik Pro calls/day is well over 100,000 calls,
// tens of hours even at a generous rate limit -- that's what made "recovered
// 2 days since this morning" the actual, expected outcome once the batched
// path got disabled, not a bug. The batched path (see
// metrics.fetchMetricsRange -> piwik/client.ts getMetricsRange) was disabled
// earlier today over a real but unconfirmed worry: adding a day-dimension
// breakdown column might force Piwik Pro's Analytics Query API into event
// scope and distort session-scoped metrics. Since then: (1) the actual
// reported symptoms (missing/incomplete data, "lost yesterday") trace to a
// confirmed, separate bug -- fetch() had no timeout and could hang forever,
// silently freezing whole sync runs, now fixed; (2) a live single-day
// comparison (getDailyMetrics vs getMetricsRange for the same day) matched
// exactly. Given that, and that per-day is not a viable path to "complete 26
// months" at all, the batched path is back -- with an added per-call
// spot-check inside getMetricsRange (compares one real day from every range
// fetch against the proven single-day path and throws on mismatch) as an
// ongoing automatic guard, not a one-off manual test.
const MAX_RANGE_DAYS_FOR_PER_DAY_FALLBACK = 14;

// Confirmed live and repeatedly, across many sites and runs, not a one-off:
// Piwik Pro's day-dimension breakdown (used by every batched/roll-up path)
// consistently returns 0/no row for dates within roughly the last week,
// even though a plain single-day query (no day dimension) for that exact
// date returns real, correct data. Unlike the rarer, unrelated-to-recency
// per-date quirk the spot-check's 2-candidate check exists to tolerate (see
// piwik/client.ts#spotCheckAgainstSingleDay), this one is predictable
// enough to just avoid outright: any batched fetch whose window reaches
// into the last BATCH_RECENCY_BUFFER_DAYS days is near-certain to have the
// spot-check correctly refuse it (both candidate dates would likely land in
// the lag window at once) -- attempting it anyway only costs a doomed
// request before falling back. Used by both extendHistoryToRetentionFloor
// (caps how recent a batched dateTo may be) and scanAndFillGaps (routes the
// trailing recent slice of a site's missing days straight to the per-day
// path, skipping the batch attempt for exactly that slice).
const BATCH_RECENCY_BUFFER_DAYS = 14;

async function syncSiteRange(
  site: SiteRecord,
  dateFrom: string,
  dateTo: string,
  maxRangeDaysForPerDayFallback: number = MAX_RANGE_DAYS_FOR_PER_DAY_FALLBACK
): Promise<{ ok: number; failed: number; batchError?: string }> {
  try {
    const days = await fetchMetricsRange(site.id, dateFrom, dateTo);
    for (const day of days) await upsertSnapshot(day);
    return { ok: days.length, failed: 0 };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const rangeDays = daysBetweenInclusive(dateFrom, dateTo);
    if (rangeDays > maxRangeDaysForPerDayFallback) {
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

// Extend-history's target range can span months (the deep-history
// extension, unlike a typical gap-fill window) -- one bad date anywhere in
// it would otherwise make syncSiteRange declare the WHOLE range failed
// (its own per-day fallback only covers ranges up to
// MAX_RANGE_DAYS_FOR_PER_DAY_FALLBACK, far smaller), retried from scratch
// every run with the same all-or-nothing result forever. Chunking the
// target into EXTEND_CHUNK_DAYS windows (see syncSiteRangeChunked)
// contains a bad date to just its own chunk -- which, being passed as
// syncSiteRange's own fallback threshold, still gets a proper per-day
// recovery instead of being abandoned, so a site keeps making real,
// permanent progress every run instead of re-failing its entire history
// from the same starting point indefinitely.
const EXTEND_CHUNK_DAYS = 30;

/**
 * Fetches [dateFrom, dateTo] for one site in EXTEND_CHUNK_DAYS windows,
 * walking BACKWARD from dateTo (the end adjacent to the site's existing
 * earliest known date) toward dateFrom, and stopping at the first chunk
 * that isn't fully recovered -- never writes an older chunk past a failed
 * one, so the site's earliest-known date always stays a true, contiguous
 * boundary (no gap hidden underneath data that would otherwise look
 * contiguous by MIN(date) alone). Whatever's left unattempted this run is
 * naturally retried, from the same point, on the next
 * extendHistoryToRetentionFloor pass.
 */
async function syncSiteRangeChunked(site: SiteRecord, dateFrom: string, dateTo: string): Promise<{ ok: number; failed: number; batchError?: string }> {
  let ok = 0;
  let chunkTo = dateTo;
  while (chunkTo >= dateFrom) {
    const naturalChunkFrom = addDaysIso(chunkTo, -(EXTEND_CHUNK_DAYS - 1));
    const chunkFrom = naturalChunkFrom > dateFrom ? naturalChunkFrom : dateFrom;
    const result = await syncSiteRange(site, chunkFrom, chunkTo, EXTEND_CHUNK_DAYS);
    if (result.failed > 0) {
      const remaining = daysBetweenInclusive(dateFrom, chunkTo);
      return { ok, failed: remaining, batchError: result.batchError };
    }
    ok += result.ok;
    chunkTo = addDaysIso(chunkFrom, -1);
  }
  return { ok, failed: 0 };
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

// Upper bound on how many days of Piwik Pro range-fetching a single gap-fill
// run performs, summed across every site it touches. Each site's missing
// days are fetched in ONE batched range request set (~5-7 Piwik Pro calls
// total, see syncSiteRange/getMetricsRange -- same proven path the initial
// backfill uses), covering that site's [oldest missing day, newest missing
// day] in one shot instead of one request set PER missing day. That's what
// makes closing a gap in, say, the last 30 days fast: ~5-7 calls per site
// instead of up to ~180 (30 days x ~6 calls/day on the old per-day path). A
// gap wider than this budget just keeps closing further on each subsequent
// run, same as before.
const MAX_GAP_FILL_SPAN_DAYS_PER_RUN = 400;

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
 * Unconditionally refreshes today AND yesterday for every site (not just
 * when missing). Today is a partial day (still accumulating sessions in
 * Piwik Pro); yesterday is included because the gap scan in
 * scanAndFillGaps only detects *missing* rows -- it can't catch a row
 * that's present but wrong. A bad value written by a broken fetch (the
 * batched range path had a real bug earlier today, now fixed -- see
 * syncSiteRange) stays wrong until something re-fetches that exact day --
 * otherwise that's stuck waiting for tomorrow's cron (see scheduler.ts,
 * which does the same yesterday+today refresh but only once a day). Forcing
 * it here (and on every automatic recovery run, see autoRecovery.ts) closes
 * that gap immediately instead.
 */
async function forceResyncRecentDays(): Promise<{ ok: number; failed: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = addDaysIso(today, -1);
  const todayResult = await syncDay(today);
  const yesterdayResult = await syncDay(yesterday);
  if (todayResult.ok > 0 || yesterdayResult.ok > 0) clearCache();
  return { ok: todayResult.ok + yesterdayResult.ok, failed: todayResult.failed + yesterdayResult.failed };
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
 * Caps itself at MAX_GAP_FILL_SPAN_DAYS_PER_RUN days of range-fetching -- see
 * runGapFillLoop below for the multi-round wrapper that closes a gap larger
 * than that in one background job instead of requiring several manual
 * clicks.
 */
async function scanAndFillGaps(): Promise<GapFillResult> {
  const empty: GapFillResult = { sitesWithGaps: 0, daysFilled: 0, daysRemaining: 0, daysFailed: 0, daysOutOfRetention: 0 };
  const sites = await getSites();
  if (sites.length === 0) return empty;

  const today = new Date().toISOString().slice(0, 10);

  // Per-site earliest, not a single global MIN(date) -- once
  // extendHistoryToRetentionFloor has pushed some sites' history back to
  // ~2 years while others are still recent, a shared "earliest" balloons
  // the scan window to the full 2 years for every site, and it takes just
  // one site with a large legitimate gap (e.g. one still mid-extension) to
  // exhaust the whole per-run fill budget before a much smaller, more
  // urgent gap on another site is ever reached.
  const earliestBySite = await getEarliestSnapshotDateBySite(sites.map((s) => s.id));
  const sitesWithHistory = sites.filter((s) => earliestBySite.get(s.id));
  if (sitesWithHistory.length === 0) return empty;

  const yesterday = addDaysIso(today, -1);
  const retentionFloor = effectiveHistoryFloor();
  let overallEarliest = earliestBySite.get(sitesWithHistory[0].id)!;
  for (const site of sitesWithHistory) {
    const e = earliestBySite.get(site.id)!;
    if (e < overallEarliest) overallEarliest = e;
  }
  if (overallEarliest > yesterday) return empty;

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

  if (totalMissing === 0) return { ...empty, daysOutOfRetention: outOfRetention };

  console.log(`[sync] found ${totalMissing} missing (site, day) pair(s) across ${missingBySite.size} site(s) back to ${retentionFloor} (+${outOfRetention} unfillable, before that floor); filling now...`);

  // One batched range fetch per site -- covers that site's [oldest missing
  // day, newest missing day] in a single request set via the same proven
  // batched path the initial backfill uses (syncSiteRange, which falls back
  // to per-day fetches itself if the batch fails on a short-enough span, see
  // MAX_RANGE_DAYS_FOR_PER_DAY_FALLBACK) -- not one request set PER missing
  // day like before. Smallest span first, not one site drained before the
  // next, so a run closes as many sites' gaps completely as it can within
  // MAX_GAP_FILL_SPAN_DAYS_PER_RUN before spending the budget on whichever
  // site has the largest backlog.
  //
  // The trailing slice of each site's missing days that falls within
  // BATCH_RECENCY_BUFFER_DAYS of today is routed straight to the per-day
  // path instead, skipping the batch attempt for just that slice --
  // confirmed live and repeatedly (not a guess) that a batch reaching into
  // that recent a window fails its spot-check on both checked dates at
  // once almost every time, so attempting it first only costs a doomed
  // request+fallback instead of going straight to what would happen anyway.
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const siteIdsWithGaps = [...missingBySite.keys()].sort(
    (a, b) => missingBySite.get(a)!.length - missingBySite.get(b)!.length
  );
  const recencyCutoff = addDaysIso(today, -BATCH_RECENCY_BUFFER_DAYS);

  let filled = 0;
  let failed = 0;
  let spanDaysUsed = 0;
  for (const siteId of siteIdsWithGaps) {
    if (spanDaysUsed >= MAX_GAP_FILL_SPAN_DAYS_PER_RUN) break;
    const missing = missingBySite.get(siteId)!;
    const site = siteById.get(siteId)!;
    const batchable = missing.filter((d) => d <= recencyCutoff);
    const tooRecent = missing.filter((d) => d > recencyCutoff);

    let siteFailed = 0;
    if (batchable.length > 0) {
      const spanFrom = batchable[0];
      const spanTo = batchable[batchable.length - 1];
      spanDaysUsed += daysBetweenInclusive(spanFrom, spanTo);
      const result = await syncSiteRange(site, spanFrom, spanTo);
      // syncSiteRange (re)fetches every day in [spanFrom, spanTo], not just
      // the missing subset -- idempotent (upsertSnapshot overwrites) and far
      // cheaper as one batched call than as separate per-day fetches, even
      // counting the already-correct days it re-touches. Its summary can't
      // tell which specific missing days within the span succeeded vs
      // failed, so any failure counts the whole batchable subset as still
      // open -- the next scan re-checks real presence and only retries
      // what's genuinely still missing.
      if (result.failed > 0) siteFailed += batchable.length;
    }
    for (const date of tooRecent) {
      const result = await syncSiteDate(site, date);
      if (!result.ok) siteFailed++;
    }
    spanDaysUsed += tooRecent.length;

    filled += missing.length - siteFailed;
    failed += siteFailed;
  }

  if (filled > 0) clearCache();
  const remaining = totalMissing - filled - failed;
  console.log(`[sync] gap fill done: ${filled} day(s) filled, ${failed} failed (will retry), ${remaining} not yet attempted, ${outOfRetention} out of retention (never fillable).`);
  return {
    sitesWithGaps: missingBySite.size,
    daysFilled: filled,
    daysRemaining: remaining,
    daysFailed: failed,
    daysOutOfRetention: outOfRetention,
  };
}

/** Composes the forced today/yesterday refresh with the historical gap scan+fill -- see both for why each exists. Used standalone at boot (see index.ts); runGapFillLoop below calls the two halves separately to avoid repeating the forced refresh on every round. */
export async function backfillGaps(): Promise<GapFillResult> {
  const forced = await forceResyncRecentDays();
  const scanned = await scanAndFillGaps();
  return {
    ...scanned,
    daysFilled: scanned.daysFilled + forced.ok,
    daysFailed: scanned.daysFailed + forced.failed,
  };
}

// scanAndFillGaps caps itself to MAX_GAP_FILL_SPAN_DAYS_PER_RUN per call
// (keeps a single call fast/rate-limit-friendly), so closing a large multi-day,
// multi-site outage needs several calls in a row. Asking a human to keep
// clicking a button every couple of minutes until a counter hits zero is
// exactly the kind of manual repetition CLAUDE.md says to avoid when it can
// reasonably be automated -- so this loops scanAndFillGaps() itself, in the
// background (see routes/api.ts, same fire-and-poll pattern as the
// deep-backfill), until either every gap is filled/out-of-retention
// (sitesWithGaps reaches 0) or the round cap below is hit.
//
// The forced today/yesterday refresh (see forceResyncRecentDays) runs once
// up front, not once per round -- every site's forced refresh normally
// succeeds on the first try, so repeating it each round would burn most of
// the rate-limited API budget re-fetching days that are already correct
// instead of on the actual gaps this loop exists to close.
const MAX_GAP_FILL_ROUNDS = 50;

export async function runGapFillLoop(onRoundProgress?: (round: number, cumulative: GapFillResult) => void): Promise<GapFillResult & { rounds: number }> {
  const forced = await forceResyncRecentDays();
  let cumulative: GapFillResult = { sitesWithGaps: 0, daysFilled: forced.ok, daysRemaining: 0, daysFailed: forced.failed, daysOutOfRetention: 0 };
  onRoundProgress?.(0, cumulative);
  let round = 0;
  for (; round < MAX_GAP_FILL_ROUNDS; round++) {
    const result = await scanAndFillGaps();
    cumulative = {
      sitesWithGaps: result.sitesWithGaps,
      daysFilled: cumulative.daysFilled + result.daysFilled,
      daysRemaining: result.daysRemaining,
      daysFailed: cumulative.daysFailed + result.daysFailed,
      daysOutOfRetention: result.daysOutOfRetention,
    };
    onRoundProgress?.(round + 1, cumulative);
    // No sites left with a fillable gap (everything's either filled now or
    // permanently out of Piwik Pro's retention) -- done, no point looping
    // further.
    if (result.sitesWithGaps === 0) break;
    // Safety net: a round that filled nothing and failed nothing (while
    // sites still report gaps) would otherwise spin forever without making
    // progress -- shouldn't normally happen, but stop rather than burn the
    // round budget uselessly if it does.
    if (result.daysFilled === 0 && result.daysFailed === 0) break;
  }
  return { ...cumulative, rounds: round + 1 };
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
/**
 * Fast path for extendHistoryToRetentionFloor: one bulk fetch covering
 * every site's target window at once via the Roll-Up Reporting property
 * (see config.ts#piwikRollupSiteId, piwik/client.ts#getMetricsRangeAllSites)
 * instead of one fetch per site. Only active when a roll-up site id is
 * configured; returns null (signalling "not attempted, use the per-site
 * path instead") when it isn't, or when anything about the bulk fetch goes
 * wrong -- the safety nets inside getMetricsRangeAllSites already throw on
 * anything implausible, so a thrown error here just means "fall back",
 * exactly like syncSiteRange's existing batched-vs-per-day fallback.
 *
 * Writes only each site's own [dateFrom, dateTo] slice of the bulk result,
 * not the whole fetched window -- keeps the actual database effect
 * identical to what the per-site path would have written, just fetched
 * far more cheaply.
 */
async function extendHistoryViaRollup(
  targets: Array<{ site: SiteRecord; dateFrom: string; dateTo: string }>,
  retentionFloor: string,
  yesterday: string,
  onSiteProgress?: (sitesDone: number, sitesTotal: number) => void
): Promise<{ ok: number; failed: number } | null> {
  if (!config.piwikRollupSiteId) return null;
  try {
    const knownSiteIds = new Set(targets.map((t) => t.site.id));
    const bySite = await fetchMetricsRangeAllSites(config.piwikRollupSiteId, retentionFloor, yesterday, knownSiteIds);
    let ok = 0;
    let failed = 0;
    let done = 0;
    for (const t of targets) {
      const days = bySite.get(t.site.id) ?? [];
      const inWindow = days.filter((d) => d.date >= t.dateFrom && d.date <= t.dateTo);
      for (const day of inWindow) await upsertSnapshot(day);
      ok += inWindow.length;
      const expected = daysBetweenInclusive(t.dateFrom, t.dateTo);
      failed += Math.max(0, expected - inWindow.length);
      done++;
      onSiteProgress?.(done, targets.length);
    }
    clearCache();
    console.log(`[sync] history extension via roll-up done: ${ok} (site, day) pair(s) filled across ${targets.length} site(s), ${failed} missing/failed.`);
    return { ok, failed };
  } catch (err) {
    console.warn(`[sync] roll-up history extension failed, falling back to the per-site path: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function extendHistoryToRetentionFloor(
  onSiteProgress?: (sitesDone: number, sitesTotal: number) => void
): Promise<ExtendHistoryResult> {
  const empty: ExtendHistoryResult = { extended: false, dateFrom: null, dateTo: null, daysAdded: 0, sitesExtended: 0, ok: 0, failed: 0 };
  const sites = await getSites();
  if (sites.length === 0) return empty;

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = addDaysIso(today, -1);
  const retentionFloor = effectiveHistoryFloor();
  const earliestBySite = await getEarliestSnapshotDateBySite(sites.map((s) => s.id));

  // Caps how recent the batched dateTo is allowed to be -- see
  // BATCH_RECENCY_BUFFER_DAYS's doc comment above for why. That's exactly
  // the "extend backward from an earliest date that's only a few days old"
  // case a freshly-recreated database hits on its very first extension --
  // dateTo would otherwise land inside the lag window on every attempt, and
  // the spot-check (rightly) refuses to write the range every single time,
  // blocking all progress. Whatever small gap this cap leaves between it
  // and the site's actual earliest date is inside [siteEarliest, yesterday]
  // once this extension succeeds, so scanAndFillGaps picks it up
  // automatically on its own next pass (using the same buffer itself now).
  const batchSafeDateTo = addDaysIso(today, -BATCH_RECENCY_BUFFER_DAYS);

  const targets = sites
    .map((site) => {
      const earliest = earliestBySite.get(site.id) ?? null;
      // No data at all yet for this site -> fetch the whole window, not just
      // "before" some earliest date that doesn't exist.
      const naturalDateTo = earliest ? addDaysIso(earliest, -1) : yesterday;
      const dateTo = naturalDateTo < batchSafeDateTo ? naturalDateTo : batchSafeDateTo;
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

  const rollupResult = await extendHistoryViaRollup(targets, retentionFloor, yesterday, onSiteProgress);
  if (rollupResult) {
    const latestDateTo = targets.reduce((max, t) => (t.dateTo > max ? t.dateTo : max), targets[0].dateTo);
    return {
      extended: true,
      dateFrom: retentionFloor,
      dateTo: latestDateTo,
      daysAdded: daysBetweenInclusive(retentionFloor, latestDateTo),
      sitesExtended: targets.length,
      ok: rollupResult.ok,
      failed: rollupResult.failed,
    };
  }

  let ok = 0;
  let failed = 0;
  let done = 0;
  let batchError: string | undefined;
  let latestDateTo = targets[0].dateTo;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map((t) => syncSiteRangeChunked(t.site, t.dateFrom, t.dateTo)));
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

/**
 * Cheap local check (Postgres reads only, no Piwik Pro calls) for whether
 * every site's history is already complete back to the retention floor with
 * no known gaps -- lets the automatic recovery loop below (and its periodic
 * retry in scheduler.ts) skip straight past real work once there's nothing
 * left to do, instead of spending rate-limited API budget re-confirming
 * "still complete" over and over.
 */
export async function historyNeedsRecovery(): Promise<boolean> {
  const sites = await getSites();
  if (sites.length === 0) return false;

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = addDaysIso(today, -1);
  const retentionFloor = effectiveHistoryFloor();

  const earliestBySite = await getEarliestSnapshotDateBySite(sites.map((s) => s.id));
  for (const site of sites) {
    const earliest = earliestBySite.get(site.id);
    // No data yet, or still room to extend further back towards the
    // retention floor.
    if (!earliest || earliest > addDaysIso(retentionFloor, 1)) return true;
  }

  const datesBySite = await getSnapshotDatesBySite(
    sites.map((s) => s.id),
    retentionFloor,
    yesterday
  );
  const expectedDays = daysBetweenInclusive(retentionFloor, yesterday);
  for (const site of sites) {
    if ((datesBySite.get(site.id)?.size ?? 0) < expectedDays) return true; // a gap remains somewhere
  }
  return false;
}

// The actual automatic orchestration (extend + gap-fill, wired to the same
// status trackers the manual buttons use) lives in autoRecovery.ts as
// runAutomaticRecovery -- called from index.ts (boot) and scheduler.ts
// (periodic tick). historyNeedsRecovery above is what lets it no-op cheaply.

// How far back to re-verify stored zero-session rows -- bounded on purpose.
// This exists to clean up after two real, now-fixed bugs from earlier today
// (an unbounded fetch hang, and a batched-query issue) that could each write
// a confirmed-wrong 0 for a day that actually had traffic -- not to become a
// standing, ever-repeating re-check of every legitimately quiet day in the
// account's history, which would just burn rate-limited API budget forever
// for no benefit on old, never-touched-by-today's-bugs data.
const ZERO_DAY_REVALIDATION_WINDOW_DAYS = 14;

/**
 * Re-fetches every (site, day) row in the last ZERO_DAY_REVALIDATION_WINDOW_DAYS
 * days that's currently stored as exactly 0 sessions. A stored zero is
 * indistinguishable, by presence alone, from a genuinely quiet day -- which
 * is exactly why the regular gap-fill scan (see scanAndFillGaps, presence-
 * based) can never detect or correct one: a "poisoned" zero written by a
 * broken fetch looks identical to real silence and is never retried. This
 * directly re-verifies each one instead of trusting it, so a bad row left
 * over from earlier today's bugs self-heals instead of showing as a
 * permanent (and misleading) "data outage" on a site that's actually fine.
 *
 * Meant to run once (see autoRecovery.ts#runBootRecovery, called at boot
 * only -- not on the periodic tick) rather than repeatedly: once today's
 * bad rows are corrected, a day that's still 0 after this has been
 * genuinely re-verified against Piwik Pro and re-checking it again and
 * again would be pure waste.
 */
export async function revalidateRecentZeroDays(): Promise<{ checked: number; corrected: number }> {
  const sites = await getSites();
  if (sites.length === 0) return { checked: 0, corrected: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = addDaysIso(today, -1);
  const windowFrom = addDaysIso(today, -ZERO_DAY_REVALIDATION_WINDOW_DAYS);

  const zeroBySite = await getZeroSessionDatesBySite(sites.map((s) => s.id), windowFrom, yesterday);
  const targets: Array<{ site: SiteRecord; date: string }> = [];
  for (const site of sites) {
    for (const date of zeroBySite.get(site.id) ?? []) targets.push({ site, date });
  }
  if (targets.length === 0) return { checked: 0, corrected: 0 };

  console.log(`[sync] re-verifying ${targets.length} stored zero-session day(s) across the last ${ZERO_DAY_REVALIDATION_WINDOW_DAYS} days (one-time check for rows possibly poisoned by earlier bugs)...`);

  let checked = 0;
  let corrected = 0;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ site, date }) => {
        try {
          const metrics = await fetchDailyMetrics(site.id, date);
          await upsertSnapshot(metrics);
          return metrics.sessions > 0;
        } catch (err) {
          console.error(`[sync] zero-day re-verification failed for ${site.name}/${date}, leaving as-is: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      })
    );
    for (const wasCorrected of results) {
      checked++;
      if (wasCorrected) corrected++;
    }
  }

  if (corrected > 0) clearCache();
  console.log(`[sync] zero-day re-verification done: ${checked} checked, ${corrected} corrected (had real traffic after all).`);
  return { checked, corrected };
}
