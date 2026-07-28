import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

// Render's internal Postgres hostnames (used service-to-service, same private
// network) don't need/support TLS; only external ".render.com" hostnames do.
const needsSsl = /\.render\.com/i.test(config.databaseUrl);

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
});

export async function initSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      continent TEXT NOT NULL DEFAULT 'Unknown',
      continent_source TEXT NOT NULL DEFAULT 'auto',
      detected_country TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS site_snapshots (
      id SERIAL PRIMARY KEY,
      site_id TEXT NOT NULL,
      date TEXT NOT NULL,
      sessions INTEGER NOT NULL DEFAULT 0,
      users INTEGER NOT NULL DEFAULT 0,
      pageviews INTEGER NOT NULL DEFAULT 0,
      goal_conversions INTEGER NOT NULL DEFAULT 0,
      bounce_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
      avg_session_duration_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
      channel_organic INTEGER NOT NULL DEFAULT 0,
      channel_direct INTEGER NOT NULL DEFAULT 0,
      channel_referral INTEGER NOT NULL DEFAULT 0,
      channel_paid INTEGER NOT NULL DEFAULT 0,
      channel_social INTEGER NOT NULL DEFAULT 0,
      channel_email INTEGER NOT NULL DEFAULT 0,
      channel_other INTEGER NOT NULL DEFAULT 0,
      rfq_conversions INTEGER NOT NULL DEFAULT 0,
      support_conversions INTEGER NOT NULL DEFAULT 0,
      downloads INTEGER NOT NULL DEFAULT 0,
      -- Nullable on purpose: these 5 depend on Piwik Pro queries that can fail
      -- independently of the core metrics above (unsupported column, an
      -- integration like Search Console not configured for a given site, a
      -- transient API error). NULL means "not fetched", distinct from a
      -- confirmed 0 -- see the matching comment in piwik/types.ts.
      ai_referral_sessions INTEGER,
      organic_bounces INTEGER,
      direct_bounces INTEGER,
      search_console_clicks INTEGER,
      search_console_impressions INTEGER,
      UNIQUE (site_id, date)
    );
    -- Progressive migration for databases created before these columns existed.
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS rfq_conversions INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS support_conversions INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS downloads INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS ai_referral_sessions INTEGER;
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS organic_bounces INTEGER;
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS direct_bounces INTEGER;
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS search_console_clicks INTEGER;
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS search_console_impressions INTEGER;
    -- These 5 were originally NOT NULL DEFAULT 0 (a fetch failure silently
    -- looked identical to a confirmed zero); relax existing installs so a
    -- future failed fetch can be stored as NULL ("non disponible" in the UI)
    -- instead of a misleading 0. Rows written before this change keep their
    -- existing 0 -- there's no way to retroactively know which of those were
    -- real zeros vs. past failures, so they're left as-is.
    ALTER TABLE site_snapshots ALTER COLUMN ai_referral_sessions DROP NOT NULL;
    ALTER TABLE site_snapshots ALTER COLUMN ai_referral_sessions DROP DEFAULT;
    ALTER TABLE site_snapshots ALTER COLUMN organic_bounces DROP NOT NULL;
    ALTER TABLE site_snapshots ALTER COLUMN organic_bounces DROP DEFAULT;
    ALTER TABLE site_snapshots ALTER COLUMN direct_bounces DROP NOT NULL;
    ALTER TABLE site_snapshots ALTER COLUMN direct_bounces DROP DEFAULT;
    ALTER TABLE site_snapshots ALTER COLUMN search_console_clicks DROP NOT NULL;
    ALTER TABLE site_snapshots ALTER COLUMN search_console_clicks DROP DEFAULT;
    ALTER TABLE site_snapshots ALTER COLUMN search_console_impressions DROP NOT NULL;
    ALTER TABLE site_snapshots ALTER COLUMN search_console_impressions DROP DEFAULT;
    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON site_snapshots (date);
    CREATE INDEX IF NOT EXISTS idx_snapshots_site ON site_snapshots (site_id);
    -- Bulk per-period reads (overview/regions/sites/series) filter by date range
    -- across every site in one query; this composite index keeps that a single
    -- index scan instead of a full table scan as history grows.
    CREATE INDEX IF NOT EXISTS idx_snapshots_site_date ON site_snapshots (site_id, date);

    CREATE TABLE IF NOT EXISTS synthesis_history (
      id SERIAL PRIMARY KEY,
      generated_at TEXT NOT NULL,
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      bullets TEXT NOT NULL,
      highlights TEXT NOT NULL
    );

    -- Latest geo-mismatch check result per site (see geoMismatch.ts). Rewritten
    -- wholesale on each check: only sites currently showing a mismatch appear here.
    CREATE TABLE IF NOT EXISTS geo_mismatches (
      site_id TEXT PRIMARY KEY,
      site_name TEXT NOT NULL,
      expected_label TEXT NOT NULL,
      expected_share DOUBLE PRECISION NOT NULL,
      top_unexpected_country TEXT NOT NULL,
      top_unexpected_share DOUBLE PRECISION NOT NULL,
      total_sessions INTEGER NOT NULL,
      checked_at TEXT NOT NULL,
      unexpected_organic_share DOUBLE PRECISION NOT NULL DEFAULT 0,
      unexpected_direct_share DOUBLE PRECISION NOT NULL DEFAULT 0,
      action_plan TEXT NOT NULL DEFAULT ''
    );
    ALTER TABLE geo_mismatches ADD COLUMN IF NOT EXISTS unexpected_organic_share DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE geo_mismatches ADD COLUMN IF NOT EXISTS unexpected_direct_share DOUBLE PRECISION NOT NULL DEFAULT 0;
    ALTER TABLE geo_mismatches ADD COLUMN IF NOT EXISTS action_plan TEXT NOT NULL DEFAULT '';
  `);
}
