import "dotenv/config";
import path from "node:path";

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  mode: env("PIWIK_MODE", "demo") as "demo" | "live",
  piwik: {
    baseUrl: process.env.PIWIK_BASE_URL ?? "",
    clientId: process.env.PIWIK_CLIENT_ID ?? "",
    clientSecret: process.env.PIWIK_CLIENT_SECRET ?? "",
  },
  port: Number(env("PORT", "4000")),
  dbPath: path.resolve(process.cwd(), env("DB_PATH", "./data/piwik-trends.db")),
  backfillDays: Number(env("BACKFILL_DAYS", "90")),
  fetchCron: env("FETCH_CRON", "0 6 * * *"),
  synthesisCron: env("SYNTHESIS_CRON", "0 7 * * 1"),
};

if (config.mode === "live" && (!config.piwik.baseUrl || !config.piwik.clientId || !config.piwik.clientSecret)) {
  throw new Error(
    "PIWIK_MODE=live requires PIWIK_BASE_URL, PIWIK_CLIENT_ID and PIWIK_CLIENT_SECRET to be set."
  );
}
