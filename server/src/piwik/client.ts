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
const RANGE_CHUNK_DAYS = 45;
const MAX_PLAUSIBLE_ROWS_PER_CHUNK = 1800;
// A handful of chunks in flight at once instead of one-at-a-time -- fully
// sequential was a deliberate over-correction after ~950 simultaneously
// pending requests (Promise.all over every chunk) looked like it was
// crashing the process on a memory-constrained instance. A small cap keeps
// peak concurrency an order of magnitude below that (5 sites x 7 query
// types x 3 = ~105 max) while still overlapping network latency instead of
// paying it chunk by chunk -- the real bottleneck either way is the shared
// rate limiter, not concurrency.
const CHUNK_CONCURRENCY = 3;

function splitIntoChunks(dateFrom: string, dateTo: string): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let from = dateFrom;
  while (from <= dateTo) {
    const to = addDaysIso(from, RANGE_CHUNK_DAYS - 1);
    chunks.push({ from, to: to > dateTo ? dateTo : to });
    from = addDaysIso(to, 1);
  }
  return chunks;
}

async function queryAnalyticsRange(body: Record<string, unknown>, dateFrom: string, dateTo: string): Promise<QueryRow[]> {
  const chunks = splitIntoChunks(dateFrom, dateTo);
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
  if (rows.length > chunks.length * MAX_PLAUSIBLE_ROWS_PER_CHUNK) {
    throw new Error(
      `[piwik] range query returned ${rows.length} rows across ${chunks.length} chunk(s) of ${RANGE_CHUNK_DAYS} days -- ` +
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

export async function getDailyMetrics(siteId: string, date: string): Promise<DailySiteMetrics> {
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

  const [downloadsTotal] = await queryAnalytics({
    website_id: siteId,
    date_from: date,
    date_to: date,
    columns: [{ column_id: COLUMN_IDS.downloads }],
  });

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
    downloads: Number(downloadsTotal?.[COLUMN_IDS.downloads] ?? 0),
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

  const [totalsRows, channelRows, goalRows, downloadRows, sourceRows, bounceRows, gscRows] = await Promise.all([
    queryAnalyticsRange({
      website_id: siteId,
      columns: [
        DAY_DIMENSION_COLUMN,
        { column_id: COLUMN_IDS.sessions },
        { column_id: COLUMN_IDS.users },
        { column_id: COLUMN_IDS.pageviews },
        { column_id: COLUMN_IDS.goalConversions },
        { column_id: COLUMN_IDS.bounceRate },
      ],
    }, dateFrom, dateTo),
    queryAnalyticsRange({
      website_id: siteId,
      columns: [DAY_DIMENSION_COLUMN, { column_id: COLUMN_IDS.channelDimension }, { column_id: COLUMN_IDS.sessions }],
    }, dateFrom, dateTo),
    queryAnalyticsRange({
      website_id: siteId,
      columns: [DAY_DIMENSION_COLUMN, { column_id: COLUMN_IDS.goalDimension }, { column_id: COLUMN_IDS.goalConversions }],
    }, dateFrom, dateTo),
    queryAnalyticsRange({
      website_id: siteId,
      columns: [DAY_DIMENSION_COLUMN, { column_id: COLUMN_IDS.downloads }],
    }, dateFrom, dateTo),
    queryAnalyticsRange({
      website_id: siteId,
      columns: [DAY_DIMENSION_COLUMN, { column_id: COLUMN_IDS.sourceDimension }, { column_id: COLUMN_IDS.sessions }],
    }, dateFrom, dateTo),
    queryAnalyticsRange({
      website_id: siteId,
      columns: [DAY_DIMENSION_COLUMN, { column_id: COLUMN_IDS.channelDimension }, { column_id: COLUMN_IDS.bounces }],
    }, dateFrom, dateTo),
    queryAnalyticsRange({
      website_id: siteId,
      columns: [DAY_DIMENSION_COLUMN, { column_id: COLUMN_IDS.searchConsoleClicks }, { column_id: COLUMN_IDS.searchConsoleImpressions }],
    }, dateFrom, dateTo),
  ]);

  assertPlausible(totalsRows, "totals");
  assertPlausible(channelRows, "channels");
  assertPlausible(goalRows, "goals");
  assertPlausible(downloadRows, "downloads");
  assertPlausible(sourceRows, "sources");
  assertPlausible(bounceRows, "bounces");
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
  }
  for (const row of channelRows) {
    const bucket = dayBucketForRow(extractDay(row));
    if (!bucket) continue;
    const label = String(row[COLUMN_IDS.channelDimension] ?? "");
    const channel = CHANNEL_MAP[label] ?? "other";
    bucket.channels[channel] += Number(row[COLUMN_IDS.sessions] ?? 0);
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
  for (const row of downloadRows) {
    const bucket = dayBucketForRow(extractDay(row));
    if (!bucket) continue;
    bucket.downloads = Number(row[COLUMN_IDS.downloads] ?? 0);
  }
  for (const row of sourceRows) {
    const value = row[COLUMN_IDS.sourceDimension];
    const source = String(Array.isArray(value) ? value[1] ?? value[0] : value ?? "");
    if (!source || !isAiReferrerSource(source)) continue;
    const bucket = dayBucketForRow(extractDay(row));
    if (!bucket) continue;
    bucket.aiReferralSessions += Number(row[COLUMN_IDS.sessions] ?? 0);
  }
  for (const row of bounceRows) {
    const bucket = dayBucketForRow(extractDay(row));
    if (!bucket) continue;
    const label = String(row[COLUMN_IDS.channelDimension] ?? "");
    const count = Number(row[COLUMN_IDS.bounces] ?? 0);
    if (label === "organic") bucket.organicBounces += count;
    else if (label === "direct") bucket.directBounces += count;
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
  // dimension at all) for one real day out of this range, every time this
  // function runs. This is exactly the check that a wrong column id or a
  // scope-forcing regression on Piwik Pro's side would fail -- catching it
  // automatically here (and refusing to write the batch, see the throw
  // below) matters more than the extra Piwik Pro call costs: one call per
  // getMetricsRange invocation (once per site per range-fetch, not once per
  // chunk) is negligible next to the hundreds saved by batching at all.
  //
  // Tolerant, not exact: when dateTo is yesterday (e.g. a site with no prior
  // data extends its whole range up to yesterday), Piwik Pro's own numbers
  // can still be settling between the two back-to-back queries this check
  // makes, a few seconds apart -- an exact-match requirement would throw on
  // that harmless drift and block every range fetch for such a site, not
  // just the genuinely distorted ones. A real scope-forcing bug (the thing
  // this guards against) shows up as a large, systematic gap, not a
  // handful of sessions -- so only flag a difference too big to be drift.
  const spotCheckDate = dateTo;
  const spotCheckBucket = byDay.get(spotCheckDate);
  if (spotCheckBucket) {
    const [reference] = await queryAnalytics({
      website_id: siteId,
      date_from: spotCheckDate,
      date_to: spotCheckDate,
      columns: [{ column_id: COLUMN_IDS.sessions }],
    });
    const referenceSessions = Number(reference?.[COLUMN_IDS.sessions] ?? 0);
    const tolerance = Math.max(5, referenceSessions * 0.1);
    if (Math.abs(referenceSessions - spotCheckBucket.sessions) > tolerance) {
      throw new Error(
        `[piwik] range query spot-check mismatch for ${siteId}/${spotCheckDate}: batched sessions=${spotCheckBucket.sessions} vs single-day sessions=${referenceSessions} ` +
          `(tolerance ${Math.round(tolerance)}) -- the day-dimension breakdown may be distorting session totals, refusing to write this range`
      );
    }
  }

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
