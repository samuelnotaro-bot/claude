import { useEffect, useState } from "react";
import { api, type GeoMismatch } from "../lib/api";
import { GeoMismatchPanel } from "../components/GeoMismatchPanel";

export function Localisation() {
  const [mismatches, setMismatches] = useState<GeoMismatch[]>([]);
  const [checking, setChecking] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api.geoMismatches().then((data) => {
      setMismatches(data);
      setLoaded(true);
    });
  }, []);

  async function handleCheck() {
    setChecking(true);
    try {
      setMismatches(await api.checkGeoMismatches());
    } finally {
      setChecking(false);
    }
  }

  return (
    <div>
      <div className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ marginBottom: 4 }}>Cohérence géographique du trafic</h2>
            <p className="card-subtitle" style={{ margin: 0 }}>
              Alerte si un pays inattendu représente au moins 20% du trafic d'un site (ex. trafic Inde sur le site UK), avec
              répartition organique/direct du pays concerné et une première piste d'analyse.
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
