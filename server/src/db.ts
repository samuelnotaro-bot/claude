import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    continent TEXT NOT NULL DEFAULT 'Unknown',
    continent_source TEXT NOT NULL DEFAULT 'auto',
    detected_country TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS site_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id TEXT NOT NULL,
    date TEXT NOT NULL,
    sessions INTEGER NOT NULL DEFAULT 0,
    users INTEGER NOT NULL DEFAULT 0,
    pageviews INTEGER NOT NULL DEFAULT 0,
    goal_conversions INTEGER NOT NULL DEFAULT 0,
    bounce_rate REAL NOT NULL DEFAULT 0,
    avg_session_duration_sec REAL NOT NULL DEFAULT 0,
    channel_organic INTEGER NOT NULL DEFAULT 0,
    channel_direct INTEGER NOT NULL DEFAULT 0,
    channel_referral INTEGER NOT NULL DEFAULT 0,
    channel_paid INTEGER NOT NULL DEFAULT 0,
    channel_social INTEGER NOT NULL DEFAULT 0,
    channel_email INTEGER NOT NULL DEFAULT 0,
    channel_other INTEGER NOT NULL DEFAULT 0,
    UNIQUE(site_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_snapshots_date ON site_snapshots(date);
  CREATE INDEX IF NOT EXISTS idx_snapshots_site ON site_snapshots(site_id);

  CREATE TABLE IF NOT EXISTS synthesis_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    generated_at TEXT NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    bullets TEXT NOT NULL,
    highlights TEXT NOT NULL
  );
`);
