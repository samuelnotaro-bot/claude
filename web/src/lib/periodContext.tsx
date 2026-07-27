import { createContext, useContext, useState, type ReactNode } from "react";
import type { PeriodDays } from "./api";

interface PeriodContextValue {
  days: PeriodDays;
  setDays: (days: PeriodDays) => void;
}

const PeriodContext = createContext<PeriodContextValue | null>(null);

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [days, setDays] = useState<PeriodDays>(7);
  return <PeriodContext.Provider value={{ days, setDays }}>{children}</PeriodContext.Provider>;
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

/** Short label for comparison text, e.g. "vs 7j précédents". */
export function periodComparisonLabel(days: PeriodDays): string {
  if (days === 365) return "vs 12 mois précédents";
  return `vs ${days}j précédents`;
}
