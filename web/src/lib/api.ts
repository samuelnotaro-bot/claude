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
  aiReferralSessions: number | null;
  organicBounces: number | null;
  directBounces: number | null;
  searchConsoleClicks: number | null;
  searchConsoleImpressions: number | null;
  /** Flagged as a traffic-flood anomaly (see server anomaly.ts). Only set on /api/series (raw/detail view). */
  isAnomaly?: boolean;
  isMissing?: boolean;
}

export type PeriodDays = 7 | 30 | 90 | 365;

export interface Finding {
  scope: "site" | "continent" | "global";
  entityId: string;
  entityName: string;
  metric:
    | "sessions"
    | "conversionRate"
    | "goalConversions"
    | "channelMix"
    | "organicSessions"
    | "aiReferralSessions"
    | "lowEngagementShare"
    | "searchConsoleClicks"
    | "rfq"
    | "support"
    | "downloads";
  label: string;
  direction: "up" | "down";
  changePct: number | null;
  current: number;
  previous: number;
  impactScore: number;
  detail?: string;
  /** "Why" -- which sites drove this change, when computable (region/global scope only). */
  explanation?: string;
}

/** KPI fields shared by /api/overview, /api/regions and /api/sites/summary (see server/src/routes/api.ts withChanges()). Nullable fields mean "non disponible" (a Piwik query failed or the integration isn't configured), distinct from a confirmed 0. */
export interface KpiSet {
  sessions: number;
  sessionsChangePct: number | null;
  conversions: number;
  conversionsChangePct: number | null;
  conversionRate: number;
  conversionRateChangePct: number | null;
  rfq: number;
  rfqChangePct: number | null;
  support: number;
  supportChangePct: number | null;
  downloads: number;
  downloadsChangePct: number | null;
  organicSessions: number;
  organicSessionsChangePct: number | null;
  aiReferralSessions: number | null;
  aiReferralSessionsChangePct: number | null;
  lowEngagementSessions: number | null;
  lowEngagementShare: number | null;
  lowEngagementShareChangePct: number | null;
  searchConsoleClicks: number | null;
  searchConsoleClicksChangePct: number | null;
  searchConsoleImpressions: number | null;
}

export interface Overview extends KpiSet {
  periodFrom: string;
  periodTo: string;
  compare: "previous_period" | "previous_year";
  comparisonFrom: string;
  comparisonTo: string;
  /** False when the comparison period reaches further back than the account's actual synced history -- deltas are null in that case, not because nothing changed. */
  historyOk: boolean;
  /** Earliest date with any synced data at all, or null if there's no data yet. */
  earliestDataDate: string | null;
  siteCount: number;
  series: DayPoint[];
  /** Days excluded from the KPIs above because they were flagged as a traffic-flood anomaly. */
  excludedAnomalyDays: number;
  /** Days with no synced snapshot at all in this period (sync gap) -- totals below likely undercount real Piwik Pro numbers by this much. */
  missingDays: number;
  findings: Finding[];
  /** Synthesis bullets generated on the fly for this exact period (distinct from the cron-generated weekly synthesis_history log, see the Synthèses tab). */
  synthesisBullets: string[];
}

export interface SiteSummary extends KpiSet {
  id: string;
  name: string;
  region: string;
  excludedAnomalyDays: number;
  missingDays: number;
  findings: Finding[];
}

export interface RegionSummary extends KpiSet {
  region: string;
  siteCount: number;
  excludedAnomalyDays: number;
  missingDays: number;
  findings: Finding[];
}

export interface Synthesis {
  id: number;
  generatedAt: string;
  periodFrom: string;
  periodTo: string;
  bullets: string[];
  highlights: Record<string, unknown>;
}

export interface BackfillStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  sitesTotal: number;
  daysTotal: number;
  daysDone: number;
}

export interface GeoMismatch {
  siteId: string;
  siteName: string;
  expectedLabel: string;
  expectedShare: number;
  topUnexpectedCountry: string;
  topUnexpectedShare: number;
  totalSessions: number;
  unexpectedOrganicShare: number;
  unexpectedDirectShare: number;
  actionPlan: string;
}

export interface BotAnomalyEntry {
  siteId: string;
  siteName: string;
  region: string;
  date: string;
  channels: ("organic" | "direct")[];
  sessions: number;
  baselineSessions: number;
  excessSessions: number;
}

export interface TrafficSpikeSite {
  siteId: string;
  siteName: string;
  sessions: number;
  averageSessions: number;
}

export interface TrafficSpikeEntry {
  date: string;
  sessions: number;
  averageSessions: number;
  organicShare: number;
  directShare: number;
  sites: TrafficSpikeSite[];
}

export interface BotSignal {
  periodFrom: string;
  periodTo: string;
  totalSessions: number;
  totalExcessSessions: number;
  estimatedBotSharePct: number | null;
  anomalies: BotAnomalyEntry[];
  trafficSpikes: TrafficSpikeEntry[];
  lowEngagementShare: number;
  lowEngagementShareChangePct: number | null;
}

export interface GapFillResult {
  sitesWithGaps: number;
  daysFilled: number;
  daysRemaining: number;
  daysFailed: number;
}

export interface OptionalMetricsDiagnostics {
  siteId: string;
  siteName: string;
  date: string;
  aiReferral: { ok: boolean; error?: string };
  channelBounces: { ok: boolean; error?: string };
  searchConsole: { ok: boolean; error?: string };
}

export const api = {
  sites: () => get<Site[]>("/api/sites"),
  sitesSummary: (periodQuery: string) => get<SiteSummary[]>(`/api/sites/summary?${periodQuery}`),
  regions: (periodQuery: string) => get<RegionSummary[]>(`/api/regions?${periodQuery}`),
  overview: (periodQuery: string) => get<Overview>(`/api/overview?${periodQuery}`),
  series: (scope: "site" | "region" | "global", id: string | undefined, periodQuery: string) =>
    get<DayPoint[]>(`/api/series?scope=${scope}${id ? `&id=${encodeURIComponent(id)}` : ""}&${periodQuery}`),
  findings: (limit = 20) => get<Finding[]>(`/api/findings?limit=${limit}`),
  latestSynthesis: () => get<Synthesis | null>("/api/synthesis/latest"),
  synthesisHistory: (limit = 20) => get<Synthesis[]>(`/api/synthesis/history?limit=${limit}`),
  generateSynthesis: () => post<Synthesis | null>("/api/synthesis/generate"),
  geoMismatches: () => get<GeoMismatch[]>("/api/geo-mismatches"),
  checkGeoMismatches: (periodQuery: string) => post<GeoMismatch[]>(`/api/geo-mismatches/check?${periodQuery}`),
  bots: (periodQuery: string) => get<BotSignal>(`/api/bots?${periodQuery}`),
  fillGaps: () => post<GapFillResult>("/api/data/fill-gaps"),
  optionalMetricsDiagnostics: () => get<OptionalMetricsDiagnostics>("/api/diagnostics/optional-metrics"),
  health: () => get<{ ok: boolean; mode: string }>("/api/health"),
  backfillStatus: () => get<BackfillStatus>("/api/backfill/status"),
};
