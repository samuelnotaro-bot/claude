import { config } from "./config.js";
import { syncSiteRegistry } from "./siteRegistry.js";
import { syncDay } from "./sync.js";
import { runSynthesis } from "./analysis.js";
import { dateRange } from "./metrics.js";

export async function backfillAll(days = config.backfillDays): Promise<void> {
  console.log(`[backfill] mode=${config.mode} discovering sites...`);
  const sites = await syncSiteRegistry(days);
  console.log(`[backfill] ${sites.length} sites registered:`);
  for (const s of sites) {
    console.log(`  - ${s.name.padEnd(20)} continent=${s.continent} (${s.continentSource}, country=${s.detectedCountry ?? "n/a"})`);
  }

  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  const dates = dateRange(from, to);

  console.log(`[backfill] fetching ${dates.length} days of metrics for ${sites.length} sites...`);
  let done = 0;
  for (const date of dates) {
    await syncDay(date);
    done++;
    if (done % 10 === 0 || done === dates.length) {
      console.log(`[backfill] ${done}/${dates.length} days done`);
    }
  }

  console.log("[backfill] generating initial synthesis...");
  runSynthesis();
  console.log("[backfill] done.");
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  backfillAll().catch((err) => {
    console.error("[backfill] failed:", err);
    process.exit(1);
  });
}
