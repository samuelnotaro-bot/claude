import cron from "node-cron";
import { config } from "./config.js";
import { syncSiteRegistry } from "./siteRegistry.js";
import { syncDay } from "./sync.js";
import { runSynthesis } from "./analysis.js";
import { checkGeoMismatches } from "./geoMismatch.js";

export function startScheduler(): void {
  cron.schedule(config.fetchCron, async () => {
    try {
      console.log("[scheduler] daily fetch starting...");
      await syncSiteRegistry();
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      await syncDay(yesterday.toISOString().slice(0, 10));
      console.log("[scheduler] daily fetch done.");
    } catch (err) {
      console.error("[scheduler] daily fetch failed:", err);
    }
  });

  cron.schedule(config.synthesisCron, async () => {
    try {
      console.log("[scheduler] generating periodic synthesis...");
      await runSynthesis();
      console.log("[scheduler] periodic synthesis done.");
    } catch (err) {
      console.error("[scheduler] periodic synthesis failed:", err);
    }
    try {
      console.log("[scheduler] checking geo mismatches...");
      await checkGeoMismatches();
      console.log("[scheduler] geo mismatch check done.");
    } catch (err) {
      console.error("[scheduler] geo mismatch check failed:", err);
    }
  });

  console.log(`[scheduler] started (fetch="${config.fetchCron}", synthesis="${config.synthesisCron}")`);
}
