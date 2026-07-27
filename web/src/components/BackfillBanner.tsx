import { useEffect, useState } from "react";
import { api, type BackfillStatus } from "../lib/api";

const POLL_INTERVAL_MS = 4000;

export function BackfillBanner() {
  const [status, setStatus] = useState<BackfillStatus | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const s = await api.backfillStatus();
        if (!active) return;
        setStatus(s);
        if (s.running) timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch {
        if (active) timer = setTimeout(poll, POLL_INTERVAL_MS * 2);
      }
    }
    poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  if (!status?.running) return null;

  const pct = status.daysTotal > 0 ? Math.round((status.daysDone / status.daysTotal) * 100) : 0;

  return (
    <div className="backfill-banner">
      <div>
        Chargement initial des données Piwik Pro en cours ({status.sitesTotal} sites) — les 7 derniers jours apparaissent en
        premier, l'historique complet suit ({status.daysDone}/{status.daysTotal} jours).
      </div>
      <div className="backfill-progress">
        <div className="backfill-progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
