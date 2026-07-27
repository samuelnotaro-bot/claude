import { db } from "./db.js";
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

export function upsertSite(site: {
  id: string;
  name: string;
  continent: Continent;
  continentSource: "auto" | "manual";
  detectedCountry: string | null;
}) {
  db.prepare(
    `INSERT INTO sites (id, name, continent, continent_source, detected_country, updated_at)
     VALUES (@id, @name, @continent, @continentSource, @detectedCountry, @updatedAt)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       continent = CASE WHEN sites.continent_source = 'manual' THEN sites.continent ELSE excluded.continent END,
       detected_country = excluded.detected_country,
       updated_at = excluded.updated_at`
  ).run({ ...site, updatedAt: new Date().toISOString() });
}

export function getSites(): SiteRecord[] {
  const rows = db.prepare(`SELECT * FROM sites ORDER BY name`).all() as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    continent: r.continent,
    continentSource: r.continent_source,
    detectedCountry: r.detected_country,
    updatedAt: r.updated_at,
  }));
}

export function upsertSnapshot(m: DailySiteMetrics) {
  db.prepare(
    `INSERT INTO site_snapshots (
      site_id, date, sessions, users, pageviews, goal_conversions, bounce_rate, avg_session_duration_sec,
      channel_organic, channel_direct, channel_referral, channel_paid, channel_social, channel_email, channel_other
    ) VALUES (
      @siteId, @date, @sessions, @users, @pageviews, @goalConversions, @bounceRate, @avgSessionDurationSec,
      @organic, @direct, @referral, @paid, @social, @email, @other
    )
    ON CONFLICT(site_id, date) DO UPDATE SET
      sessions = excluded.sessions, users = excluded.users, pageviews = excluded.pageviews,
      goal_conversions = excluded.goal_conversions, bounce_rate = excluded.bounce_rate,
      avg_session_duration_sec = excluded.avg_session_duration_sec,
      channel_organic = excluded.channel_organic, channel_direct = excluded.channel_direct,
      channel_referral = excluded.channel_referral, channel_paid = excluded.channel_paid,
      channel_social = excluded.channel_social, channel_email = excluded.channel_email,
      channel_other = excluded.channel_other`
  ).run({
    siteId: m.siteId,
    date: m.date,
    sessions: m.sessions,
    users: m.users,
    pageviews: m.pageviews,
    goalConversions: m.goalConversions,
    bounceRate: m.bounceRate,
    avgSessionDurationSec: m.avgSessionDurationSec,
    organic: m.channels.organic,
    direct: m.channels.direct,
    referral: m.channels.referral,
    paid: m.channels.paid,
    social: m.channels.social,
    email: m.channels.email,
    other: m.channels.other,
  });
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
}

export function getSnapshots(dateFrom: string, dateTo: string): SnapshotRow[] {
  const rows = db
    .prepare(`SELECT * FROM site_snapshots WHERE date BETWEEN ? AND ? ORDER BY date`)
    .all(dateFrom, dateTo) as any[];
  return rows.map(rowToSnapshot);
}

export function getSnapshotsForSite(siteId: string, dateFrom: string, dateTo: string): SnapshotRow[] {
  const rows = db
    .prepare(`SELECT * FROM site_snapshots WHERE site_id = ? AND date BETWEEN ? AND ? ORDER BY date`)
    .all(siteId, dateFrom, dateTo) as any[];
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

export function saveSynthesis(s: { periodFrom: string; periodTo: string; bullets: string[]; highlights: Record<string, unknown> }) {
  db.prepare(
    `INSERT INTO synthesis_history (generated_at, period_from, period_to, bullets, highlights)
     VALUES (?, ?, ?, ?, ?)`
  ).run(new Date().toISOString(), s.periodFrom, s.periodTo, JSON.stringify(s.bullets), JSON.stringify(s.highlights));
}

export function getLatestSynthesis(): SynthesisRecord | null {
  const row = db.prepare(`SELECT * FROM synthesis_history ORDER BY id DESC LIMIT 1`).get() as any;
  return row ? rowToSynthesis(row) : null;
}

export function getSynthesisHistory(limit = 20): SynthesisRecord[] {
  const rows = db.prepare(`SELECT * FROM synthesis_history ORDER BY id DESC LIMIT ?`).all(limit) as any[];
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
