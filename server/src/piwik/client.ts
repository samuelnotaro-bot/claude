import { config } from "../config.js";
import type { PiwikApp, DailySiteMetrics, Channel } from "./types.js";
import { categorizeGoal } from "../goalCategories.js";
import { isAiReferrerSource } from "../aiReferrers.js";
import { addDaysIso, daysBetweenInclusive } from "../period.js";

/**
 * Thin client for the Piwik Pro REST APIs (Management API v2 + Analytics Query API v1).
 * Column ids below were verified against a real organization (see column probing
 * notes): the Query API takes `column_id` (snake_case) per column, the app list
 * endpoint (/api/apps/v2) paginates with `limit`/`offset` (not JSON:API `page[...]`)
 * and never includes `urls` -- that requires a follow-up GET on /api/apps/v2/{id}.
 * Dimension columns (location_country_name, referrer_type, device_type) return a
 * [code, label] tuple per row instead of a plain scalar.
 *
 * No valid column id was found for average session duration after extensive
 * probing (avg_time_on_site, avg_visit_duration, session_duration, ... all
 * rejected as "does not exist") -- avgSessionDurationSec is left at 0 until the
 * correct column id is confirmed with Piwik Pro support / API Explorer.
 */

const COLUMN_IDS = {
  sessions: "sessions",
  users: "visitors",
  pageviews: "page_views",
  goalConversions: "goal_conversions",
  bounceRate: "bounce_rate",
  channelDimension: "medium",
  countryDimension: "location_country_name",
  goalDimension: "goal_id",
  downloads: "downloads",
  sourceDimension: "source",
  bounces: "bounces",
  // Google Search Console integration columns -- documented at
  // https://developers.piwik.pro/reference/google-search-console-metrics-dimensions.
  // Only populated for sites where the GSC integration is configured in Piwik
  // Pro (Settings > Integrations); queried defensively (see getDailyMetrics)
  // so a site without it configured doesn't break the rest of that site's sync.
  searchConsoleClicks: "search_engine_clicks",
  searchConsoleImpressions: "search_engine_impressions",
  // Used by getMetricsRange to batch a whole date range into a handful of
  // requests instead of one per day, via DAY_DIMENSION_COLUMN below.
  // First guess ("date") was confirmed wrong against the live org: "Piwik
  // Pro API error ... Dimension \"date\" does not exist." (400,
  // source.parameter = columns.0.column_id). Piwik Pro's own community forum
  // ("Getting time from Queries API") documents `{"column_id": "timestamp",
  // "transformation_id": "to_date"}` as the way to get a day-level breakdown
  // -- `timestamp` alone is full event/session time, `to_date` truncates it
  // to the calendar day. Not confirmed against THIS org either (still no
  // test account access), so it's still guarded the same way: `npm run
  // test:connection` probes it first, and if it's wrong too, every range
  // query throws with the real error and the caller (sync.ts) falls back to
  // the proven per-day path -- never silently wrong data.
  dayDimension: "timestamp",
};

const DAY_DIMENSION_COLUMN = { column_id: COLUMN_IDS.dayDimension, transformation_id: "to_date" };

// Confirmed live against this org's Roll-Up Reporting property (see
// config.ts#piwikRollupSiteId): `website_name` returns one row per real
// site, as a [siteId, hostname] tuple -- the siteId matches this app's own
// site ids exactly, verbatim. Used only against the roll-up property, never
// against a normal per-site query (a real site has no "which site" to
// break down by).
const WEBSITE_NAME_COLUMN = { column_id: "website_name" };

// Real `medium` values observed on this organization's traffic; anything else
// (datasheet, notice, multisupports, application, packaging, product, ...) falls
// back to "other".
const CHANNEL_MAP: Record<string, Channel> = {
  organic: "organic",
  direct: "direct",
  referral: "referral",
  link: "referral",
  gmb: "referral",
  social: "social",
  email: "email",
  cpc: "paid",
  banner: "paid",
};

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

