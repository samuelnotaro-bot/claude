import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type PeriodDays = 7 | 30 | 90 | 365;
export type CompareMode = "previous_period" | "previous_year";
type Mode = "preset" | "custom";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(date: string, delta: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

interface PeriodContextValue {
  mode: Mode;
  presetDays: PeriodDays;
  customFrom: string;
  customTo: string;
  compare: CompareMode;
  /** Resolved [from, to] (inclusive, YYYY-MM-DD) regardless of mode -- what the UI should display and label. */
  from: string;
  to: string;
  setPresetDays: (days: PeriodDays) => void;
  setCustomRange: (from: string, to: string) => void;
  setCompare: (mode: CompareMode) => void;
  /** Query string fragment (no leading "?") to append to any period-aware API call. */
  queryParams: string;
}

const PeriodContext = createContext<PeriodContextValue | null>(null);

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("preset");
  const [presetDays, setPresetDaysState] = useState<PeriodDays>(7);
  const [customFrom, setCustomFrom] = useState<string>(addDaysIso(todayIso(), -29));
  const [customTo, setCustomTo] = useState<string>(todayIso());
  const [compare, setCompare] = useState<CompareMode>("previous_period");

  const setPresetDays = (days: PeriodDays) => {
    setMode("preset");
    setPresetDaysState(days);
  };
  const setCustomRange = (from: string, to: string) => {
    setMode("custom");
    setCustomFrom(from);
    setCustomTo(to);
  };

  const { from, to } = useMemo(() => {
    if (mode === "custom") return { from: customFrom, to: customTo };
    const today = todayIso();
    return { from: addDaysIso(today, -(presetDays - 1)), to: today };
  }, [mode, presetDays, customFrom, customTo]);

  const queryParams = useMemo(() => `from=${from}&to=${to}&compare=${compare}`, [from, to, compare]);

  return (
    <PeriodContext.Provider
      value={{ mode, presetDays, customFrom, customTo, compare, from, to, setPresetDays, setCustomRange, setCompare, queryParams }}
    >
      {children}
    </PeriodContext.Provider>
  );
}

export function usePeriod(): PeriodContextValue {
  const ctx = useContext(PeriodContext);
  if (!ctx) throw new Error("usePeriod must be used within a PeriodProvider");
  return ctx;
}

export const PERIOD_OPTIONS: { value: PeriodDays; label: string }[] = [
  { value: 7, label: "7 derniers jours" },
  { value: 30, label: "30 derniers jours" },
  { value: 90, label: "90 derniers jours" },
  { value: 365, label: "12 derniers mois" },
];

export const COMPARE_OPTIONS: { value: CompareMode; label: string }[] = [
  { value: "previous_period", label: "à la période précédente" },
  { value: "previous_year", label: "à l'année précédente" },
];

/** Short label for comparison text, e.g. "vs période précédente". */
export function periodComparisonLabel(compare: CompareMode): string {
  return compare === "previous_year" ? "vs année précédente" : "vs période précédente";
}
