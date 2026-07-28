import { useEffect, useState } from "react";
import { api, type Synthesis as SynthesisType } from "../lib/api";
import { SynthesisPanel } from "../components/SynthesisPanel";

export function Synthesis() {
  const [history, setHistory] = useState<SynthesisType[]>([]);
  const [generating, setGenerating] = useState(false);

  function load() {
    api.synthesisHistory(20).then(setHistory);
  }

  useEffect(load, []);

  async function handleGenerate() {
    setGenerating(true);
    try {
      await api.generateSynthesis();
      load();
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div>
      <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>Synthèses périodiques</h2>
          <p className="card-subtitle" style={{ margin: 0 }}>
            Journal historique généré automatiquement chaque semaine (moteur de règles statistiques, sans appel à une API
            externe) -- volontairement indépendant du sélecteur de période en haut de page : chaque entrée garde la fenêtre 7j/7j
            qu'elle avait au moment de sa génération. Pour une synthèse recalculée sur la période actuellement sélectionnée,
            voir la carte "Synthèse — plan d'action" de la Vue d'ensemble.
          </p>
        </div>
        <button className="primary-btn" onClick={handleGenerate} disabled={generating}>
          {generating ? "Génération…" : "Générer maintenant"}
        </button>
      </div>

      {history.length === 0 && (
        <div className="card">
          <p className="empty-state">Aucune synthèse pour le moment.</p>
        </div>
      )}

      {history.map((s) => (
        <div className="card" key={s.id}>
          <SynthesisPanel synthesis={s} />
        </div>
      ))}
    </div>
  );
}
