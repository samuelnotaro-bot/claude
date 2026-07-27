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
      UNIQUE (site_id, date)
    );
    -- Progressive migration for databases created before these columns existed.
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS rfq_conversions INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS support_conversions INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE site_snapshots ADD COLUMN IF NOT EXISTS downloads INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON site_snapshots (date);
    CREATE INDEX IF NOT EXISTS idx_snapshots_site ON site_snapshots (site_id);

    CREATE TABLE IF NOT EXISTS synthesis_history (
      id SERIAL PRIMARY KEY,
      generated_at TEXT NOT NULL,
      period_from TEXT NOT NULL,
      period_to TEXT NOT NULL,
      bullets TEXT NOT NULL,
      highlights TEXT NOT NULL
    );
  `);
}
