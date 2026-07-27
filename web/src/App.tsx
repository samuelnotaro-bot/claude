import { useState } from "react";
import { Overview } from "./pages/Overview";
import { Continents } from "./pages/Continents";
import { Sites } from "./pages/Sites";
import { Synthesis } from "./pages/Synthesis";

const TABS = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "continents", label: "Par continent" },
  { id: "sites", label: "22 sites" },
  { id: "synthesis", label: "Synthèses" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function App() {
  const [tab, setTab] = useState<TabId>("overview");
  const mode = import.meta.env.VITE_PIWIK_MODE ?? "demo";

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Piwik Trends Analyzer</h1>
          <div className="subtitle">Tendances de visibilité, trafic et conversions — 22 sites, par continent</div>
        </div>
        <span className="mode-badge">mode : {mode}</span>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview" && <Overview />}
      {tab === "continents" && <Continents />}
      {tab === "sites" && <Sites />}
      {tab === "synthesis" && <Synthesis />}
    </div>
  );
}
