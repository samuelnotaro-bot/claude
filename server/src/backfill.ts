import { config } from "./config.js";
import { initSchema } from "./db.js";
import { syncSiteRegistry } from "./siteRegistry.js";
import { syncDay } from "./sync.js";
import { runSynthesis } from "./analysis.js";
import { dateRange } from "./metrics.js";
import { checkGeoMismatches } from "./geoMismatch.js";
import { startBackfillStatus, incrementBackfillDays, finishBackfillStatus } from "./backfillStatus.js";

// Synced first, before the rest of the configured history, so real KPIs show
// up quickly on a fresh deploy instead of waiting for the full window --
// against the real Piwik Pro API (live mode), backfilling 90 days for ~20
// sites can take a while.
const QUICK_WINDOW_DAYS = 7;

export async function backfillAll(days = config.backfillDays): Promise<void> {
  await initSchema();
  console.log(`[backfill] mode=${config.mode} discovering sites...`);
  const sites = await syncSiteRegistry();
  console.log(`[backfill] ${sites.length} sites registered:`);
  for (const s of sites) {
    console.log(`  - ${s.name.padEnd(20)} region=${s.continent} (${s.continentSource})`);
  }

  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  const dates = dateRange(from, to);
  const quickDates = dates.slice(-QUICK_WINDOW_DAYS);
  const remainingDates = dates.slice(0, -QUICK_WINDOW_DAYS);

  startBackfillStatus(sites.length, dates.length);
  try {
    console.log(`[backfill] fetching the last ${quickDates.length} days first so real KPIs appear quickly...`);
    for (const date of quickDates) {
      await syncDay(date);
      incrementBackfillDays();
    }
    console.log("[backfill] generating initial synthesis from the recent window...");
    await runSynthesis();
    await checkGeoMismatches();

    if (remainingDates.length > 0) {
      console.log(`[backfill] fetching the remaining ${remainingDates.length} days of history...`);
      let done = quickDates.length;
      for (const date of remainingDates) {
        await syncDay(date);
        done++;
        incrementBackfillDays();
        if (done % 10 === 0 || done === dates.length) {
          console.log(`[backfill] ${done}/${dates.length} days done`);
        }
      }
      console.log("[backfill] refreshing synthesis with the full history...");
      await runSynthesis();
      await checkGeoMismatches();
    }
    finishBackfillStatus();
    console.log("[backfill] done.");
  } catch (err) {
    finishBackfillStatus(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  backfillAll().catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  });
}
