import { config } from "../config.js";
import type { PiwikApp, DailySiteMetrics, CountryBreakdown, Channel } from "./types.js";
import { categorizeGoal } from "../goalCategories.js";
import { isAiReferrerSource } from "../aiReferrers.js";

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
};

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

async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 5_000) {
    return tokenCache.accessToken;
  }
  const res = await fetch(`${config.piwik.baseUrl}/auth/token`, {
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

async function piwikFetch<T>(pathAndQuery: string, init: RequestInit = {}): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${config.piwik.baseUrl}${pathAndQuery}`, {
    ...init,
    headers: {
      ...init.headers,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Piwik Pro API error on ${pathAndQuery}: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
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

async function queryAnalytics(body: Record<string, unknown>): Promise<QueryRow[]> {
  const res = await piwikFetch<{ meta: { columns: string[] }; data: QueryValue[][] }>(
    "/api/analytics/v1/query",
    { method: "POST", body: JSON.stringify(body) }
  );
  return res.data.map((row) => {
    const record: QueryRow = {};
    res.meta.columns.forEach((col, i) => {
      record[col] = row[i];
    });
    return record;
  });
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

/** Full visitor-country breakdown (sessions per ISO country code) for a site over a date range, sorted descending. Used by geoMismatch.ts. */
export async function getCountryBreakdown(siteId: string, dateFrom: string, dateTo: string): Promise<CountryBreakdown[]> {
  const rows = await queryAnalytics({
    website_id: siteId,
    date_from: dateFrom,
    date_to: dateTo,
    columns: [{ column_id: COLUMN_IDS.countryDimension }, { column_id: COLUMN_IDS.sessions }],
  });
  return rows
    .map((r) => {
      const value = r[COLUMN_IDS.countryDimension];
      const isoCode = Array.isArray(value) ? value[0] : value;
      return {
        country: String(isoCode ?? "").toUpperCase(),
        sessions: Number(r[COLUMN_IDS.sessions] ?? 0),
      };
    })
    .filter((c) => c.country)
    .sort((a, b) => b.sessions - a.sessions);
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
