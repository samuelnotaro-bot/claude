import { config } from "../config.js";
import type { PiwikApp, DailySiteMetrics, CountryBreakdown, Channel } from "./types.js";
import { categorizeGoal } from "../goalCategories.js";

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
  };
}

export async function getTopCountry(siteId: string, dateFrom: string, dateTo: string): Promise<CountryBreakdown | null> {
  const rows = await queryAnalytics({
    website_id: siteId,
    date_from: dateFrom,
    date_to: dateTo,
    columns: [{ column_id: COLUMN_IDS.countryDimension }, { column_id: COLUMN_IDS.sessions }],
  });
  if (rows.length === 0) return null;
  const sorted = rows
    .map((r) => {
      const value = r[COLUMN_IDS.countryDimension];
      const isoCode = Array.isArray(value) ? value[0] : value;
      return {
        country: String(isoCode ?? ""),
        sessions: Number(r[COLUMN_IDS.sessions] ?? 0),
      };
    })
    .sort((a, b) => b.sessions - a.sessions);
  return sorted[0] ?? null;
}
