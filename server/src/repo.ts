import { pool } from "./db.js";
import type { Continent } from "./continent.js";
import type { DailySiteMetrics } from "./piwik/types.js";

export interface SiteRecord {
  id: string;
  name: string;
  continent: Continent;
  continentSource: "auto" | "manual";
  detectedCountry: string | null;
  updatedAt: string;
}

export async function upsertSite(site: {
  id: string;
  name: string;
  continent: Continent;
  continentSource: "auto" | "manual";
  detectedCountry: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO sites (id, name, continent, continent_source, detected_country, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       name = excluded.name,
       continent = CASE WHEN sites.continent_source = 'manual' THEN sites.continent ELSE excluded.continent END,
       detected_country = excluded.detected_country,
       updated_at = excluded.updated_at`,
    [site.id, site.name, site.continent, site.continentSource, site.detectedCountry, new Date().toISOString()]
  );
}

/** Removes any previously-synced site (and its snapshots) that is no longer in scope. */
export async function pruneSites(keepIds: string[]): Promise<void> {
  if (keepIds.length === 0) {
    await pool.query(`DELETE FROM site_snapshots`);
    await pool.query(`DELETE FROM sites`);
    return;
  }
  await pool.query(`DELETE FROM site_snapshots WHERE site_id <> ALL($1)`, [keepIds]);
  await pool.query(`DELETE FROM sites WHERE id <> ALL($1)`, [keepIds]);
}

export async function getSites(): Promise<SiteRecord[]> {
  const { rows } = await pool.query(`SELECT * FROM sites ORDER BY name`);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    continent: r.continent,
    continentSource: r.continent_source,
    detectedCountry: r.detected_country,
    updatedAt: r.updated_at,
  }));
}

export async function upsertSnapshot(m: DailySiteMetrics): Promise<void> {
  await pool.query(
    `INSERT INTO site_snapshots (
      site_id, date, sessions, users, pageviews, goal_conversions, bounce_rate, avg_session_duration_sec,
      channel_organic, channel_direct, channel_referral, channel_paid, channel_social, channel_email, channel_other,
      rfq_conversions, support_conversions, downloads,
      ai_referral_sessions, organic_bounces, direct_bounces, search_console_clicks, search_console_impressions
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
    ON CONFLICT (site_id, date) DO UPDATE SET
      sessions = excluded.sessions, users = excluded.users, pageviews = excluded.pageviews,
      goal_conversions = excluded.goal_conversions, bounce_rate = excluded.bounce_rate,
      avg_session_duration_sec = excluded.avg_session_duration_sec,
      channel_organic = excluded.channel_organic, channel_direct = excluded.channel_direct,
      channel_referral = excluded.channel_referral, channel_paid = excluded.channel_paid,
      channel_social = excluded.channel_social, channel_email = excluded.channel_email,
      channel_other = excluded.channel_other,
      rfq_conversions = excluded.rfq_conversions, support_conversions = excluded.support_conversions,
      downloads = excluded.downloads,
      ai_referral_sessions = excluded.ai_referral_sessions, organic_bounces = excluded.organic_bounces,
      direct_bounces = excluded.direct_bounces, search_console_clicks = excluded.search_console_clicks,
      search_console_impressions = excluded.search_console_impressions`,
    [
      m.siteId,
      m.date,
      m.sessions,
      m.users,
      m.pageviews,
      m.goalConversions,
      m.bounceRate,
      m.avgSessionDurationSec,
      m.channels.organic,
      m.channels.direct,
      m.channels.referral,
      m.channels.paid,
      m.channels.social,
      m.channels.email,
      m.channels.other,
      m.rfqConversions,
      m.supportConversions,
      m.downloads,
      m.aiReferralSessions,
      m.organicBounces,
      m.directBounces,
      m.searchConsoleClicks,
      m.searchConsoleImpressions,
    ]
  );
}

export interface SnapshotRow {
  siteId: string;
  date: string;
  sessions: number;
  users: number;
  pageviews: number;
  goalConversions: number;
  bounceRate: number;
  avgSessionDurationSec: number;
  channels: { organic: number; direct: number; referral: number; paid: number; social: number; email: number; other: number };
  rfqConversions: number;
  supportConversions: number;
  downloads: number;
  /** null = not fetched (query failure/integration not configured), distinct from a confirmed 0 -- see piwik/types.ts. */
  aiReferralSessions: number | null;
  organicBounces: number | null;
  directBounces: number | null;
  searchConsoleClicks: number | null;
  searchConsoleImpressions: number | null;
}

export async function getSnapshots(dateFrom: string, dateTo: string): Promise<SnapshotRow[]> {
  const { rows } = await pool.query(`SELECT * FROM site_snapshots WHERE date BETWEEN $1 AND $2 ORDER BY date`, [dateFrom, dateTo]);
  return rows.map(rowToSnapshot);
}

export async function getSnapshotsForSite(siteId: string, dateFrom: string, dateTo: string): Promise<SnapshotRow[]> {
  const { rows } = await pool.query(
    `SELECT * FROM site_snapshots WHERE site_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date`,
    [siteId, dateFrom, dateTo]
  );
  return rows.map(rowToSnapshot);
}

/**
 * Bulk equivalent of getSnapshotsForSite for many sites at once -- a single
 * round trip instead of one query per site. Used by the aggregate endpoints
 * (overview/regions/sites summary) which previously fired one query per site
 * per request, the main source of slow page loads on a remote free-tier DB.
 */
export async function getSnapshotsForSites(siteIds: string[], dateFrom: string, dateTo: string): Promise<Map<string, SnapshotRow[]>> {
  const byId = new Map<string, SnapshotRow[]>(siteIds.map((id) => [id, []]));
  if (siteIds.length === 0) return byId;
  const { rows } = await pool.query(
    `SELECT * FROM site_snapshots WHERE site_id = ANY($1) AND date BETWEEN $2 AND $3 ORDER BY date`,
    [siteIds, dateFrom, dateTo]
  );
  for (const r of rows) {
    const snapshot = rowToSnapshot(r);
    const list = byId.get(snapshot.siteId);
    if (list) list.push(snapshot);
  }
  return byId;
}

// Guards every date-aggregate query below against a malformed `date` value
// (the column has no format constraint) -- an empty string or any other
// non-YYYY-MM-DD value sorts before every real date, so a single stray row
// like that would silently become the MIN() and corrupt every
// earliest-date/gap calculation in the app. See piwik/client.ts's
// dayBucketForRow for where such a row could have come from (fixed there
// too, so this is defense in depth against whatever may already be in the
// database from before that fix).
const VALID_DATE_SQL = `date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`;

/** Earliest date with any snapshot data at all -- used to tell "not enough history yet" apart from "data gap". */
export async function getEarliestSnapshotDate(): Promise<string | null> {
  const { rows } = await pool.query(`SELECT MIN(date) AS earliest FROM site_snapshots WHERE ${VALID_DATE_SQL}`);
  return rows[0]?.earliest ?? null;
}

/**
 * Same as getEarliestSnapshotDate, but per site rather than one global
 * minimum -- a global MIN() is misleading when sites don't all have the same
 * amount of history (e.g. one site got a handful of very old rows from an
 * interrupted run while the rest didn't): it makes it look like "there's
 * nothing older to fetch" even though most sites still have a large gap.
 *
 * Only counts rows with sessions > 0 -- a row with 0 sessions is
 * indistinguishable, just from its presence, between "Piwik Pro genuinely
 * had zero traffic that day" and "a broken fetch (wrong column id, a range
 * silently truncated by an unconfirmed pagination guess, ...) wrote a
 * zero-filled placeholder for a day it never actually retrieved". Treating
 * an all-zero range as "not really covered yet" means a site poisoned by an
 * earlier bug gets correctly re-targeted and healed by the next extension
 * run instead of being silently skipped forever because it already has
 * *some* row that old.
 *
 * Used by sync.ts#extendHistoryToRetentionFloor to extend each site's own
 * history independently instead of trusting a single shared earliest date.
 */
export async function getEarliestSnapshotDateBySite(siteIds: string[]): Promise<Map<string, string | null>> {
  const byId = new Map<string, string | null>(siteIds.map((id) => [id, null]));
  if (siteIds.length === 0) return byId;
  const { rows } = await pool.query(
    `SELECT site_id, MIN(date) AS earliest FROM site_snapshots WHERE site_id = ANY($1) AND sessions > 0 AND ${VALID_DATE_SQL} GROUP BY site_id`,
    [siteIds]
  );
  for (const r of rows) {
    byId.set(r.site_id, r.earliest);
  }
  return byId;
}

/** Most recent date with any snapshot data at all -- used at boot to catch up on days missed while asleep (see index.ts). */
export async function getLatestSnapshotDate(): Promise<string | null> {
  const { rows } = await pool.query(`SELECT MAX(date) AS latest FROM site_snapshots WHERE ${VALID_DATE_SQL}`);
  return rows[0]?.latest ?? null;
}

/**
 * Which dates each site actually has a snapshot for, within a range -- a
 * single lightweight query (dates only, no metric columns) used to find gaps
 * *inside* the existing history (see sync.ts#backfillGaps), not just missing
 * days at the tail end. A cron run skipped mid-history (e.g. the process was
 * asleep, or a deploy briefly broke the Piwik connection) otherwise stays a
 * silent hole forever, which is what made some periods show no data at all
 * and made period-over-period comparisons look unreliable.
 */
export async function getSnapshotDatesBySite(siteIds: string[], dateFrom: string, dateTo: string): Promise<Map<string, Set<string>>> {
  const byId = new Map<string, Set<string>>(siteIds.map((id) => [id, new Set()]));
  if (siteIds.length === 0) return byId;
  const { rows } = await pool.query(
    `SELECT site_id, date FROM site_snapshots WHERE site_id = ANY($1) AND date BETWEEN $2 AND $3`,
    [siteIds, dateFrom, dateTo]
  );
  for (const r of rows) {
    byId.get(r.site_id)?.add(r.date);
  }
  return byId;
}

/**
 * (site, date) pairs within a range whose stored row reports exactly 0
 * sessions -- indistinguishable by presence alone from a genuinely quiet
 * day, but also exactly what a broken fetch writes (a real bug fixed
 * earlier today: an unbounded hang, and a since-corrected batched-query
 * issue, could each produce a confirmed-wrong zero for a day that actually
 * had traffic). getSnapshotDatesBySite (presence-only) will never re-fetch
 * one of these -- see sync.ts#revalidateRecentZeroDays, which uses this to
 * re-verify a bounded recent window once instead of trusting a zero forever.
 */
export async function getZeroSessionDatesBySite(siteIds: string[], dateFrom: string, dateTo: string): Promise<Map<string, string[]>> {
  const byId = new Map<string, string[]>(siteIds.map((id) => [id, []]));
  if (siteIds.length === 0) return byId;
  const { rows } = await pool.query(
    `SELECT site_id, date FROM site_snapshots WHERE site_id = ANY($1) AND date BETWEEN $2 AND $3 AND sessions = 0`,
    [siteIds, dateFrom, dateTo]
  );
  for (const r of rows) {
    byId.get(r.site_id)?.push(r.date);
  }
  return byId;
}

function rowToSnapshot(r: any): SnapshotRow {
  return {
    siteId: r.site_id,
    date: r.date,
    sessions: r.sessions,
    users: r.users,
    pageviews: r.pageviews,
    goalConversions: r.goal_conversions,
    bounceRate: r.bounce_rate,
    avgSessionDurationSec: r.avg_session_duration_sec,
    channels: {
      organic: r.channel_organic,
      direct: r.channel_direct,
      referral: r.channel_referral,
      paid: r.channel_paid,
      social: r.channel_social,
      email: r.channel_email,
      other: r.channel_other,
    },
    rfqConversions: r.rfq_conversions,
    supportConversions: r.support_conversions,
    downloads: r.downloads,
    aiReferralSessions: r.ai_referral_sessions,
    organicBounces: r.organic_bounces,
    directBounces: r.direct_bounces,
    searchConsoleClicks: r.search_console_clicks,
    searchConsoleImpressions: r.search_console_impressions,
  };
}

export interface SynthesisRecord {
  id: number;
  generatedAt: string;
  periodFrom: string;
  periodTo: string;
  bullets: string[];
  highlights: Record<string, unknown>;
}

export async function saveSynthesis(s: { periodFrom: string; periodTo: string; bullets: string[]; highlights: Record<string, unknown> }): Promise<void> {
  await pool.query(
    `INSERT INTO synthesis_history (generated_at, period_from, period_to, bullets, highlights)
     VALUES ($1, $2, $3, $4, $5)`,
    [new Date().toISOString(), s.periodFrom, s.periodTo, JSON.stringify(s.bullets), JSON.stringify(s.highlights)]
  );
}

export async function getLatestSynthesis(): Promise<SynthesisRecord | null> {
  const { rows } = await pool.query(`SELECT * FROM synthesis_history ORDER BY id DESC LIMIT 1`);
  return rows[0] ? rowToSynthesis(rows[0]) : null;
}

export async function getSynthesisHistory(limit = 20): Promise<SynthesisRecord[]> {
  const { rows } = await pool.query(`SELECT * FROM synthesis_history ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.map(rowToSynthesis);
}

function rowToSynthesis(r: any): SynthesisRecord {
  return {
    id: r.id,
    generatedAt: r.generated_at,
    periodFrom: r.period_from,
    periodTo: r.period_to,
    bullets: JSON.parse(r.bullets),
    highlights: JSON.parse(r.highlights),
  };
}

export interface GeoMismatchRecord {
  siteId: string;
  siteName: string;
  /** Human-readable description of the traffic origin expected for this site (a single country, or a region for emea./apac.socomec.com). */
  expectedLabel: string;
  expectedShare: number;
  topUnexpectedCountry: string;
  topUnexpectedShare: number;
  totalSessions: number;
  /** Of the unexpected country's sessions, the share coming from the organic channel. */
  unexpectedOrganicShare: number;
  /** Of the unexpected country's sessions, the share coming from the direct channel. */
  unexpectedDirectShare: number;
  /** Rule-based starter analysis / action plan for this finding (see geoMismatch.ts). */
  actionPlan: string;
  /** When this record was last checked -- these are stored from the last manual/scheduled check, not recomputed live for whichever period is currently selected elsewhere in the app. */
  checkedAt?: string;
}

/** Replaces the whole table with the latest check's findings (see geoMismatch.ts). */
export async function saveGeoMismatches(mismatches: GeoMismatchRecord[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM geo_mismatches");
    const checkedAt = new Date().toISOString();
    for (const m of mismatches) {
      await client.query(
        `INSERT INTO geo_mismatches (site_id, site_name, expected_label, expected_share, top_unexpected_country, top_unexpected_share, total_sessions, checked_at, unexpected_organic_share, unexpected_direct_share, action_plan)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          m.siteId,
          m.siteName,
          m.expectedLabel,
          m.expectedShare,
          m.topUnexpectedCountry,
          m.topUnexpectedShare,
          m.totalSessions,
          checkedAt,
          m.unexpectedOrganicShare,
          m.unexpectedDirectShare,
          m.actionPlan,
        ]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getGeoMismatches(): Promise<GeoMismatchRecord[]> {
  const { rows } = await pool.query(`SELECT * FROM geo_mismatches ORDER BY top_unexpected_share DESC`);
  return rows.map((r) => ({
    siteId: r.site_id,
    siteName: r.site_name,
    expectedLabel: r.expected_label,
    expectedShare: r.expected_share,
    topUnexpectedCountry: r.top_unexpected_country,
    topUnexpectedShare: r.top_unexpected_share,
    totalSessions: r.total_sessions,
    unexpectedOrganicShare: r.unexpected_organic_share,
    unexpectedDirectShare: r.unexpected_direct_share,
    actionPlan: r.action_plan,
    checkedAt: r.checked_at instanceof Date ? r.checked_at.toISOString() : r.checked_at,
  }));
}