// Plain fetch() has no timeout -- if Piwik Pro (or the network path to it on
// Render) ever stalls mid-request instead of erroring, the call hangs
// forever. That's not hypothetical: it's the exact symptom reported live --
// a sync run visibly processes one site then never moves again, and stays
// stuck on the same log line indefinitely. Every per-site fetch is already
// wrapped in a try/catch that skips-and-retries-later on failure (see
// sync.ts syncSiteDate), but that isolation only works if a stuck request
// eventually *fails* -- an AbortController timeout is what makes it fail
// instead of hanging the whole process (and everything awaiting behind it:
// the rest of that concurrency batch, the rest of the sync run, the HTTP
// route the user clicked, all of it) indefinitely.
const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Piwik Pro request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 5_000) {
    return tokenCache.accessToken;
  }
  const res = await fetchWithTimeout(`${config.piwik.baseUrl}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.piwik.clientId,
      client_secret: config.piwik.clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Piwik Pro auth failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
  return tokenCache.accessToken;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sliding-window client-side rate limiter shared by every Piwik Pro call
// (paced right here, the one chokepoint every request goes through) --
// staying under config.piwik.piwikMaxRequestsPerMinute keeps a busy sync
// from bursting past whatever limit the account's Piwik Pro plan enforces,
// which otherwise surfaces as silent failures (i.e. more data gaps, not
// fewer). One shared timestamp list, so the real external limit is never
// exceeded regardless of how many different callers are pulling from it.
const requestTimestamps: number[] = [];

// "bulk" calls (the deep-backfill's chunked range queries) cap themselves to
// a fraction of the limit instead of the full amount, so they can never
// starve "normal" calls (the daily cron, on-demand gap-fills, live
// diagnostics) even during a long-running backfill -- normal calls always
// see the full limit and are never held back by bulk traffic. 0.85 rather
// than a more conservative split: normal traffic here is a handful of
// requests once a day plus the occasional manual click, so it only needs a
// small reserved slice -- the deep-backfill is the one under real time
// pressure (a full run is bounded by Piwik Pro's real per-minute limit no
// matter what, so it should get to use nearly all of it).
const BULK_SHARE_OF_LIMIT = 0.85;

async function waitForRateLimitSlot(priority: "normal" | "bulk" = "normal"): Promise<void> {
  const limit = config.piwikMaxRequestsPerMinute;
  if (limit <= 0) return; // 0/negative = pacing disabled
  const effectiveLimit = priority === "bulk" ? Math.max(1, Math.floor(limit * BULK_SHARE_OF_LIMIT)) : limit;
  for (;;) {
    const now = Date.now();
    while (requestTimestamps.length > 0 && now - requestTimestamps[0] >= 60_000) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < effectiveLimit) {
      requestTimestamps.push(now);
      return;
    }
    await sleep(60_000 - (now - requestTimestamps[0]) + 25);
  }
}

const MAX_RATE_LIMIT_RETRIES = 3;

async function piwikFetch<T>(pathAndQuery: string, init: RequestInit = {}, priority: "normal" | "bulk" = "normal"): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await waitForRateLimitSlot(priority);
    const token = await getAccessToken();
    const res = await fetchWithTimeout(`${config.piwik.baseUrl}${pathAndQuery}`, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (res.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      // Rate-limited despite client-side pacing (e.g. another process shares
      // the same Piwik Pro credentials) -- honor Retry-After when given,
      // otherwise back off for a full window, then retry a bounded number
      // of times before giving up (the caller's per-item error isolation,
      // see sync.ts, turns a final failure into a skip-and-retry-later
      // rather than aborting a whole batch).
      const retryAfterHeader = res.headers.get("Retry-After");
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 60_000;
      console.warn(`[piwik] 429 rate limited on ${pathAndQuery}, retrying in ${Math.round(retryAfterMs / 1000)}s (attempt ${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})`);
      await sleep(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 60_000);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Piwik Pro API error on ${pathAndQuery}: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }
}

const APPS_PAGE_SIZE = 50;

interface AppSummary {
  id: string;
  attributes: Record<string, unknown>;
}

async function listAppSummaries(): Promise<AppSummary[]> {
  const summaries: AppSummary[] = [];
  let offset = 0;
  while (true) {
    const res = await piwikFetch<{ meta: { total: number }; data: AppSummary[] }>(
      `/api/apps/v2?limit=${APPS_PAGE_SIZE}&offset=${offset}`
    );
    summaries.push(...res.data);
    offset += res.data.length;
    if (res.data.length === 0 || offset >= res.meta.total) break;
  }
  return summaries;
}

/**
 * The list endpoint (/api/apps/v2) only returns name/addedAt/updatedAt -- `urls`
 * (and every other app setting) is only present on the single-app detail endpoint,
 * so a per-app follow-up call is required to know which domain(s) an app tracks.
 */
export async function listApps(): Promise<PiwikApp[]> {
  const summaries = await listAppSummaries();
  const apps: PiwikApp[] = [];
  for (const summary of summaries) {
    const detail = await piwikFetch<{ data: { attributes: Record<string, unknown> } }>(
      `/api/apps/v2/${summary.id}`
    );
    const attributes = detail.data.attributes;
    apps.push({
      id: summary.id,
      name: String(attributes.name ?? summary.id),
      urls: (attributes.urls as string[]) ?? [],
      timezone: String(attributes.timezone ?? "UTC"),
      currency: String(attributes.currency ?? "EUR"),
    });
  }
  return apps;
}

// Most columns are plain scalars, but dimension columns like location_country_name,
// referrer_type and device_type return a [code, label] tuple instead.
type QueryValue = string | number | [string | null, string | null];

interface QueryRow {
  [key: string]: QueryValue;
}

async function queryAnalytics(body: Record<string, unknown>, priority: "normal" | "bulk" = "normal"): Promise<QueryRow[]> {
  const res = await piwikFetch<{ meta: { columns: string[] }; data: QueryValue[][] }>(
    "/api/analytics/v1/query",
    { method: "POST", body: JSON.stringify(body) },
    priority
  );
  return res.data.map((row) => {
    const record: QueryRow = {};
    res.meta.columns.forEach((col, i) => {
      record[col] = row[i];
    });
    return record;
  });
}

// A single-day query returns a handful of rows (one per channel/goal at
// most), no chunking needed -- but a long multi-day range broken down by day
// can run into hundreds or thousands of rows. `limit`/`offset` pagination on
// this endpoint was never confirmed (no test org access), and a real run
// showed exactly the failure mode that guess would cause if wrong: no error,
// but only the most recent slice of a long range actually came back (older
// months stayed at zero even though Piwik Pro's own UI has real traffic
// there). Rather than keep guessing at pagination, split the range into
// short chunks up front -- each chunk's row count then stays comfortably
// under any plausible single-page limit without needing pagination at all.
//
// 90 days (doubled from an earlier, more conservative 45) -- the actual
// bottleneck for the 26-month extension is total REQUEST COUNT against
// Piwik Pro's 60/min hard limit, not per-request payload size, so halving
// the chunk count directly halves how long a full extension takes. Not a
// blind guess: this only widens the SAME chunking strategy that already
// works (still well short of the single unchunked mega-range that caused
// the original silent-truncation failure above), and MAX_PLAUSIBLE_ROWS_PER_CHUNK
// below scales with it, so a chunk that's actually too big is caught by
// assertPlausible (row-count sanity check) or the per-range spot-check in
// getMetricsRange and safely falls back to per-day fetching for that one
// site/range -- never silently wrong data, just slower for that one case.
const RANGE_CHUNK_DAYS = 90;
const MAX_PLAUSIBLE_ROWS_PER_CHUNK = 3600;
// A handful of chunks in flight at once instead of one-at-a-time -- fully
// sequential was a deliberate over-correction after ~950 simultaneously
// pending requests (Promise.all over every chunk) looked like it was
// crashing the process on a memory-constrained instance. A small cap keeps
// peak concurrency an order of magnitude below that (5 sites x 5 query
// types x 3 = ~75 max) while still overlapping network latency instead of
// paying it chunk by chunk -- the real bottleneck either way is the shared
// rate limiter, not concurrency.
const CHUNK_CONCURRENCY = 3;

function splitIntoChunks(dateFrom: string, dateTo: string, chunkDays: number = RANGE_CHUNK_DAYS): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let from = dateFrom;
  while (from <= dateTo) {
    const to = addDaysIso(from, chunkDays - 1);
    chunks.push({ from, to: to > dateTo ? dateTo : to });
    from = addDaysIso(to, 1);
  }
  return chunks;
}

async function queryAnalyticsRange(
  body: Record<string, unknown>,
  dateFrom: string,
  dateTo: string,
  chunkDays: number = RANGE_CHUNK_DAYS,
  maxRowsPerChunk: number = MAX_PLAUSIBLE_ROWS_PER_CHUNK
): Promise<QueryRow[]> {
  const chunks = splitIntoChunks(dateFrom, dateTo, chunkDays);
  const rows: QueryRow[] = [];
  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
    const batchResults = await Promise.all(
      // "bulk" priority: see BULK_SHARE_OF_LIMIT -- this is the deep-backfill
      // path, it must never be able to starve the daily cron/on-demand calls.
      batch.map((c) => queryAnalytics({ ...body, date_from: c.from, date_to: c.to }, "bulk"))
    );
    for (const r of batchResults) rows.push(...r);
  }
  if (rows.length > chunks.length * maxRowsPerChunk) {
    throw new Error(
      `[piwik] range query returned ${rows.length} rows across ${chunks.length} chunk(s) of ${chunkDays} days -- ` +
        `a single chunk is exceeding the plausible row count, likely hitting an unconfirmed per-request row limit`
    );
  }
  return rows;
}

function extractDay(row: QueryRow): string {
  const value = row[COLUMN_IDS.dayDimension];
  const raw = Array.isArray(value) ? value[0] ?? value[1] : value;
  // Robust to either a pure "YYYY-MM-DD" or a full "YYYY-MM-DDTHH:mm:ssZ" --
  // the first 10 characters are the calendar day either way.
  return String(raw ?? "").slice(0, 10);
}

// `website_name`'s tuple is [siteId, hostname] (confirmed live) -- the id,
// not the label, is what this app keys everything by.
function extractSiteId(row: QueryRow): string {
  const value = row[WEBSITE_NAME_COLUMN.column_id];
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw ?? "");
}

/**
 * Shared by getMetricsRange and getMetricsRangeAllSites: verifies a batched
 * day-dimension breakdown against the proven single-day path (no day
 * dimension at all) for a couple of real days, throwing only if BOTH
 * disagree. Confirmed live that a single fixed date can independently
 * return 0/no row from the day-dimension breakdown while the rest of the
 * same range is fine -- reproduced on a day 7 days old and, separately, on
 * 2025-01-01 (8+ months old), ruling out "too recent" as the mechanism.
 * Whatever causes it affects one date at a time, not the whole range, so
 * requiring only ONE of two independent candidate dates to agree tells a
 * genuine systematic distortion (wrong column id, unexpected scope
 * behavior -- shows up on every date, including both candidates) apart
 * from this per-date quirk (implausible to hit both candidates at once).
 * Tolerant per date, not exact: two back-to-back queries a few seconds
 * apart can drift slightly even on an otherwise-fine day.
 */
async function spotCheckAgainstSingleDay(
  siteId: string,
  dateFrom: string,
  dateTo: string,
  getBatchedSessions: (date: string) => number | undefined,
  label: string = "range query"
): Promise<void> {
  const midpoint = addDaysIso(dateFrom, Math.floor(daysBetweenInclusive(dateFrom, dateTo) / 2));
  const candidates = [...new Set([dateFrom, midpoint])].filter((d) => getBatchedSessions(d) !== undefined);
  if (candidates.length === 0) return;

  const results = await Promise.all(
    candidates.map(async (date) => {
      const [reference] = await queryAnalytics({
        website_id: siteId,
        date_from: date,
        date_to: date,
        columns: [{ column_id: COLUMN_IDS.sessions }],
      });
      const referenceSessions = Number(reference?.[COLUMN_IDS.sessions] ?? 0);
      const batchedSessions = getBatchedSessions(date) ?? 0;
      const tolerance = Math.max(5, referenceSessions * 0.1);
      return { date, referenceSessions, batchedSessions, tolerance, ok: Math.abs(referenceSessions - batchedSessions) <= tolerance };
    })
  );

  if (results.every((r) => !r.ok)) {
    const detail = results.map((r) => `${r.date}: batched=${r.batchedSessions} vs single-day=${r.referenceSessions} (tolerance ${Math.round(r.tolerance)})`).join("; ");
    throw new Error(
      `[piwik] ${label} spot-check mismatch for ${siteId} on all ${results.length} checked date(s) -- ${detail} -- ` +
        `the day-dimension breakdown may be distorting session totals, refusing to write this range`
    );
  } else if (results.some((r) => !r.ok)) {
    const mismatched = results.filter((r) => !r.ok);
    console.warn(`[piwik] ${label} spot-check: ${siteId} disagreed on ${mismatched.map((r) => r.date).join(", ")} but agreed on at least one other date -- proceeding, likely a per-date quirk rather than systematic distortion.`);
  }
}

export async function getDailyMetrics(siteId: string, date: string): Promise<DailySiteMetrics> {
  // Merged with the downloads count: both are plain whole-day aggregates
  // with no dimension breakdown, and both are already "required" (neither
  // is wrapped in the try/catch pattern the 3 truly optional queries below
  // use) -- so combining them into one call loses no failure-isolation that
  // existed before, and cuts a call off every single day/site fetch.
  const [totals] = await queryAnalytics({
    website_id: siteId,
    date_from: date,
    date_to: date,
    columns: [
      { column_id: COLUMN_IDS.sessions },
      { column_id: COLUMN_IDS.users },
      { column_id: COLUMN_IDS.pageviews },
      { column_id: COLUMN_IDS.goalConversions },
      { column_id: COLUMN_IDS.bounceRate },
      { column_id: COLUMN_IDS.downloads },
    ],
  });

  const channelRows = await queryAnalytics({
    website_id: siteId,
    date_from: date,
    date_to: date,
    columns: [{ column_id: COLUMN_IDS.channelDimension }, { column_id: COLUMN_IDS.sessions }],
  });

  const channels: Record<Channel, number> = {
    organic: 0,
    direct: 0,
    referral: 0,
    paid: 0,
    social: 0,
    email: 0,
    other: 0,
  };
  for (const row of channelRows) {
    const label = String(row[COLUMN_IDS.channelDimension] ?? "");
    const channel = CHANNEL_MAP[label] ?? "other";
    channels[channel] += Number(row[COLUMN_IDS.sessions] ?? 0);
  }

  // Goal names are configured per-site (see goalCategories.ts) -- classify by
  // keyword rather than assuming goal ids/names line up across sites.
  const goalRows = await queryAnalytics({
    website_id: siteId,
    date_from: date,
    date_to: date,
    columns: [{ column_id: COLUMN_IDS.goalDimension }, { column_id: COLUMN_IDS.goalConversions }],
  });
  let rfqConversions = 0;
  let supportConversions = 0;
  for (const row of goalRows) {
    const value = row[COLUMN_IDS.goalDimension];
    const goalName = Array.isArray(value) ? value[1] : null;
    if (!goalName) continue;
    const category = categorizeGoal(goalName);
    const count = Number(row[COLUMN_IDS.goalConversions] ?? 0);
    if (category === "rfq") rfqConversions += count;
    else if (category === "support") supportConversions += count;
  }

  const [aiReferralSessions, organicBouncesAndDirect, searchConsole] = await Promise.all([
    fetchAiReferralSessions(siteId, date),
    fetchChannelBounces(siteId, date),
    fetchSearchConsoleTotals(siteId, date),
  ]);

  return {
    siteId,
    date,
    sessions: Number(totals?.[COLUMN_IDS.sessions] ?? 0),
    users: Number(totals?.[COLUMN_IDS.users] ?? 0),
    pageviews: Number(totals?.[COLUMN_IDS.pageviews] ?? 0),
    goalConversions: Number(totals?.[COLUMN_IDS.goalConversions] ?? 0),
    bounceRate: Number(totals?.[COLUMN_IDS.bounceRate] ?? 0),
    avgSessionDurationSec: 0, // TODO: no valid column id found yet (see comment above)
    channels,
    rfqConversions,
    supportConversions,
    downloads: Number(totals?.[COLUMN_IDS.downloads] ?? 0),
    aiReferralSessions: aiReferralSessions.value,
    organicBounces: organicBouncesAndDirect.value.organic,
    directBounces: organicBouncesAndDirect.value.direct,
    searchConsoleClicks: searchConsole.value.clicks,
    searchConsoleImpressions: searchConsole.value.impressions,
  };
}

/**
 * Same shape of data as getDailyMetrics, but for a whole [dateFrom, dateTo]
 * range in ~7 requests per RANGE_CHUNK_DAYS-day chunk instead of ~7 requests
 * PER DAY -- each query adds COLUMN_IDS.dayDimension as a breakdown
 * dimension so one call returns every day in that chunk at once. Still a
 * large multiplier over the naive per-day approach (a 791-day backfill is
 * ~7 * ceil(791/45) ≈ 126 requests per site instead of ~5500), and what
 * makes a real multi-month backfill practical against Piwik Pro's
 * per-minute rate limit.
 *
 * Relies on the unverified `dayDimension` column id (see COLUMN_IDS comment).
 * Throws if anything about that assumption is wrong (bad column id, or a
 * response shape wildly inconsistent with "one row per calendar day") --
 * callers must catch and fall back to per-day getDailyMetrics calls, see
 * sync.ts. Never returns partial/guessed data.
 */
export async function getMetricsRange(siteId: string, dateFrom: string, dateTo: string): Promise<DailySiteMetrics[]> {
  const expectedDays = daysBetweenInclusive(dateFrom, dateTo);
  // Loose upper bound sanity check: a day x channel/goal/source breakdown
  // shouldn't realistically exceed ~40 rows/day (channels + goals + sources
  // combined comfortably fit under that for any real site). If the day
  // dimension is actually behaving as a per-event/per-visit timestamp
  // instead of a calendar-day bucket, row counts blow past this immediately
  // and we bail out rather than silently misgroup thousands of rows.
  const maxPlausibleRows = expectedDays * 40 + 100;

  function assertPlausible(rows: QueryRow[], label: string): void {
    if (rows.length > maxPlausibleRows) {
      throw new Error(
        `[piwik] range query "${label}" for ${siteId} returned ${rows.length} rows for ${expectedDays} day(s) -- ` +
          `far more than plausible for a day-bucketed breakdown, dayDimension column id is probably wrong`
      );
    }
  }

  // 5 query types instead of 7: unlike getDailyMetrics, this function has no
  // per-field failure isolation to begin with (all 7 were already combined
  // into one Promise.all where any single failure throws and fails the whole
  // range -- see the "Range mode has no way to isolate..." comment below), so
  // merging queries that share the same dimension shape costs nothing here.
  // downloads folds into totals (both plain whole-day aggregates); bounces
  // folds into the channel breakdown (same channelDimension grouping) --
  // cutting a meaningful fraction of the total request count on exactly the
  // path most bound by Piwik Pro's per-minute rate limit (the 26-month
  // extension).
  const [totalsRows, channelRows, goalRows, sourceRows, gscRows] = await Promise.all([
    queryAnalyticsRange({
      website_id: siteId,
      columns: [
        DAY_DIMENSION_COLUMN,
        { column_id: COLUMN_IDS.sessions },
        { column_id: COLUMN_IDS.users },
        { column_id: COLUMN_IDS.pageviews },
        { column_id: COLUMN_IDS.goalConversions },
        { column_id: COLUMN_IDS.bounceRate },
        { column_id: COLUMN_IDS.downloads },
      ],
    }, dateFrom, dateTo),
    queryAnalyticsRange({
      website_id: siteId,
      columns: [
        DAY_DIMENSION_COLUMN,
        { column_id: COLUMN_IDS.channelDimension },
        { column_id: COLUMN_IDS.sessions },
        { column_id: COLUMN_IDS.bounces },
      ],
    }, dateFrom, dateTo),
    queryAnalyticsRange({
      website_id: siteId,
      columns: [DAY_DIMENSION_COLUMN, { column_id: COLUMN_IDS.goalDimension }, { column_id: COLUMN_IDS.goalConversions }],
    }, dateFrom, dateTo),
    queryAnalyticsRange({
      website_id: siteId,
      columns: [DAY_DIMENSION_COLUMN, { column_id: COLUMN_IDS.sourceDimension }, { column_id: COLUMN_IDS.sessions }],
    }, dateFrom, dateTo),
    queryAnalyticsRange({
      website_id: siteId,
      columns: [DAY_DIMENSION_COLUMN, { column_id: COLUMN_IDS.searchConsoleClicks }, { column_id: COLUMN_IDS.searchConsoleImpressions }],
    }, dateFrom, dateTo),
  ]);

  assertPlausible(totalsRows, "totals");
  assertPlausible(channelRows, "channels");
  assertPlausible(goalRows, "goals");
  assertPlausible(sourceRows, "sources");
  assertPlausible(gscRows, "search-console");

  interface DayAccumulator {
    sessions: number;
    users: number;
    pageviews: number;
    goalConversions: number;
    bounceRate: number;
    channels: Record<Channel, number>;
    rfqConversions: number;
    supportConversions: number;
    downloads: number;
    aiReferralSessions: number;
    organicBounces: number;
    directBounces: number;
    searchConsoleClicks: number;
    searchConsoleImpressions: number;
  }

  const byDay = new Map<string, DayAccumulator>();
  function dayBucket(date: string): DayAccumulator {
    let bucket = byDay.get(date);
    if (!bucket) {
      bucket = {
        sessions: 0,
        users: 0,
        pageviews: 0,
        goalConversions: 0,
        bounceRate: 0,
        channels: { organic: 0, direct: 0, referral: 0, paid: 0, social: 0, email: 0, other: 0 },
        rfqConversions: 0,
        supportConversions: 0,
        downloads: 0,
        aiReferralSessions: 0,
        organicBounces: 0,
        directBounces: 0,
        searchConsoleClicks: 0,
        searchConsoleImpressions: 0,
      };
      byDay.set(date, bucket);
    }
    return bucket;
  }
  // Every day in the range gets a bucket up front -- a day with zero Piwik
  // Pro rows (no traffic that day) still gets a real zero-filled entry,
  // exactly like getDailyMetrics does for a single quiet day.
  for (let d = dateFrom; d <= dateTo; d = addDaysIso(d, 1)) dayBucket(d);

  // Lookup-only for actual API rows -- unlike dayBucket above (which creates
  // on demand, correct for the pre-fill loop), a row whose day-dimension
  // value is missing, malformed, or outside [dateFrom, dateTo] must be
  // dropped, not silently bucketed under whatever extractDay(row) happened
  // to return. This is not hypothetical: an aggregate/totals row without a
  // real per-day breakdown extracts to "" (see extractDay), and dayBucket("")
  // would create a brand-new bucket keyed by an empty string -- which then
  // gets upserted to Postgres as a real row with date='' (site_snapshots.date
  // has no format constraint), corrupting every MIN(date)/earliest-date
  // query in the app (an empty string sorts before any real date). Skipping
  // instead means the batch quietly loses that one row's contribution rather
  // than writing corrupt data -- consistent with CLAUDE.md's data-integrity
  // priority: an undercount for one query type on one range is far better
  // than a poisoned date propagating through every history calculation.
  let skippedRows = 0;
  function dayBucketForRow(date: string): DayAccumulator | null {
    const bucket = byDay.get(date);
    if (!bucket) {
      skippedRows++;
      return null;
    }
    return bucket;
  }

  for (const row of totalsRows) {
    const bucket = dayBucketForRow(extractDay(row));
    if (!bucket) continue;
    bucket.sessions = Number(row[COLUMN_IDS.sessions] ?? 0);
    bucket.users = Number(row[COLUMN_IDS.users] ?? 0);
    bucket.pageviews = Number(row[COLUMN_IDS.pageviews] ?? 0);
    bucket.goalConversions = Number(row[COLUMN_IDS.goalConversions] ?? 0);
    bucket.bounceRate = Number(row[COLUMN_IDS.bounceRate] ?? 0);
    bucket.downloads = Number(row[COLUMN_IDS.downloads] ?? 0);
  }
  for (const row of channelRows) {
    const bucket = dayBucketForRow(extractDay(row));
    if (!bucket) continue;
    const label = String(row[COLUMN_IDS.channelDimension] ?? "");
    const channel = CHANNEL_MAP[label] ?? "other";
    bucket.channels[channel] += Number(row[COLUMN_IDS.sessions] ?? 0);
    const bounceCount = Number(row[COLUMN_IDS.bounces] ?? 0);
    if (label === "organic") bucket.organicBounces += bounceCount;
    else if (label === "direct") bucket.directBounces += bounceCount;
  }
  for (const row of goalRows) {
    const bucket = dayBucketForRow(extractDay(row));
    if (!bucket) continue;
    const value = row[COLUMN_IDS.goalDimension];
    const goalName = Array.isArray(value) ? value[1] : null;
    if (!goalName) continue;
    const category = categorizeGoal(goalName);
    const count = Number(row[COLUMN_IDS.goalConversions] ?? 0);
    if (category === "rfq") bucket.rfqConversions += count;
    else if (category === "support") bucket.supportConversions += count;
  }
  for (const row of sourceRows) {
    const value = row[COLUMN_IDS.sourceDimension];
    const source = String(Array.isArray(value) ? value[1] ?? value[0] : value ?? "");
    if (!source || !isAiReferrerSource(source)) continue;
    const bucket = dayBucketForRow(extractDay(row));
    if (!bucket) continue;
    bucket.aiReferralSessions += Number(row[COLUMN_IDS.sessions] ?? 0);
  }
  for (const row of gscRows) {
    const bucket = dayBucketForRow(extractDay(row));
    if (!bucket) continue;
    bucket.searchConsoleClicks = Number(row[COLUMN_IDS.searchConsoleClicks] ?? 0);
    bucket.searchConsoleImpressions = Number(row[COLUMN_IDS.searchConsoleImpressions] ?? 0);
  }
  if (skippedRows > 0) {
    console.warn(`[piwik] range query for ${siteId} (${dateFrom}..${dateTo}): skipped ${skippedRows} row(s) with a missing/out-of-range day value instead of writing them under a corrupt date.`);
  }

  // Automatic ongoing guard, not a one-off manual test: verify the batched
  // day-dimension breakdown agrees with the proven single-day path (no day
  // dimension at all) for a couple of real days out of this range, every
  // time this function runs. This is exactly the check that a wrong column
  // id or a scope-forcing regression on Piwik Pro's side would fail --
  // catching it automatically here (and refusing to write the batch, see
  // the throw below) matters more than the extra Piwik Pro call cost: 2
  // calls per getMetricsRange invocation is negligible next to the
  // hundreds saved by batching at all.
  //
  // Checks 2 independent candidate dates, not 1, and only fails if BOTH
  // disagree -- confirmed live that a SINGLE fixed date can independently
  // return 0/no row from the day-dimension breakdown while every other date
  // in the same range is fine, and a plain single-day query for that exact
  // date returns real, correct data. First seen on a day 7 days old
  // (checking dateTo back then), then on 2025-01-01 specifically -- 8+
  // months old, ruling out "too recent" as the actual cause. Whatever the
  // real mechanism, it affects one date at a time, not the whole range, so
  // requiring only ONE of two independent dates to agree tells genuine
  // systematic distortion (which shows up on every date, including both
  // candidates) apart from this per-date quirk (which wouldn't plausibly
  // hit both candidates at once).
  await spotCheckAgainstSingleDay(siteId, dateFrom, dateTo, (date) => byDay.get(date)?.sessions);

  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => ({
      siteId,
      date,
      sessions: bucket.sessions,
      users: bucket.users,
      pageviews: bucket.pageviews,
      goalConversions: bucket.goalConversions,
      bounceRate: bucket.bounceRate,
      avgSessionDurationSec: 0,
      channels: bucket.channels,
      rfqConversions: bucket.rfqConversions,
      supportConversions: bucket.supportConversions,
      downloads: bucket.downloads,
      // Range mode has no way to isolate a single-day failure the way
      // getDailyMetrics's Promise.all-with-try/catch-per-query does -- these
      // 3 optional queries either succeed for the whole range (real numbers
      // for every day) or the whole getMetricsRange call throws and the
      // caller falls back to per-day fetching, so null never applies here.
      aiReferralSessions: bucket.aiReferralSessions,
      organicBounces: bucket.organicBounces,
      directBounces: bucket.directBounces,
      searchConsoleClicks: bucket.searchConsoleClicks,
      searchConsoleImpressions: bucket.searchConsoleImpressions,
    }));
}

// A day x site x (channel/goal/source) breakdown against the roll-up
// property is far denser per request than the same breakdown against one
// real site -- every row now multiplies by however many sites the roll-up
// covers. A smaller chunk keeps each request's row count in the same
// ballpark as what the per-site path already handles reliably, while still
// needing far fewer total requests than querying every site separately
// (chunks x query-types x 1 roll-up property, instead of x however many
// sites).
const ROLLUP_RANGE_CHUNK_DAYS = 30;

/**
 * Same data as getMetricsRange, but for EVERY known site in one pass:
 * queries the Roll-Up Reporting property (see config.ts#piwikRollupSiteId)
 * once per query type/chunk instead of once per query type/chunk/site --
 * cutting Piwik Pro request volume for the 26-month sync by roughly the
 * site count (confirmed live: 24 sites on one `website_name` breakdown
 * query, ~20x fewer requests than the per-site path for this account).
 *
 * `knownSiteIds` is the allowlist of this app's actually-tracked sites
 * (see repo.ts#getSites) -- the roll-up property can include properties
 * this app doesn't track (test sites, tool subdomains already excluded by
 * siteScope.ts, ...), and a row for any id not in that allowlist is
 * dropped rather than written, same reasoning as dayBucketForRow below for
 * a malformed date: better to silently under-cover an out-of-scope id than
 * write a snapshot row for a site this app has no record of and no
 * business tracking.
 *
 * Every safety net from getMetricsRange applies here too, scaled for the
 * extra site dimension: assertPlausible's row-count ceiling multiplies by
 * site count, and the spot-check compares one real (site, day) pair
 * against the proven single-site getDailyMetrics path. Throws (never
 * returns partial/guessed data) if anything looks wrong; the caller (see
 * sync.ts) falls back to the per-site path.
 */
export async function getMetricsRangeAllSites(
  rollupSiteId: string,
  dateFrom: string,
  dateTo: string,
  knownSiteIds: Set<string>
): Promise<Map<string, DailySiteMetrics[]>> {
  const expectedDays = daysBetweenInclusive(dateFrom, dateTo);
  const maxPlausibleRows = expectedDays * 40 * Math.max(knownSiteIds.size, 1) + 500;

  function assertPlausible(rows: QueryRow[], label: string): void {
    if (rows.length > maxPlausibleRows) {
      throw new Error(
        `[piwik] roll-up range query "${label}" returned ${rows.length} rows for ${expectedDays} day(s) x ${knownSiteIds.size} site(s) -- ` +
          `far more than plausible for a day+site-bucketed breakdown, dayDimension or website_name column id is probably wrong`
      );
    }
  }

  const rangeArgs = [dateFrom, dateTo, ROLLUP_RANGE_CHUNK_DAYS, maxPlausibleRows] as const;
  const [totalsRows, channelRows, goalRows, sourceRows, gscRows] = await Promise.all([
    queryAnalyticsRange({
      website_id: rollupSiteId,
      columns: [
        DAY_DIMENSION_COLUMN,
        WEBSITE_NAME_COLUMN,
        { column_id: COLUMN_IDS.sessions },
        { column_id: COLUMN_IDS.users },
        { column_id: COLUMN_IDS.pageviews },
        { column_id: COLUMN_IDS.goalConversions },
        { column_id: COLUMN_IDS.bounceRate },
        { column_id: COLUMN_IDS.downloads },
      ],
    }, ...rangeArgs),
    queryAnalyticsRange({
      website_id: rollupSiteId,
      columns: [
        DAY_DIMENSION_COLUMN,
        WEBSITE_NAME_COLUMN,
        { column_id: COLUMN_IDS.channelDimension },
        { column_id: COLUMN_IDS.sessions },
        { column_id: COLUMN_IDS.bounces },
      ],
    }, ...rangeArgs),
    queryAnalyticsRange({
      website_id: rollupSiteId,
      columns: [DAY_DIMENSION_COLUMN, WEBSITE_NAME_COLUMN, { column_id: COLUMN_IDS.goalDimension }, { column_id: COLUMN_IDS.goalConversions }],
    }, ...rangeArgs),
    queryAnalyticsRange({
      website_id: rollupSiteId,
      columns: [DAY_DIMENSION_COLUMN, WEBSITE_NAME_COLUMN, { column_id: COLUMN_IDS.sourceDimension }, { column_id: COLUMN_IDS.sessions }],
    }, ...rangeArgs),
    queryAnalyticsRange({
      website_id: rollupSiteId,
      columns: [DAY_DIMENSION_COLUMN, WEBSITE_NAME_COLUMN, { column_id: COLUMN_IDS.searchConsoleClicks }, { column_id: COLUMN_IDS.searchConsoleImpressions }],
    }, ...rangeArgs),
  ]);

  assertPlausible(totalsRows, "totals");
  assertPlausible(channelRows, "channels");
  assertPlausible(goalRows, "goals");
  assertPlausible(sourceRows, "sources");
  assertPlausible(gscRows, "search-console");

  interface DayAccumulator {
    sessions: number;
    users: number;
    pageviews: number;
    goalConversions: number;
    bounceRate: number;
    channels: Record<Channel, number>;
    rfqConversions: number;
    supportConversions: number;
    downloads: number;
    aiReferralSessions: number;
    organicBounces: number;
    directBounces: number;
    searchConsoleClicks: number;
    searchConsoleImpressions: number;
  }

  // siteId -> date -> accumulator, pre-filled for every (known site, date)
  // pair so a quiet day still gets a real zero-filled entry.
  const bySite = new Map<string, Map<string, DayAccumulator>>();
  function emptyAccumulator(): DayAccumulator {
    return {
      sessions: 0,
      users: 0,
      pageviews: 0,
      goalConversions: 0,
      bounceRate: 0,
      channels: { organic: 0, direct: 0, referral: 0, paid: 0, social: 0, email: 0, other: 0 },
      rfqConversions: 0,
      supportConversions: 0,
      downloads: 0,
      aiReferralSessions: 0,
      organicBounces: 0,
      directBounces: 0,
      searchConsoleClicks: 0,
      searchConsoleImpressions: 0,
    };
  }
  for (const siteId of knownSiteIds) {
    const byDay = new Map<string, DayAccumulator>();
    for (let d = dateFrom; d <= dateTo; d = addDaysIso(d, 1)) byDay.set(d, emptyAccumulator());
    bySite.set(siteId, byDay);
  }

  // Lookup-only, like getMetricsRange's dayBucketForRow -- a row whose site
  // id isn't tracked, or whose day is missing/malformed/out-of-range, is
  // dropped rather than bucketed under a value that was never validated.
  let skippedRows = 0;
  function bucketForRow(row: QueryRow): DayAccumulator | null {
    const siteId = extractSiteId(row);
    const byDay = bySite.get(siteId);
    if (!byDay) {
      skippedRows++;
      return null;
    }
    const bucket = byDay.get(extractDay(row));
    if (!bucket) {
      skippedRows++;
      return null;
    }
    return bucket;
  }

  for (const row of totalsRows) {
    const bucket = bucketForRow(row);
    if (!bucket) continue;
    bucket.sessions = Number(row[COLUMN_IDS.sessions] ?? 0);
    bucket.users = Number(row[COLUMN_IDS.users] ?? 0);
    bucket.pageviews = Number(row[COLUMN_IDS.pageviews] ?? 0);
    bucket.goalConversions = Number(row[COLUMN_IDS.goalConversions] ?? 0);
    bucket.bounceRate = Number(row[COLUMN_IDS.bounceRate] ?? 0);
    bucket.downloads = Number(row[COLUMN_IDS.downloads] ?? 0);
  }
  for (const row of channelRows) {
    const bucket = bucketForRow(row);
    if (!bucket) continue;
    const label = String(row[COLUMN_IDS.channelDimension] ?? "");
    const channel = CHANNEL_MAP[label] ?? "other";
    bucket.channels[channel] += Number(row[COLUMN_IDS.sessions] ?? 0);
    const bounceCount = Number(row[COLUMN_IDS.bounces] ?? 0);
    if (label === "organic") bucket.organicBounces += bounceCount;
    else if (label === "direct") bucket.directBounces += bounceCount;
  }
  for (const row of goalRows) {
    const bucket = bucketForRow(row);
    if (!bucket) continue;
    const value = row[COLUMN_IDS.goalDimension];
    const goalName = Array.isArray(value) ? value[1] : null;
    if (!goalName) continue;
    const category = categorizeGoal(goalName);
    const count = Number(row[COLUMN_IDS.goalConversions] ?? 0);
    if (category === "rfq") bucket.rfqConversions += count;
    else if (category === "support") bucket.supportConversions += count;
  }
  for (const row of sourceRows) {
    const value = row[COLUMN_IDS.sourceDimension];
    const source = String(Array.isArray(value) ? value[1] ?? value[0] : value ?? "");
    if (!source || !isAiReferrerSource(source)) continue;
    const bucket = bucketForRow(row);
    if (!bucket) continue;
    bucket.aiReferralSessions += Number(row[COLUMN_IDS.sessions] ?? 0);
  }
  for (const row of gscRows) {
    const bucket = bucketForRow(row);
    if (!bucket) continue;
    bucket.searchConsoleClicks = Number(row[COLUMN_IDS.searchConsoleClicks] ?? 0);
    bucket.searchConsoleImpressions = Number(row[COLUMN_IDS.searchConsoleImpressions] ?? 0);
  }
  if (skippedRows > 0) {
    console.warn(`[piwik] roll-up range query (${dateFrom}..${dateTo}): skipped ${skippedRows} row(s) with an untracked site or a missing/out-of-range day value.`);
  }

  // Spot-check one real site's (site, day) pairs against the proven
  // single-site path -- same tolerant, 2-independent-candidate-date
  // comparison as getMetricsRange's (see spotCheckAgainstSingleDay's doc
  // comment): a SINGLE fixed date can independently return 0/no row from
  // the day-dimension breakdown -- first seen on a day 7 days old, then on
  // 2025-01-01 specifically (8+ months old, ruling out "too recent" as the
  // cause) -- while a plain single-day query for that exact date returns
  // real data. Only fails if both candidate dates disagree.
  const spotCheckSiteId = [...knownSiteIds][0];
  if (spotCheckSiteId) {
    await spotCheckAgainstSingleDay(
      spotCheckSiteId,
      dateFrom,
      dateTo,
      (date) => bySite.get(spotCheckSiteId)?.get(date)?.sessions,
      "roll-up"
    );
  }

  const result = new Map<string, DailySiteMetrics[]>();
  for (const [siteId, byDay] of bySite) {
    result.set(
      siteId,
      [...byDay.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, bucket]) => ({
          siteId,
          date,
          sessions: bucket.sessions,
          users: bucket.users,
          pageviews: bucket.pageviews,
          goalConversions: bucket.goalConversions,
          bounceRate: bucket.bounceRate,
          avgSessionDurationSec: 0,
          channels: bucket.channels,
          rfqConversions: bucket.rfqConversions,
          supportConversions: bucket.supportConversions,
          downloads: bucket.downloads,
          aiReferralSessions: bucket.aiReferralSessions,
          organicBounces: bucket.organicBounces,
          directBounces: bucket.directBounces,
          searchConsoleClicks: bucket.searchConsoleClicks,
          searchConsoleImpressions: bucket.searchConsoleImpressions,
        }))
    );
  }
  return result;
}

interface ProbeResult<T> {
  value: T;
  ok: boolean;
  error?: string;
}

// AI-assistant referral traffic (see aiReferrers.ts): sum sessions whose
// `source` matches a known AI domain, regardless of medium. Returns `null`
// (not 0) on failure -- see the DayPoint/DailySiteMetrics doc comments for why
// that distinction matters -- and is also used standalone by the
// /api/diagnostics/optional-metrics route so a real Piwik Pro error message
// (wrong column id, auth, ...) is visible from the dashboard instead of only
// ever showing up as a silent 0 with the reason buried in server logs.
async function fetchAiReferralSessions(siteId: string, date: string): Promise<ProbeResult<number | null>> {
  try {
    const sourceRows = await queryAnalytics({
      website_id: siteId,
      date_from: date,
      date_to: date,
      columns: [{ column_id: COLUMN_IDS.sourceDimension }, { column_id: COLUMN_IDS.sessions }],
    });
    let total = 0;
    for (const row of sourceRows) {
      const value = row[COLUMN_IDS.sourceDimension];
      const source = String(Array.isArray(value) ? value[1] ?? value[0] : value ?? "");
      if (source && isAiReferrerSource(source)) {
        total += Number(row[COLUMN_IDS.sessions] ?? 0);
      }
    }
    return { value: total, ok: true };
  } catch (err) {
    console.warn(`[piwik] source breakdown query failed for ${siteId}/${date}, aiReferralSessions=null:`, err);
    return { value: null, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Bot-trend proxy: single-pageview ("bounced") sessions on the organic/direct
// channels -- real engagement is rare on floods of near-zero-interaction hits.
async function fetchChannelBounces(siteId: string, date: string): Promise<ProbeResult<{ organic: number | null; direct: number | null }>> {
  try {
    const bounceRows = await queryAnalytics({
      website_id: siteId,
      date_from: date,
      date_to: date,
      columns: [{ column_id: COLUMN_IDS.channelDimension }, { column_id: COLUMN_IDS.bounces }],
    });
    let organic = 0;
    let direct = 0;
    for (const row of bounceRows) {
      const label = String(row[COLUMN_IDS.channelDimension] ?? "");
      const count = Number(row[COLUMN_IDS.bounces] ?? 0);
      if (label === "organic") organic += count;
      else if (label === "direct") direct += count;
    }
    return { value: { organic, direct }, ok: true };
  } catch (err) {
    console.warn(`[piwik] bounces-by-medium query failed for ${siteId}/${date}, organic/directBounces=null:`, err);
    return { value: { organic: null, direct: null }, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Google Search Console (see COLUMN_IDS comment): a query failure here can
// mean the integration genuinely isn't configured for this site in Piwik
// Pro, but it can equally mean a wrong column id or an unrelated API error --
// null (not 0) so the UI shows "non disponible" rather than a confirmed zero,
// and the /api/diagnostics/optional-metrics route surfaces the real reason.
async function fetchSearchConsoleTotals(siteId: string, date: string): Promise<ProbeResult<{ clicks: number | null; impressions: number | null }>> {
  try {
    const [gscTotals] = await queryAnalytics({
      website_id: siteId,
      date_from: date,
      date_to: date,
      columns: [{ column_id: COLUMN_IDS.searchConsoleClicks }, { column_id: COLUMN_IDS.searchConsoleImpressions }],
    });
    return {
      value: {
        clicks: Number(gscTotals?.[COLUMN_IDS.searchConsoleClicks] ?? 0),
        impressions: Number(gscTotals?.[COLUMN_IDS.searchConsoleImpressions] ?? 0),
      },
      ok: true,
    };
  } catch (err) {
    console.warn(`[piwik] Search Console query failed for ${siteId}/${date} (integration not configured for this site?), =null:`, err);
    return { value: { clicks: null, impressions: null }, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface OptionalMetricsDiagnostics {
  siteId: string;
  siteName: string;
  date: string;
  aiReferral: { ok: boolean; error?: string };
  channelBounces: { ok: boolean; error?: string };
  searchConsole: { ok: boolean; error?: string };
}

/**
 * Runs the same 3 optional queries as getDailyMetrics for a single site/day
 * and reports success/failure + the real error message for each -- exposed
 * via GET /api/diagnostics/optional-metrics so a "0" on the dashboard can be
 * told apart from a broken query without needing to dig through server logs.
 */
export async function probeOptionalMetrics(siteId: string, siteName: string, date: string): Promise<OptionalMetricsDiagnostics> {
  const [ai, bounces, gsc] = await Promise.all([
    fetchAiReferralSessions(siteId, date),
    fetchChannelBounces(siteId, date),
    fetchSearchConsoleTotals(siteId, date),
  ]);
  return {
    siteId,
    siteName,
    date,
    aiReferral: { ok: ai.ok, error: ai.error },
    channelBounces: { ok: bounces.ok, error: bounces.error },
    searchConsole: { ok: gsc.ok, error: gsc.error },
  };
}

export interface CountryChannelRow {
  country: string;
  channel: Channel;
  sessions: number;
}

/**
 * Country x channel sessions breakdown for a site over a date range. Used by
 * geoMismatch.ts to tell whether an unexpected country's traffic is organic
 * (SEO/indexing issue, or a bot/crawler wave misreading the site's geo-targeting)
 * or direct (real visitors typing/bookmarking the URL -- e.g. a legitimate
 * diaspora/expat audience), since the right follow-up action differs.
 */
export async function getCountryChannelBreakdown(siteId: string, dateFrom: string, dateTo: string): Promise<CountryChannelRow[]> {
  const rows = await queryAnalytics({
    website_id: siteId,
    date_from: dateFrom,
    date_to: dateTo,
    columns: [{ column_id: COLUMN_IDS.countryDimension }, { column_id: COLUMN_IDS.channelDimension }, { column_id: COLUMN_IDS.sessions }],
  });
  return rows
    .map((r) => {
      const countryValue = r[COLUMN_IDS.countryDimension];
      const isoCode = Array.isArray(countryValue) ? countryValue[0] : countryValue;
      const label = String(r[COLUMN_IDS.channelDimension] ?? "");
      return {
        country: String(isoCode ?? "").toUpperCase(),
        channel: CHANNEL_MAP[label] ?? "other",
        sessions: Number(r[COLUMN_IDS.sessions] ?? 0),
      };
    })
    .filter((c) => c.country);
}

export interface RollupProbeResult {
  // Every Piwik Pro app whose name contains "all" (case-insensitive) --
  // candidates for a Roll-Up Reporting meta-property that aggregates every
  // country site. Unfiltered by siteScope.ts on purpose: a roll-up property
  // has no real per-country domain, so the normal site-discovery scope
  // filter would silently exclude it.
  candidateApps: Array<{ id: string; name: string; urls: string[] }>;
  // Whether the query endpoint accepts an ARRAY of website_id values in one
  // call (would let the app fetch several real sites' data in a single
  // request, no roll-up property needed at all) -- tried against 2 real
  // known site ids.
  multiSiteArrayTest: { attempted: boolean; ok: boolean; error?: string; rowCount?: number; sampleRow?: unknown };
  // For each candidate roll-up app, tries a list of plausible "which
  // original site did this row come from" dimension column ids -- there's
  // no documentation to go on here (this account has no test/sandbox
  // access), so this is deliberately an empirical probe: real success/error
  // per guess, not a guess baked into production code.
  rollupDimensionProbes: Array<{ appId: string; appName: string; columnId: string; ok: boolean; error?: string; rowCount?: number; sampleRows?: QueryRow[] }>;
}

const ROLLUP_SITE_DIMENSION_CANDIDATES = [
  "website_id",
  "site_id",
  "app_id",
  "website",
  "site",
  "origin_website_id",
  "source_website_id",
  "data_source_website_id",
  "website_name",
];

/**
 * One-shot empirical probe run from a diagnostics route (see
 * routes/api.ts#/api/diagnostics/rollup-site) to answer a specific question
 * raised directly: can the app query ONE Piwik Pro property (either a
 * multi-site array in a normal query, or a Roll-Up Reporting meta-property)
 * and get every country's data back broken down by origin site, instead of
 * one request per site per query type? If either works, it could cut Piwik
 * Pro request volume by roughly the site count (~20x) -- the real fix for
 * "26-month sync is too slow" this whole optimization pass has been
 * approximating with smaller wins (chunk size, merged queries). Read-only:
 * every probe here is a live query, nothing is written to the database.
 */
export async function probeRollupSite(knownSiteIds: string[], explicitSiteIds: string[] = []): Promise<RollupProbeResult> {
  const today = new Date().toISOString().slice(0, 10);
  const allApps = await listApps();
  const candidateApps = allApps.filter((a) => /all/i.test(a.name)).map((a) => ({ id: a.id, name: a.name, urls: a.urls }));
  // A Roll-Up Reporting property doesn't necessarily show up in
  // /api/apps/v2 (confirmed empty here) -- when the site owner supplies its
  // ID directly (e.g. copied from the Piwik Pro UI), test it too, name
  // unknown.
  for (const id of explicitSiteIds) {
    if (!candidateApps.some((a) => a.id === id)) candidateApps.push({ id, name: "(id fourni directement)", urls: [] });
  }

  const multiSiteArrayTest: RollupProbeResult["multiSiteArrayTest"] = { attempted: false, ok: false };
  if (knownSiteIds.length >= 2) {
    multiSiteArrayTest.attempted = true;
    try {
      const rows = await queryAnalytics({
        website_id: knownSiteIds.slice(0, 2),
        date_from: today,
        date_to: today,
        columns: [{ column_id: COLUMN_IDS.sessions }],
      });
      multiSiteArrayTest.ok = true;
      multiSiteArrayTest.rowCount = rows.length;
      multiSiteArrayTest.sampleRow = rows[0];
    } catch (err) {
      multiSiteArrayTest.error = err instanceof Error ? err.message : String(err);
    }
  }

  const rollupDimensionProbes: RollupProbeResult["rollupDimensionProbes"] = [];
  for (const app of candidateApps) {
    for (const columnId of ROLLUP_SITE_DIMENSION_CANDIDATES) {
      try {
        const rows = await queryAnalytics({
          website_id: app.id,
          date_from: today,
          date_to: today,
          columns: [{ column_id: columnId }, { column_id: COLUMN_IDS.sessions }],
        });
        rollupDimensionProbes.push({ appId: app.id, appName: app.name, columnId, ok: true, rowCount: rows.length, sampleRows: rows.slice(0, 5) });
      } catch (err) {
        rollupDimensionProbes.push({ appId: app.id, appName: app.name, columnId, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { candidateApps, multiSiteArrayTest, rollupDimensionProbes };
}
