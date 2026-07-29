import cron from "node-cron";
import { config } from "./config.js";
import { syncSiteRegistry } from "./siteRegistry.js";
import { syncDay } from "./sync.js";
import { runSynthesis } from "./analysis.js";
import { checkGeoMismatches } from "./geoMismatch.js";
import { clearCache } from "./cache.js";
import { runAutomaticRecovery } from "./autoRecovery.js";

export function startScheduler(): void {
  // Keeps the 26-month history recovery (see autoRecovery.ts) moving
  // forward on its own for as long as the process stays awake, not just
  // once at boot -- a large backlog (a fresh deploy, or catching up after an
  // extended outage) can take longer than one boot-to-sleep window on
  // Render's free tier. historyNeedsRecovery() inside runAutomaticRecovery
  // is a couple of cheap DB reads, so this tick costs nothing once history
  // is actually complete.
  cron.schedule("*/15 * * * *", async () => {
    try {
      await runAutomaticRecovery();
    } catch (err) {
      console.error("[scheduler] automatic history recovery failed:", err);
    }
  });

  cron.schedule(config.fetchCron, async () => {
    try {
      console.log("[scheduler] daily fetch starting...");
      await syncSiteRegistry();
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const y = await syncDay(yesterday.toISOString().slice(0, 10));
      // Also re-fetch today -- it's necessarily a partial day (still
      // accumulating sessions in Piwik Pro), refreshed once here and again
      // by the next run 24h later, but showing today's traffic so far is
      // more useful than showing nothing for the current day at all.
      const t = await syncDay(today.toISOString().slice(0, 10));
      clearCache();
      console.log(
        `[scheduler] daily fetch done: yesterday ${y.ok} ok/${y.failed} failed, today ${t.ok} ok/${t.failed} failed (today is partial, refreshed again tomorrow).`
      );
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
    clearCache();
  });

  console.log(`[scheduler] started (fetch="${config.fetchCron}", synthesis="${config.synthesisCron}")`);
}
