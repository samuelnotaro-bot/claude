// Empty string = same-origin (the production build, served by the API server itself).
// Set VITE_API_BASE_URL=http://localhost:4000 for local dev (`npm run dev:web` on its own port).
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`);
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST" });
  if (!res.ok) throw new Error(`API error ${res.status} on ${path}`);
  return res.json() as Promise<T>;
}

export interface Site {
  id: string;
  name: string;
  continent: string;
  continentSource: "auto" | "manual";
  detectedCountry: string | null;
  updatedAt: string;
}

export interface DayPoint {
  [key: string]: unknown;
  date: string;
  sessions: number;
  users: number;
  pageviews: number;
  goalConversions: number;
  conversionRate: number;
  bounceRate: number;
  channels: Record<string, number>;
  /** Flagged as a traffic-flood anomaly (see server anomaly.ts). Only set on /api/series (raw/detail view). */
  isAnomaly?: boolean;
}

export interface Overview {
  siteCount: number;
  sessionsLast7d: number;
  sessionsChangePct: number | null;
  conversionsLast7d: number;
  conversionsChangePct: number | null;
  conversionRateLast7d: number;
  conversionRateChangePct: number | null;
  series: DayPoint[];
  /** Days excluded from the KPIs above because they were flagged as a traffic-flood anomaly. */
  excludedAnomalyDays: number;
}

export interface SiteSummary {
  id: string;
  name: string;
  region: string;
  sessionsLast7d: number;
  sessionsChangePct: number | null;
  conversionsLast7d: number;
  conversionRateLast7d: number;
  excludedAnomalyDays: number;
}

export interface RegionSummary {
  region: string;
  siteCount: number;
  sessionsLast7d: number;
  sessionsChangePct: number | null;
  conversionsLast7d: number;
  conversionRateLast7d: number;
  excludedAnomalyDays: number;
}

export interface Finding {
  scope: "site" | "continent" | "global";
  entityId: string;
  entityName: string;
  metric: "sessions" | "conversionRate" | "goalConversions" | "channelMix";
  label: string;
  direction: "up" | "down";
  changePct: number | null;
  current: number;
  previous: number;
  impactScore: number;
  detail?: string;
}

export interface Synthesis {
  id: number;
  generatedAt: string;
  periodFrom: string;
  periodTo: string;
  bullets: string[];
  highlights: Record<string, unknown>;
}

export const api = {
  sites: () => get<Site[]>("/api/sites"),
  sitesSummary: () => get<SiteSummary[]>("/api/sites/summary"),
  regions: () => get<RegionSummary[]>("/api/regions"),
  overview: () => get<Overview>("/api/overview"),
  series: (scope: "site" | "region" | "global", id?: string, days = 60) =>
    get<DayPoint[]>(`/api/series?scope=${scope}${id ? `&id=${encodeURIComponent(id)}` : ""}&days=${days}`),
  findings: (limit = 20) => get<Finding[]>(`/api/findings?limit=${limit}`),
  latestSynthesis: () => get<Synthesis | null>("/api/synthesis/latest"),
  synthesisHistory: (limit = 20) => get<Synthesis[]>(`/api/synthesis/history?limit=${limit}`),
  generateSynthesis: () => post<Synthesis | null>("/api/synthesis/generate"),
};
