import { config } from "./config.js";
import { initSchema } from "./db.js";
import { syncSiteRegistry } from "./siteRegistry.js";
import { syncDateRange } from "./sync.js";
import { runSynthesis } from "./analysis.js";
import { checkGeoMismatches } from "./geoMismatch.js";
import { startBackfillStatus, incrementBackfillDays, finishBackfillStatus } from "./backfillStatus.js";
import { clearCache } from "./cache.js";
import { addDaysIso, daysBetweenInclusive } from "./period.js";

// Synced first, before the rest of the configured history, so real KPIs show
// up quickly on a fresh deploy instead of waiting for the full window.
const QUICK_WINDOW_DAYS = 7;

export async function backfillAll(days = config.backfillDays): Promise<void> {
  await initSchema();
  console.log(`[backfill] mode=${config.mode} discovering sites...`);
  const sites = await syncSiteRegistry();
  console.log(`[backfill] ${sites.length} sites registered:`);
  for (const s of sites) {
    console.log(`  - ${s.name.padEnd(20)} region=${s.continent} (${s.continentSource})`);
  }

  const toIso = new Date().toISOString().slice(0, 10);
  const fromIso = addDaysIso(toIso, -days);
  const quickFromIso = addDaysIso(toIso, -(QUICK_WINDOW_DAYS - 1));
  const totalDays = daysBetweenInclusive(fromIso, toIso);
  const quickDays = daysBetweenInclusive(quickFromIso, toIso);

  startBackfillStatus(sites.length, totalDays);
  try {
    console.log(`[backfill] fetching the last ${quickDays} days first so real KPIs appear quickly...`);
    await syncDateRange(quickFromIso, toIso);
    incrementBackfillDays(quickDays);
    console.log("[backfill] generating initial synthesis from the recent window...");
    await runSynthesis();
    await checkGeoMismatches();

    if (fromIso < quickFromIso) {
      const remainingToIso = addDaysIso(quickFromIso, -1);
      const remainingDays = daysBetweenInclusive(fromIso, remainingToIso);
      console.log(`[backfill] fetching the remaining ${remainingDays} days of history (batched by date range, not day by day)...`);
      await syncDateRange(fromIso, remainingToIso);
      incrementBackfillDays(remainingDays);
      console.log("[backfill] refreshing synthesis with the full history...");
      await runSynthesis();
      await checkGeoMismatches();
    }
    finishBackfillStatus();
    clearCache();
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
