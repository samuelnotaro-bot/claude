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
