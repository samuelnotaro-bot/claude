import { config } from "../config.js";
import type { PiwikApp, DailySiteMetrics, CountryBreakdown, Channel } from "./types.js";

/**
 * Thin client for the Piwik Pro REST APIs (Management API v2 + Analytics Query API v1).
 * Endpoint paths and column ids follow the public Piwik Pro API documentation
 * (https://developers.piwik.pro/) at the time of writing. Piwik Pro occasionally
 * revises column ids between API versions -- if `npm run backfill` returns empty
 * metrics in live mode, check the "Query API" reference in the Piwik Pro API
 * Explorer for your organization and adjust COLUMN_IDS below.
 */

const COLUMN_IDS = {
  sessions: "session",
  users: "unique_visitors",
  pageviews: "page_view",
  goalConversions: "goal_conversion",
  bounceRate: "bounce_rate",
  avgSessionDuration: "session_duration",
  channelDimension: "source_medium_channel_grouping",
  countryDimension: "country",
};

const CHANNEL_MAP: Record<string, Channel> = {
  "Organic Search": "organic",
  "Direct": "direct",
  "Referral": "referral",
  "Paid Search": "paid",
  "Paid Social": "paid",
  "Social": "social",
  "Email": "email",
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

export async function listApps(): Promise<PiwikApp[]> {
  const res = await piwikFetch<{ data: Array<{ id: string; attributes: Record<string, unknown> }> }>(
    "/api/apps/v2"
  );
  return res.data.map((app) => ({
    id: app.id,
    name: String(app.attributes.name ?? app.id),
    urls: (app.attributes.urls as string[]) ?? [],
    timezone: String(app.attributes.timezone ?? "UTC"),
    currency: String(app.attributes.currency ?? "EUR"),
  }));
}

interface QueryRow {
  [key: string]: string | number;
}

async function queryAnalytics(body: Record<string, unknown>): Promise<QueryRow[]> {
  const res = await piwikFetch<{ columns: string[]; data: (string | number)[][] }>(
    "/api/analytics/v1/query",
    { method: "POST", body: JSON.stringify(body) }
  );
  return res.data.map((row) => {
    const record: QueryRow = {};
    res.columns.forEach((col, i) => {
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
      { columnId: COLUMN_IDS.sessions },
      { columnId: COLUMN_IDS.users },
      { columnId: COLUMN_IDS.pageviews },
      { columnId: COLUMN_IDS.goalConversions },
      { columnId: COLUMN_IDS.bounceRate },
      { columnId: COLUMN_IDS.avgSessionDuration },
    ],
  });

  const channelRows = await queryAnalytics({
    website_id: siteId,
    date_from: date,
    date_to: date,
    columns: [{ columnId: COLUMN_IDS.channelDimension }, { columnId: COLUMN_IDS.sessions }],
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

  return {
    siteId,
    date,
    sessions: Number(totals?.[COLUMN_IDS.sessions] ?? 0),
    users: Number(totals?.[COLUMN_IDS.users] ?? 0),
    pageviews: Number(totals?.[COLUMN_IDS.pageviews] ?? 0),
    goalConversions: Number(totals?.[COLUMN_IDS.goalConversions] ?? 0),
    bounceRate: Number(totals?.[COLUMN_IDS.bounceRate] ?? 0),
    avgSessionDurationSec: Number(totals?.[COLUMN_IDS.avgSessionDuration] ?? 0),
    channels,
  };
}

export async function getTopCountry(siteId: string, dateFrom: string, dateTo: string): Promise<CountryBreakdown | null> {
  const rows = await queryAnalytics({
    website_id: siteId,
    date_from: dateFrom,
    date_to: dateTo,
    columns: [{ columnId: COLUMN_IDS.countryDimension }, { columnId: COLUMN_IDS.sessions }],
  });
  if (rows.length === 0) return null;
  const sorted = rows
    .map((r) => ({
      country: String(r[COLUMN_IDS.countryDimension] ?? ""),
      sessions: Number(r[COLUMN_IDS.sessions] ?? 0),
    }))
    .sort((a, b) => b.sessions - a.sessions);
  return sorted[0] ?? null;
}
