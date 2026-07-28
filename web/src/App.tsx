import { useEffect, useState } from "react";
import { Overview } from "./pages/Overview";
import { Regions } from "./pages/Regions";
import { Sites } from "./pages/Sites";
import { Synthesis } from "./pages/Synthesis";
import { Localisation } from "./pages/Localisation";
import { Bots } from "./pages/Bots";
import { BackfillBanner } from "./components/BackfillBanner";
import { PeriodProvider, usePeriod, PERIOD_OPTIONS, COMPARE_OPTIONS, type PeriodDays, type CompareMode } from "./lib/periodContext";
import { api } from "./lib/api";

const TABS = [
  { id: "overview", label: "Vue d'ensemble" },
  { id: "regions", label: "Business Regions" },
  { id: "sites", label: "Sites" },
  { id: "localisation", label: "Localisation" },
  { id: "bots", label: "Bots" },
  { id: "synthesis", label: "Synthèses" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function PeriodSelector() {
  const { mode, presetDays, customFrom, customTo, compare, setPresetDays, setCustomRange, setCompare } = usePeriod();

  return (
    <div className="period-controls">
      <select
        className="period-select"
        value={mode === "custom" ? "custom" : String(presetDays)}
        onChange={(e) => {
          if (e.target.value === "custom") setCustomRange(customFrom, customTo);
          else setPresetDays(Number(e.target.value) as PeriodDays);
        }}
        aria-label="Période affichée"
      >
        {PERIOD_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value="custom">Période personnalisée…</option>
      </select>

      {mode === "custom" && (
        <span className="custom-range">
          <input
            type="date"
            className="date-input"
            value={customFrom}
            max={customTo}
            aria-label="Date de début"
            onChange={(e) => setCustomRange(e.target.value, customTo)}
          />
          <span className="range-sep">→</span>
          <input
            type="date"
            className="date-input"
            value={customTo}
            min={customFrom}
            max={new Date().toISOString().slice(0, 10)}
            aria-label="Date de fin"
            onChange={(e) => setCustomRange(customFrom, e.target.value)}
          />
        </span>
      )}

      <select
        className="period-select"
        value={compare}
        onChange={(e) => setCompare(e.target.value as CompareMode)}
        aria-label="Comparer à"
      >
        {COMPARE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            Comparer {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function App() {
  const [tab, setTab] = useState<TabId>("overview");
  const [mode, setMode] = useState<string>("…");

  useEffect(() => {
    api.health().then((h) => setMode(h.mode)).catch(() => setMode("?"));
  }, []);

  return (
    <PeriodProvider>
      <div className="app-shell">
        <header className="brand-bar">
          <div className="app-header">
            <div>
              {/* TODO: remplacer par le logo officiel Socomec (web/public/socomec-logo.svg) une fois le fichier fourni -- voir CTA/design de référence. */}
              <h1>Socomec — Performance digitale</h1>
              <div className="subtitle">Tendances de visibilité, trafic et conversions — sites à extension pays, par région</div>
            </div>
            <div className="header-controls">
              <PeriodSelector />
              <span className="mode-badge">mode : {mode}</span>
            </div>
          </div>
        </header>

        <div className="app">
          <BackfillBanner />
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
          {tab === "localisation" && <Localisation />}
          {tab === "bots" && <Bots />}
          {tab === "synthesis" && <Synthesis />}
        </div>
      </div>
    </PeriodProvider>
  );
}
