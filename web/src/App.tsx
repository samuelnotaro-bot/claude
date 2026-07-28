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

const DEFAULT_TAB: TabId = "overview";

function tabFromHash(): TabId {
  const id = window.location.hash.replace(/^#\/?/, "");
  return (TABS.find((t) => t.id === id)?.id ?? DEFAULT_TAB) as TabId;
}

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
  // Tab is reflected in the URL hash (#/overview, #/regions, ...) so each tab
  // has its own shareable link -- no server-side route config needed, since
  // the browser never sends the #fragment to the server (it always requests
  // just "/", which staticWeb.ts already serves index.html for).
  const [tab, setTabState] = useState<TabId>(tabFromHash);
  const [mode, setMode] = useState<string>("…");

  useEffect(() => {
    api.health().then((h) => setMode(h.mode)).catch(() => setMode("?"));
  }, []);

  useEffect(() => {
    // Normalize a bare "/" into "/#/overview" on first load, so the default
    // tab also has a real shareable link instead of only gaining one once
    // the user clicks a tab. replaceState avoids adding a spurious history entry.
    if (!window.location.hash) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/${tab}`);
    }
    const onHashChange = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setTab(next: TabId) {
    setTabState(next);
    window.location.hash = `/${next}`;
  }

  return (
    <PeriodProvider>
      <div className="app-shell">
        <header className="brand-bar">
          <div className="app-header">
            <div>
              {/* Recréation approximative du logo Socomec (pas le fichier vectoriel officiel) -- à remplacer par web/public/socomec-logo-white.svg dès que le vrai fichier est fourni. */}
              <img src="/socomec-logo-white.svg" alt="Socomec — Innovative Power Solutions" className="brand-logo" />
              <div className="subtitle">Performance digitale — trafic et conversions, sites à extension pays, par région</div>
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
