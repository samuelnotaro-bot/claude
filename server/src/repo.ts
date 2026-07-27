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
      rfq_conversions, support_conversions, downloads
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    ON CONFLICT (site_id, date) DO UPDATE SET
      sessions = excluded.sessions, users = excluded.users, pageviews = excluded.pageviews,
      goal_conversions = excluded.goal_conversions, bounce_rate = excluded.bounce_rate,
      avg_session_duration_sec = excluded.avg_session_duration_sec,
      channel_organic = excluded.channel_organic, channel_direct = excluded.channel_direct,
      channel_referral = excluded.channel_referral, channel_paid = excluded.channel_paid,
      channel_social = excluded.channel_social, channel_email = excluded.channel_email,
      channel_other = excluded.channel_other,
      rfq_conversions = excluded.rfq_conversions, support_conversions = excluded.support_conversions,
      downloads = excluded.downloads`,
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
