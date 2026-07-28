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
  /** Flagged as a traffic spike (>35% above the period average, see server anomaly.ts). Included in totals, not excluded -- purely a highlight. */
  isAnomaly?: boolean;
  isMissing?: boolean;
}

/** A run of 4+ consecutive days with no real data for a site (no snapshot, or a snapshot reporting exactly 0 sessions) -- see server trends.ts#detectDataOutages. */
export interface DataOutage {
  siteId: string;
  siteName: string;
  region: string;
  dateFrom: string;
  dateTo: string;
  days: number;
  /** Whether the outage falls in the currently-viewed period or its comparison period. */
  context?: "current" | "compare";
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
    | "downloads"
    | "organicSearchConsoleGap";
  label: string;
  direction: "up" | "down";
  changePct: number | null;
  current: number;
  previous: number;
  impactScore: number;
  detail?: string;
  /** "Why" -- which sites drove this change, when computable (region/global scope only). */
  explanation?: string;
  /** True when |changePct| > 100% -- almost always a data-quality artifact (thin/gappy comparison baseline), never presented as a confident trend. See FindingsList. */
  suspect?: boolean;
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
  /** True when historyOk is false AND the comparison period reaches further back than Piwik Pro's own data retention -- comblage impossible, not just "not synced yet". */
  retentionLimited: boolean;
  /** Oldest date Piwik Pro can still return data for (today - PIWIK_DATA_RETENTION_DAYS). */
  retentionFloorDate: string;
  siteCount: number;
  series: DayPoint[];
  /** Days included in the totals above that were flagged as a traffic spike (>35% above average) -- informational, NOT excluded. See charts/Bots tab for detail. */
  flaggedAnomalyDays: number;
  /** Days with no synced snapshot at all in this period -- totals below likely undercount real Piwik Pro numbers by this much. Includes both fixable sync gaps and permanently out-of-retention days, see missingDaysOutOfRetention. */
  missingDays: number;
  /** Of missingDays, how many are older than Piwik Pro's data retention window -- these will NEVER be filled (not a sync gap), see dataQualityNote. */
  missingDaysOutOfRetention: number;
  /** Sites with 4+ consecutive days of no real data in this period -- a likely tracking/tag outage, not just a quiet period. */
  dataOutages: DataOutage[];
  findings: Finding[];
  /** Synthesis bullets generated on the fly for this exact period (distinct from the cron-generated weekly synthesis_history log, see the Synthèses tab). */
  synthesisBullets: string[];
}

export interface SiteSummary extends KpiSet {
  id: string;
  name: string;
  region: string;
  flaggedAnomalyDays: number;
  missingDays: number;
  missingDaysOutOfRetention: number;
  dataOutages: DataOutage[];
  findings: Finding[];
}

export interface RegionSummary extends KpiSet {
  region: string;
  siteCount: number;
  flaggedAnomalyDays: number;
  missingDays: number;
  missingDaysOutOfRetention: number;
  dataOutages: DataOutage[];
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

export interface PeriodSynthesis {
  periodFrom: string;
  periodTo: string;
  compare: "previous_period" | "previous_year";
  comparisonFrom: string;
  comparisonTo: string;
  historyOk: boolean;
  retentionLimited: boolean;
  retentionFloorDate: string;
  earliestDataDate: string | null;
  /** Findings across every site, every region AND global for this period, ranked by impact -- unlike Overview's findings (global scope only). */
  findings: Finding[];
  /** Sites with 4+ consecutive days of no real data in the current period. */
  dataOutages: DataOutage[];
  bullets: string[];
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
  /** When this record was last checked (last manual/scheduled check -- not recomputed live for the currently-selected period). */
  checkedAt?: string;
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
  daysOutOfRetention: number;
}

export interface DeepBackfillResult {
  extended: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  daysAdded: number;
  ok: number;
  failed: number;
  batchError?: string;
}

export interface DeepBackfillStartResponse {
  alreadyRunning: boolean;
}

export interface DeepBackfillStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  sitesTotal: number;
  sitesDone: number;
  result: DeepBackfillResult | null;
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
  periodSynthesis: (periodQuery: string) => get<PeriodSynthesis>(`/api/synthesis/period?${periodQuery}`),
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
  startDeepBackfill: () => post<DeepBackfillStartResponse>("/api/data/deep-backfill"),
  deepBackfillStatus: () => get<DeepBackfillStatus>("/api/data/deep-backfill/status"),
  optionalMetricsDiagnostics: () => get<OptionalMetricsDiagnostics>("/api/diagnostics/optional-metrics"),
  health: () => get<{ ok: boolean; mode: string }>("/api/health"),
  backfillStatus: () => get<BackfillStatus>("/api/backfill/status"),
};
