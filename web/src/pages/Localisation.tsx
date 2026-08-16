import { useEffect, useState } from "react";
import { api, type GeoMismatch } from "../lib/api";
import { GeoMismatchPanel } from "../components/GeoMismatchPanel";
import { HeroBanner } from "../components/HeroBanner";
import { usePeriod } from "../lib/periodContext";

export function Localisation() {
  const { queryParams, from, to } = usePeriod();
  const [mismatches, setMismatches] = useState<GeoMismatch[]>([]);
  const [checking, setChecking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [checkedForPeriod, setCheckedForPeriod] = useState<string | null>(null);

  // Shows the last stored check result immediately (fast, from the DB) instead
  // of auto-triggering a fresh live check on every period change: a real check
  // queries Piwik Pro per site and is now correctly rate-limited (see
  // piwik/client.ts), so re-running it just from browsing periods would mean
  // waiting tens of seconds on every click. "Vérifier maintenant" runs it for
  // the currently selected period explicitly.
  // Re-fetches every 60s in addition to the initial load -- cheap (a stored
  // DB read, not a live Piwik Pro check, see the doc comment above), and
  // picks up both the scheduler's own periodic geo-mismatch check
  // (scheduler.ts) and history recovery (autoRecovery.ts) as they progress
  // in the background, instead of leaving the page frozen at whatever was
  // stored on mount. Errors are swallowed -- a single missed tick shouldn't
  // clear an otherwise-good view.
  useEffect(() => {
    function load() {
      api
        .geoMismatches()
        .then((data) => {
          setMismatches(data);
          setLoaded(true);
        })
        .catch(() => {});
    }
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, []);

  async function handleCheck() {
    setChecking(true);
    try {
      setMismatches(await api.checkGeoMismatches(queryParams));
      setCheckedForPeriod(`${from} → ${to}`);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div>
      <HeroBanner image="/localisation.png" caption="Détection des anomalies géographiques" zoom="fit" />
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Cohérence géographique du trafic</h2>
            <p className="card-subtitle" style={{ margin: 0 }}>
              Alerte si un pays inattendu représente au moins 20% du trafic d'un site, avec répartition organique/direct du
              pays concerné et une première piste d'analyse.
              {checkedForPeriod
                ? ` Dernière vérification pour ${checkedForPeriod}.`
                : ` Cliquez "Vérifier maintenant" pour lancer une vérification sur ${from} → ${to} (interroge Piwik Pro en direct, peut prendre plusieurs dizaines de secondes selon le nombre de sites).`}
            </p>
          </div>
          <button className="primary-btn" onClick={handleCheck} disabled={checking}>
            {checking ? "Vérification…" : "Vérifier maintenant"}
          </button>
        </div>
        {!loaded ? <p className="empty-state">Chargement…</p> : <GeoMismatchPanel mismatches={mismatches} />}
      </div>
    </div>
  );
}
