import { historyNeedsRecovery, extendHistoryToRetentionFloor, runGapFillLoop } from "./sync.js";
import { getDeepBackfillStatus, startDeepBackfillStatus, updateDeepBackfillProgress, finishDeepBackfillStatus } from "./deepBackfillStatus.js";
import { getGapFillStatus, startGapFillStatus, updateGapFillProgress, finishGapFillStatus } from "./gapFillStatus.js";

/**
 * Drives history to "complete back to the 26-month retention floor, no
 * gaps" automatically -- extend first (reaches past the earliest known date
 * towards the retention floor), then gap-fill (closes holes inside the now
 * larger known range, including any an interrupted/partial extend leaves
 * behind). Sequential and awaited on purpose: gap-fill's scan window is
 * computed from each site's earliest known date, which extend is the one
 * updating -- running them concurrently would have gap-fill scanning a
 * window that's still shrinking underneath it.
 *
 * Reuses the exact same status trackers the manual "Étendre l'historique" /
 * "Combler les trous" buttons use, so the existing dashboard UI (which
 * already polls both on mount) reflects an automatic run exactly like a
 * manual one -- no frontend changes needed, and a manual click while this is
 * already running correctly reports "already running" instead of starting a
 * duplicate.
 *
 * Called once at boot (see index.ts) and again on a periodic tick (see
 * scheduler.ts) for as long as the process stays awake -- this is what makes
 * the 26-month recovery fully automatic: no button click required. Safe to
 * call anytime: historyNeedsRecovery() (cheap DB reads only) makes it a
 * near-instant no-op once there's nothing left to do.
 */
export async function runAutomaticRecovery(): Promise<void> {
  if (!(await historyNeedsRecovery())) return;

  if (!getDeepBackfillStatus().running) {
    startDeepBackfillStatus(0);
    try {
      const result = await extendHistoryToRetentionFloor((done, total) => updateDeepBackfillProgress(done, total));
      finishDeepBackfillStatus(result);
    } catch (err) {
      finishDeepBackfillStatus(null, err instanceof Error ? err.message : String(err));
    }
  }

  if (!getGapFillStatus().running) {
    startGapFillStatus();
    try {
      const result = await runGapFillLoop((round, cumulative) => updateGapFillProgress(round, { ...cumulative, rounds: round }));
      finishGapFillStatus(result);
    } catch (err) {
      finishGapFillStatus(null, err instanceof Error ? err.message : String(err));
    }
  }
}
