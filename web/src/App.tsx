import { useState } from "react";
import { Overview } from "./pages/Overview";
import { Regions } from "./pages/Regions";
import { Sites } from "./pages/Sites";
import { Synthesis } from "./pages/Synthesis";

const TABS = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "regions", label: "Business Regions" },
  { id: "sites", label: "Sites" },
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
          <div className="subtitle">Tendances de visibilité, trafic et conversions — sites à extension pays, par région</div>
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
      {tab === "regions" && <Regions />}
      {tab === "sites" && <Sites />}
      {tab === "synthesis" && <Synthesis />}
    </div>
  );
}
