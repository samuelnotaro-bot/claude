import { config } from "./config.js";
import { backfillAll } from "./backfill.js";

if (config.mode !== "demo") {
  console.warn(`[seed:demo] PIWIK_MODE is "${config.mode}", not "demo" -- this will hit the real Piwik Pro API.`);
}

backfillAll().catch((err) => {
  console.error("[seed:demo] failed:", err);
  process.exit(1);
});
