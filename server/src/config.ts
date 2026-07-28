import "dotenv/config";

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
  databaseUrl: env("DATABASE_URL"),
  backfillDays: Number(env("BACKFILL_DAYS", "90")),
  // Confirmed from Piwik Pro's official API rate-limit docs: GET (read)
  // requests are capped at 600/min, but non-GET requests -- including any
  // POST "even if they only retrieve data", which is how the Analytics Query
  // API works -- are capped at 60/min. Every metric this app fetches (totals,
  // channels, goals, downloads, AI-referral, bounces, Search Console) goes
  // through that POST query endpoint, so 60/min is the real binding limit for
  // basically all of this app's Piwik Pro traffic, not a guess. On ~20 sites
  // (~6 calls/site/day synced) a naive unpaced sync or gap-fill would burst
  // well past it, which then shows up as silent sync failures (data gaps).
  // Lower this only if your specific plan/contract grants less than the
  // documented 60/min.
  piwikMaxRequestsPerMinute: Number(env("PIWIK_MAX_REQUESTS_PER_MINUTE", "60")),
  // How many days back Piwik Pro actually keeps queryable data on this
  // account/plan (confirmed by the account owner -- not discoverable via the
  // API itself). Dates older than this will NEVER succeed no matter how many
  // times a gap-fill retries them, so this bounds gap-fill's scan and lets the
  // UI tell "will never be available" apart from "not synced yet, retry".
  piwikDataRetentionDays: Number(env("PIWIK_DATA_RETENTION_DAYS", "60")),
  fetchCron: env("FETCH_CRON", "0 6 * * *"),
  synthesisCron: env("SYNTHESIS_CRON", "0 7 * * 1"),
  dashboard: {
    username: process.env.DASHBOARD_USERNAME ?? "",
    password: process.env.DASHBOARD_PASSWORD ?? "",
  },
};

if (config.mode === "live" && (!config.piwik.baseUrl || !config.piwik.clientId || !config.piwik.clientSecret)) {
  throw new Error(
    "PIWIK_MODE=live requires PIWIK_BASE_URL, PIWIK_CLIENT_ID and PIWIK_CLIENT_SECRET to be set."
  );
}

if (config.mode === "live" && (!config.dashboard.username || !config.dashboard.password)) {
  console.warn(
    "[config] PIWIK_MODE=live mais DASHBOARD_USERNAME/DASHBOARD_PASSWORD ne sont pas renseignés -- " +
      "le dashboard sera accessible publiquement avec de vraies données de trafic. Renseignez les deux pour le protéger."
  );
}
