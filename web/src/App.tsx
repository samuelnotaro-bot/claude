import { useState } from "react";
import { Overview } from "./pages/Overview";
import { Regions } from "./pages/Regions";
import { Sites } from "./pages/Sites";
import { Synthesis } from "./pages/Synthesis";
import { PeriodProvider, usePeriod, PERIOD_OPTIONS } from "./lib/periodContext";
import type { PeriodDays } from "./lib/api";

const TABS = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "regions", label: "Business Regions" },
  { id: "sites", label: "Sites" },
  { id: "synthesis", label: "Synthèses" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function PeriodSelector() {
  const { days, setDays } = usePeriod();
  return (
    <select
      className="period-select"
      value={days}
      onChange={(e) => setDays(Number(e.target.value) as PeriodDays)}
      aria-label="Période affichée"
    >
      {PERIOD_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function App() {
  const [tab, setTab] = useState<TabId>("overview");
  const mode = import.meta.env.VITE_PIWIK_MODE ?? "demo";

  return (
    <PeriodProvider>
      <div className="app">
        <header className="app-header">
          <div>
            <h1>Piwik Trends Analyzer</h1>
            <div className="subtitle">Tendances de visibilité, trafic et conversions — sites à extension pays, par région</div>
          </div>
          <div className="header-controls">
            <PeriodSelector />
            <span className="mode-badge">mode : {mode}</span>
          </div>
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
    </PeriodProvider>
  );
}
