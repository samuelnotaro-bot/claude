import type { FastifyInstance } from "fastify";
import {
  getSites,
  getSnapshotsForSites,
  getEarliestSnapshotDate,
  getLatestSynthesis,
  getSynthesisHistory,
  getGeoMismatches,
} from "../repo.js";
import { runTrendAnalysis, runSynthesis } from "../analysis.js";
import { generateSynthesis } from "../synthesis.js";
import {
  toDayPoints,
  aggregateDayPoints,
  aggregateDayPointSeries,
  zeroFillDayPoints,
  detectDataOutages,
  METRIC_LABELS,
  type DayPoint,
  type Finding,
  type FindingMetric,
  type Scope,
  type DataOutage,
} from "../trends.js";
import type { SiteRecord } from "../repo.js";
import { flagAnomalies } from "../anomaly.js";
import { checkGeoMismatches } from "../geoMismatch.js";
import { computeBotSignal } from "../bots.js";
import { runGapFillLoop, extendHistoryToRetentionFloor } from "../sync.js";
import {
  getDeepBackfillStatus,
  startDeepBackfillStatus,
  updateDeepBackfillProgress,
  finishDeepBackfillStatus,
} from "../deepBackfillStatus.js";
import { getGapFillStatus, startGapFillStatus, updateGapFillProgress, finishGapFillStatus } from "../gapFillStatus.js";
import { probeOptionalMetrics, getDailyMetrics, getMetricsRange, probeRollupSite } from "../piwik/client.js";
import { getBackfillStatus } from "../backfillStatus.js";
import { config } from "../config.js";
import type { Continent } from "../continent.js";
import { cached, clearCache } from "../cache.js";
import {
  parsePeriodQuery,
  resolveComparisonRange,
  pctChange,
  hasEnoughHistoryFor,
  addDaysIso,
  effectiveHistoryFloor,
  type PeriodQuery,
} from "../period.js";

function sum(points: DayPoint[], pick: (p: DayPoint) => number): number {
  return points.reduce((a, p) => a + pick(p), 0);
}

/**
 * Sums an optional (Piwik-integration-dependent) field across a period,
 * staying null only when every single point is null (see trends.DayPoint) --
 * a null total means "this KPI has no data at all for this period", which
 * the UI shows as "non disponible" instead of a misleading 0.
 */
function sumNullable(points: DayPoint[], pick: (p: DayPoint) => number | null): number | null {
  let total: number | null = null;
  for (const p of points) {
    const v = pick(p);
    if (v === null) continue;
    total = (total ?? 0) + v;
  }
  return total;
}

/**
 * Loads and zero-fills (see trends.zeroFillDayPoints) the current period and
 * its comparison period for a set of sites, in a single bulk DB round trip
 * instead of one query per site -- the main fix for slow dashboard loads.
 *
 * Traffic-flood days are NOT excluded from the totals here (they used to be
 * -- the dashboard must match Piwik Pro's own numbers exactly, per the
 * account owner's explicit requirement; recalculating/excluding anything
 * without saying so was the opposite of that). They're flagged (`isAnomaly`)
 * instead, so charts can highlight them and the Bots tab can analyze them,
 * without silently changing what the KPI totals add up to.
 */
async function loadCleanSeriesBySite(
  siteIds: string[],
  period: PeriodQuery
): Promise<{
  currentBySite: Map<string, DayPoint[]>;
  compareBySite: Map<string, DayPoint[]>;
  /** Days in the current period flagged as a traffic spike (see anomaly.ts) -- informational, these ARE included in the totals above. */
  flaggedInCurrentBySite: Map<string, number>;
  /** Days with no snapshot row at all in the current period (sync gap) -- see the "missingDays" doc comment where this is surfaced. */
  missingInCurrentBySite: Map<string, number>;
  /** Of those missing days, how many are older than PIWIK_DATA_RETENTION_DAYS -- Piwik Pro itself no longer has this data, so it will never be filled by a gap-fill run (see sync.ts backfillGaps). Surfaced separately so the UI doesn't imply these are just "not synced yet". */
  missingOutOfRetentionInCurrentBySite: Map<string, number>;
}> {
  const compareRange = resolveComparisonRange(period);
  const bulk = await getSnapshotsForSites(siteIds, compareRange.from, period.to);
  const retentionFloorDate = effectiveHistoryFloor();

  const currentBySite = new Map<string, DayPoint[]>();
  const compareBySite = new Map<string, DayPoint[]>();
  const flaggedInCurrentBySite = new Map<string, number>();
  const missingInCurrentBySite = new Map<string, number>();
  const missingOutOfRetentionInCurrentBySite = new Map<string, number>();

  for (const id of siteIds) {
    const raw = bulk.get(id) ?? [];
    const inRange = (date: string, from: string, to: string) => date >= from && date <= to;

    const currentRaw = raw.filter((r) => inRange(r.date, period.from, period.to));
    const currentAnomalousDates = new Set(flagAnomalies(currentRaw).keys());
    const currentFilled = zeroFillDayPoints(toDayPoints(currentRaw, currentAnomalousDates), period.from, period.to);
    currentBySite.set(id, currentFilled);
    flaggedInCurrentBySite.set(id, currentFilled.filter((p) => p.isAnomaly).length);
    const missing = currentFilled.filter((p) => p.isMissing);
    missingInCurrentBySite.set(id, missing.length);
    missingOutOfRetentionInCurrentBySite.set(id, missing.filter((p) => p.date < retentionFloorDate).length);

    const compareRaw = raw.filter((r) => inRange(r.date, compareRange.from, compareRange.to));
    const compareAnomalousDates = new Set(flagAnomalies(compareRaw).keys());
    compareBySite.set(id, zeroFillDayPoints(toDayPoints(compareRaw, compareAnomalousDates), compareRange.from, compareRange.to));
  }

  return { currentBySite, compareBySite, flaggedInCurrentBySite, missingInCurrentBySite, missingOutOfRetentionInCurrentBySite };
}

/**
 * Data outages (>=4 consecutive days with no real data, see trends.ts) per
 * site. Tagged with `context` (current vs. comparison period) -- both matter:
 * a current-period outage means "this site has no data right now", a
 * compare-period outage is exactly what makes a % change meaningless (see
 * buildPeriodFindings). Both are surfaced in the visible "0 stats" banner.
 *
 * Outages entirely before `earliestDataDate` are dropped -- that's not a
 * broken tag, it's just before this account's history starts (already
 * explained by the separate historyOk/retentionLimited banner). Without this,
 * every site would show a multi-month "panne" for any period whose
 * comparison window reaches earlier than the account's actual history,
 * drowning out real outages in noise.
 */
function outagesBySite(
  sites: SiteRecord[],
  seriesBySite: Map<string, DayPoint[]>,
  context: "current" | "compare",
  earliestDataDate: string | null
): Map<string, DataOutage[]> {
  const result = new Map<string, DataOutage[]>();
  for (const s of sites) {
    const outages = detectDataOutages(seriesBySite.get(s.id) ?? [], s.id, s.name, s.continent);
    const real = outages.filter((o) => !earliestDataDate || o.dateTo >= earliestDataDate);
    result.set(s.id, real.map((o) => ({ ...o, context })));
  }
  return result;
}

function flattenOutagesFor(siteIds: string[], outages: Map<string, DataOutage[]>): DataOutage[] {
  return siteIds.flatMap((id) => outages.get(id) ?? []);
}

interface KpiTotals {
  sessions: number;
  conversions: number;
  conversionRate: number;
  rfq: number;
  support: number;
  downloads: number;
  organicSessions: number;
  // These 3 (and lowEngagementSessions/Share, derived from organic/directBounces)
  // are nullable: null means "no data available for this period" (every
  // contributing day/site failed to fetch this metric -- see trends.DayPoint),
  // shown as "non disponible" in the UI instead of a misleading 0.
  aiReferralSessions: number | null;
  lowEngagementSessions: number | null;
  lowEngagementShare: number | null;
  searchConsoleClicks: number | null;
  searchConsoleImpressions: number | null;
}

function totalsOf(series: DayPoint[]): KpiTotals {
  const sessions = sum(series, (p) => p.sessions);
  const conversions = sum(series, (p) => p.goalConversions);
  const organicBouncesSum = sumNullable(series, (p) => p.organicBounces);
  const directBouncesSum = sumNullable(series, (p) => p.directBounces);
  const lowEngagementSessions =
    organicBouncesSum === null && directBouncesSum === null ? null : (organicBouncesSum ?? 0) + (directBouncesSum ?? 0);
  return {
    sessions,
    conversions,
    conversionRate: sessions > 0 ? conversions / sessions : 0,
    rfq: sum(series, (p) => p.rfqConversions),
    support: sum(series, (p) => p.supportConversions),
    downloads: sum(series, (p) => p.downloads),
    organicSessions: sum(series, (p) => p.channels.organic),
    aiReferralSessions: sumNullable(series, (p) => p.aiReferralSessions),
    lowEngagementSessions,
    lowEngagementShare: lowEngagementSessions === null ? null : sessions > 0 ? lowEngagementSessions / sessions : 0,
    searchConsoleClicks: sumNullable(series, (p) => p.searchConsoleClicks),
    searchConsoleImpressions: sumNullable(series, (p) => p.searchConsoleImpressions),
  };
}

/** Pairs each current KPI total with its %-change vs the comparison period (null when there isn't enough history yet, or when either side is unavailable -- see period.ts). */
function withChanges(current: KpiTotals, previous: KpiTotals, historyOk: boolean) {
  const chg = (a: number | null, b: number | null) => (historyOk ? pctChange(a, b) : null);
  return {
    sessions: current.sessions,
    sessionsChangePct: chg(current.sessions, previous.sessions),
    conversions: current.conversions,
    conversionsChangePct: chg(current.conversions, previous.conversions),
    conversionRate: current.conversionRate,
    conversionRateChangePct: chg(current.conversionRate, previous.conversionRate),
    rfq: current.rfq,
    rfqChangePct: chg(current.rfq, previous.rfq),
    support: current.support,
    supportChangePct: chg(current.support, previous.support),
    downloads: current.downloads,
    downloadsChangePct: chg(current.downloads, previous.downloads),
    organicSessions: current.organicSessions,
    organicSessionsChangePct: chg(current.organicSessions, previous.organicSessions),
    aiReferralSessions: current.aiReferralSessions,
    aiReferralSessionsChangePct: chg(current.aiReferralSessions, previous.aiReferralSessions),
    lowEngagementSessions: current.lowEngagementSessions,
    lowEngagementShare: current.lowEngagementShare,
    lowEngagementShareChangePct: chg(current.lowEngagementShare, previous.lowEngagementShare),
    searchConsoleClicks: current.searchConsoleClicks,
    searchConsoleClicksChangePct: chg(current.searchConsoleClicks, previous.searchConsoleClicks),
    searchConsoleImpressions: current.searchConsoleImpressions,
  };
}

const PERIOD_FINDING_METRICS: { key: keyof KpiTotals; metric: FindingMetric; minAbsChangePct: number }[] = [
  { key: "sessions", metric: "sessions", minAbsChangePct: 0.12 },
  { key: "conversionRate", metric: "conversionRate", minAbsChangePct: 0.15 },
  { key: "conversions", metric: "goalConversions", minAbsChangePct: 0.15 },
  { key: "organicSessions", metric: "organicSessions", minAbsChangePct: 0.15 },
  { key: "aiReferralSessions", metric: "aiReferralSessions", minAbsChangePct: 0.2 },
  { key: "lowEngagementShare", metric: "lowEngagementShare", minAbsChangePct: 0.15 },
  { key: "searchConsoleClicks", metric: "searchConsoleClicks", minAbsChangePct: 0.15 },
  { key: "rfq", metric: "rfq", minAbsChangePct: 0.15 },
  { key: "support", metric: "support", minAbsChangePct: 0.15 },
  { key: "downloads", metric: "downloads", minAbsChangePct: 0.15 },
];

interface ChildKpi {
  name: string;
  current: KpiTotals;
  previous: KpiTotals;
}

// Below this volume, a child entity's own change is too noisy to name as "the reason" for the aggregate move.
const MIN_SESSIONS_FOR_CONTRIBUTION = 200;
const MAX_CONTRIBUTORS_NAMED = 2;

function fmtRatioDelta(d: number): string {
  return `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)} pt`;
}
function fmtVolumeDelta(d: number): string {
  return `${d >= 0 ? "+" : ""}${Math.round(d)}`;
}

const RATIO_METRICS = new Set<FindingMetric>(["conversionRate", "lowEngagementShare"]);

/**
 * "Pourquoi ce chiffre a bougé" -- for a global/region-level finding, names
 * the child sites whose own change contributed most, so "taux de conversion
 * en baisse" isn't left as an unexplained number. Ratio metrics (conversion
 * rate, low-engagement share) rank children by their own point-change;
 * volume metrics (sessions, conversions, ...) rank by their own absolute
 * change in the same unit as the aggregate. Sites below
 * MIN_SESSIONS_FOR_CONTRIBUTION are excluded as too noisy to blame.
 */
function explainFinding(f: Finding, children: ChildKpi[]): string | undefined {
  const key = PERIOD_FINDING_METRICS.find((m) => m.metric === f.metric)?.key;
  if (!key) return undefined; // channelMix has no single KpiTotals key -- no per-child breakdown

  const contributions = children
    .filter((c) => c.current.sessions >= MIN_SESSIONS_FOR_CONTRIBUTION || c.previous.sessions >= MIN_SESSIONS_FOR_CONTRIBUTION)
    .map((c) => {
      const cur = c.current[key];
      const prev = c.previous[key];
      if (cur === null || prev === null) return null;
      return { name: c.name, delta: cur - prev, pct: pctChange(cur, prev) };
    })
    .filter((c): c is { name: string; delta: number; pct: number | null } => c !== null);

  const matching = contributions
    .filter((c) => (f.direction === "down" ? c.delta < 0 : c.delta > 0))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, MAX_CONTRIBUTORS_NAMED);

  if (matching.length === 0) {
    // No single child moves the same direction as the aggregate -- likely a
    // broad-based shift (many small moves) rather than one clear driver.
    return "Variation répartie sur plusieurs sites, sans contributeur unique dominant.";
  }

  const fmt = RATIO_METRICS.has(f.metric) ? fmtRatioDelta : fmtVolumeDelta;
  const names = matching.map((c) => `${c.name} (${fmt(c.delta)}${c.pct !== null ? `, ${(c.pct * 100).toFixed(0)}%` : ""})`).join(", ");
  return `Principal(aux) contributeur(s) : ${names}.`;
}

// A change this extreme is almost always a data-quality artifact (a thin or
// gappy comparison baseline), never a real trend worth presenting as a
// confident "bon signal" -- see the Finding.suspect doc comment.
const SUSPECT_CHANGE_PCT_THRESHOLD = 1.0; // >100%
// Suspect findings are kept (not dropped) so the extreme number and its
// caveat are still visible, but must never outrank a real, trustworthy
// finding in the sorted list.
const SUSPECT_IMPACT_SCORE = 0.01;

function suspectExplanation(changePct: number, compareOutages: DataOutage[]): string {
  if (compareOutages.length > 0) {
    const list = compareOutages.map((o) => `${o.siteName} sans donnée du ${o.dateFrom} au ${o.dateTo}`).join(", ");
    return `Variation extrême (${changePct >= 0 ? "+" : ""}${(changePct * 100).toFixed(0)}%) très probablement causée par un trou de données sur la période de comparaison : ${list}. Vérifiez avant d'agir -- ce n'est probablement pas une vraie tendance.`;
  }
  return `Variation extrême (${changePct >= 0 ? "+" : ""}${(changePct * 100).toFixed(0)}%) à vérifier avant d'agir : une variation de cette ampleur vient presque toujours d'une base de comparaison anormalement faible ou incomplète, pas d'une vraie tendance métier.`;
}

/**
 * Findings scoped to exactly the period/comparison the user selected, unlike
 * /api/findings (a fixed rolling 7-vs-7-day statistical view used only for
 * the cron-generated weekly synthesis history). Built directly from the same
 * KpiTotals already computed for the KPI tiles, so the "Analyse & plan
 * d'action" panels never show a different window than the numbers next to
 * them. No z-score/baseline requirement (arbitrary custom periods don't
 * necessarily have 8 weeks of trailing history to compute one from) --  just
 * a minimum relative-change threshold per metric.
 *
 * `children`, when given (regions/global scope), lets each finding be
 * explained ("why") by naming which child sites drove it -- see explainFinding.
 * `compareOutages`, when given, lets a suspect (>100%) finding point at the
 * specific data outage that most likely caused it instead of a generic caveat.
 */
function buildPeriodFindings(
  scope: Scope,
  entityId: string,
  entityName: string,
  current: KpiTotals,
  previous: KpiTotals,
  historyOk: boolean,
  children?: ChildKpi[],
  compareOutages: DataOutage[] = []
): Finding[] {
  if (!historyOk) return [];
  const findings: Finding[] = [];
  for (const { key, metric, minAbsChangePct } of PERIOD_FINDING_METRICS) {
    const currentVal = current[key];
    const previousVal = previous[key];
    if (currentVal === null || previousVal === null) continue;
    const changePct = pctChange(currentVal, previousVal);
    if (changePct === null || Math.abs(changePct) < minAbsChangePct) continue;
    const suspect = Math.abs(changePct) > SUSPECT_CHANGE_PCT_THRESHOLD;
    const finding: Finding = {
      scope,
      entityId,
      entityName,
      metric,
      label: METRIC_LABELS[metric],
      direction: changePct >= 0 ? "up" : "down",
      changePct,
      current: currentVal,
      previous: previousVal,
      impactScore: suspect ? SUSPECT_IMPACT_SCORE : Math.abs(changePct) * Math.log10(Math.max(currentVal, previousVal, 1) + 1),
      suspect,
    };
    if (suspect) {
      finding.explanation = suspectExplanation(changePct, compareOutages);
    } else if (children && children.length > 0) {
      finding.explanation = explainFinding(finding, children);
    }
    findings.push(finding);
  }
  return findings.sort((a, b) => b.impactScore - a.impactScore);
}

// Below this, either number is too small a sample for a ratio to mean anything.
const MIN_ORGANIC_SESSIONS_FOR_GAP_CHECK = 200;
const MIN_GSC_CLICKS_FOR_GAP_CHECK = 50;
// How far the organic-sessions-to-GSC-clicks ratio has to stray from 1:1
// before it's worth flagging. There's no authoritative "normal" ratio --
// organic sessions legitimately include non-Google search engines and AI
// citations that Search Console never sees, so some excess is expected. This
// is a starting heuristic (4x either way), not a validated benchmark; tune
// it if it's too noisy or too quiet in practice.
const ORGANIC_GSC_DISPARITY_RATIO = 4;

/**
 * Flags a large disparity between organic sessions (Piwik Pro) and Search
 * Console clicks for the same period/scope -- these should broadly track
 * each other since both represent Google Search traffic, so a big gap in
 * either direction is worth a second look, with a first-pass explanation of
 * why depending on which side is larger.
 */
function checkOrganicSearchConsoleGap(scope: Scope, entityId: string, entityName: string, organicSessions: number, searchConsoleClicks: number | null): Finding | null {
  if (searchConsoleClicks === null) return null;
  if (organicSessions < MIN_ORGANIC_SESSIONS_FOR_GAP_CHECK || searchConsoleClicks < MIN_GSC_CLICKS_FOR_GAP_CHECK) return null;

  const ratio = organicSessions / searchConsoleClicks;
  if (ratio >= ORGANIC_GSC_DISPARITY_RATIO) {
    return {
      scope,
      entityId,
      entityName,
      metric: "organicSearchConsoleGap",
      label: METRIC_LABELS.organicSearchConsoleGap,
      direction: "up",
      changePct: ratio - 1,
      current: organicSessions,
      previous: searchConsoleClicks,
      impactScore: Math.log10(ratio) * Math.log10(organicSessions + 1),
      explanation:
        `Trafic organique ${formatRatio(ratio)}x supérieur aux clics Search Console. Pistes : (1) trafic organique incluant ` +
        `d'autres moteurs/sources que Google (Bing, IA génératives citant le site) que Search Console ne mesure pas, ` +
        `(2) vague de bots/crawlers classés à tort en organique -- comparer avec l'onglet Bots sur la même période, ` +
        `(3) délai de traitement propre à Search Console (données généralement à J-2/J-3).`,
    };
  }
  if (ratio <= 1 / ORGANIC_GSC_DISPARITY_RATIO) {
    return {
      scope,
      entityId,
      entityName,
      metric: "organicSearchConsoleGap",
      label: METRIC_LABELS.organicSearchConsoleGap,
      direction: "down",
      changePct: ratio - 1,
      current: organicSessions,
      previous: searchConsoleClicks,
      impactScore: Math.log10(1 / ratio) * Math.log10(searchConsoleClicks + 1),
      explanation:
        `Clics Search Console ${formatRatio(1 / ratio)}x supérieurs au trafic organique enregistré par Piwik Pro. Pistes : ` +
        `(1) tracking Piwik Pro bloqué chez une partie des visiteurs (bloqueurs de pub, consentement RGPD refusé avant le ` +
        `déclenchement du tag), (2) rebond immédiat avant chargement complet du tag de tracking, (3) un clic Search Console ` +
        `ne garantit pas une session Piwik si la page ne charge pas (lenteur, erreur serveur).`,
    };
  }
  return null;
}

function formatRatio(ratio: number): string {
  return ratio.toFixed(ratio >= 10 ? 0 : 1);
}

/**
 * Findings across ALL scopes (every site, every region, and global) for one
 * period -- unlike the individual /api/sites/summary, /api/regions and
 * /api/overview routes, which each only return the findings for their own
 * scope. Built for the Synthèses tab: a per-site swing (e.g. one country's
 * organic traffic collapsing) is exactly the kind of thing a "comprehensive"
 * synthesis must not miss just because it doesn't move the global total.
 */
async function computeAllScopeFindings(
  period: PeriodQuery
): Promise<{
  findings: Finding[];
  historyOk: boolean;
  retentionLimited: boolean;
  retentionFloorDate: string;
  compareRange: { from: string; to: string };
  earliestDate: string | null;
  globalCurrent: KpiTotals;
  globalPrevious: KpiTotals;
  dataOutages: DataOutage[];
}> {
  const [sites, earliestDate] = await Promise.all([getSites(), getEarliestSnapshotDate()]);
  const compareRange = resolveComparisonRange(period);
  const historyOk = hasEnoughHistoryFor(compareRange.from, earliestDate);
  const retentionFloorDate = effectiveHistoryFloor();
  const retentionLimited = !historyOk && compareRange.from < retentionFloorDate;

  const { currentBySite, compareBySite } = await loadCleanSeriesBySite(sites.map((s) => s.id), period);
  const currentOutagesBySite = outagesBySite(sites, currentBySite, "current", earliestDate);
  const compareOutagesBySite = outagesBySite(sites, compareBySite, "compare", earliestDate);
  const allFindings: Finding[] = [];

  for (const s of sites) {
    const current = totalsOf(currentBySite.get(s.id) ?? []);
    const previous = totalsOf(compareBySite.get(s.id) ?? []);
    const findings = buildPeriodFindings("site", s.id, s.name, current, previous, historyOk, undefined, compareOutagesBySite.get(s.id) ?? []);
    const gap = checkOrganicSearchConsoleGap("site", s.id, s.name, current.organicSessions, current.searchConsoleClicks);
    if (gap) findings.push(gap);
    allFindings.push(...findings);
  }

  const byRegion = new Map<Continent, string[]>();
  for (const s of sites) {
    const list = byRegion.get(s.continent) ?? [];
    list.push(s.id);
    byRegion.set(s.continent, list);
  }
  const siteById = new Map(sites.map((s) => [s.id, s]));
  for (const [region, siteIds] of byRegion) {
    const currentSeries = aggregateDayPointSeries(siteIds.map((id) => currentBySite.get(id) ?? []));
    const compareSeries = aggregateDayPointSeries(siteIds.map((id) => compareBySite.get(id) ?? []));
    const current = totalsOf(currentSeries);
    const previous = totalsOf(compareSeries);
    const children: ChildKpi[] = siteIds.map((id) => ({
      name: siteById.get(id)?.name ?? id,
      current: totalsOf(currentBySite.get(id) ?? []),
      previous: totalsOf(compareBySite.get(id) ?? []),
    }));
    const findings = buildPeriodFindings("continent", region, region, current, previous, historyOk, children, flattenOutagesFor(siteIds, compareOutagesBySite));
    const gap = checkOrganicSearchConsoleGap("continent", region, region, current.organicSessions, current.searchConsoleClicks);
    if (gap) findings.push(gap);
    allFindings.push(...findings);
  }

  const allSiteIds = sites.map((s) => s.id);
  const globalCurrentSeries = aggregateDayPointSeries(sites.map((s) => currentBySite.get(s.id) ?? []));
  const globalCompareSeries = aggregateDayPointSeries(sites.map((s) => compareBySite.get(s.id) ?? []));
  const globalCurrent = totalsOf(globalCurrentSeries);
  const globalPrevious = totalsOf(globalCompareSeries);
  const globalChildren: ChildKpi[] = sites.map((s) => ({
    name: s.name,
    current: totalsOf(currentBySite.get(s.id) ?? []),
    previous: totalsOf(compareBySite.get(s.id) ?? []),
  }));
  const globalFindings = buildPeriodFindings("global", "global", "Tous sites", globalCurrent, globalPrevious, historyOk, globalChildren, flattenOutagesFor(allSiteIds, compareOutagesBySite));
  const globalGap = checkOrganicSearchConsoleGap("global", "global", "Tous sites", globalCurrent.organicSessions, globalCurrent.searchConsoleClicks);
  if (globalGap) globalFindings.push(globalGap);
  allFindings.push(...globalFindings);

  allFindings.sort((a, b) => b.impactScore - a.impactScore);
  const dataOutages = [...flattenOutagesFor(allSiteIds, currentOutagesBySite), ...flattenOutagesFor(allSiteIds, compareOutagesBySite)];

  return { findings: allFindings, historyOk, retentionLimited, retentionFloorDate, compareRange, earliestDate, globalCurrent, globalPrevious, dataOutages };
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/health", async () => ({ ok: true, mode: config.mode }));

  app.get("/api/backfill/status", async () => getBackfillStatus());

  app.get("/api/sites", async () => {
    return getSites();
  });

  app.get<{ Querystring: { from?: string; to?: string; compare?: string; days?: string } }>("/api/sites/summary", async (req) => {
    const period = parsePeriodQuery(req.query);
    const cacheKey = `sites:${period.from}:${period.to}:${period.compare}`;
    return cached(cacheKey, async () => {
      const [sites, earliestDate] = await Promise.all([getSites(), getEarliestSnapshotDate()]);
      const compareRange = resolveComparisonRange(period);
      const historyOk = hasEnoughHistoryFor(compareRange.from, earliestDate);
      const { currentBySite, compareBySite, flaggedInCurrentBySite, missingInCurrentBySite, missingOutOfRetentionInCurrentBySite } =
        await loadCleanSeriesBySite(sites.map((s) => s.id), period);
      const currentOutagesBySite = outagesBySite(sites, currentBySite, "current", earliestDate);
      const compareOutagesBySite = outagesBySite(sites, compareBySite, "compare", earliestDate);
      return sites.map((s) => {
        const current = totalsOf(currentBySite.get(s.id) ?? []);
        const previous = totalsOf(compareBySite.get(s.id) ?? []);
        const changes = withChanges(current, previous, historyOk);
        const findings = buildPeriodFindings("site", s.id, s.name, current, previous, historyOk, undefined, compareOutagesBySite.get(s.id) ?? []);
        const gap = checkOrganicSearchConsoleGap("site", s.id, s.name, current.organicSessions, current.searchConsoleClicks);
        if (gap) findings.push(gap);
        return {
          id: s.id,
          name: s.name,
          region: s.continent,
          ...changes,
          flaggedAnomalyDays: flaggedInCurrentBySite.get(s.id) ?? 0,
          missingDays: missingInCurrentBySite.get(s.id) ?? 0,
          missingDaysOutOfRetention: missingOutOfRetentionInCurrentBySite.get(s.id) ?? 0,
          dataOutages: [...(currentOutagesBySite.get(s.id) ?? []), ...(compareOutagesBySite.get(s.id) ?? [])],
          findings,
        };
      });
    });
  });

  app.get<{ Querystring: { from?: string; to?: string; compare?: string; days?: string } }>("/api/regions", async (req) => {
    const period = parsePeriodQuery(req.query);
    const cacheKey = `regions:${period.from}:${period.to}:${period.compare}`;
    return cached(cacheKey, async () => {
      const [sites, earliestDate] = await Promise.all([getSites(), getEarliestSnapshotDate()]);
      const compareRange = resolveComparisonRange(period);
      const historyOk = hasEnoughHistoryFor(compareRange.from, earliestDate);
      const byRegion = new Map<Continent, string[]>();
      for (const s of sites) {
        const list = byRegion.get(s.continent) ?? [];
        list.push(s.id);
        byRegion.set(s.continent, list);
      }
      const { currentBySite, compareBySite, flaggedInCurrentBySite, missingInCurrentBySite, missingOutOfRetentionInCurrentBySite } =
        await loadCleanSeriesBySite(sites.map((s) => s.id), period);
      const currentOutagesBySite = outagesBySite(sites, currentBySite, "current", earliestDate);
      const compareOutagesBySite = outagesBySite(sites, compareBySite, "compare", earliestDate);
      const siteById = new Map(sites.map((s) => [s.id, s]));
      const result = [];
      for (const [region, siteIds] of byRegion) {
        const currentSeries = aggregateDayPointSeries(siteIds.map((id) => currentBySite.get(id) ?? []));
        const compareSeries = aggregateDayPointSeries(siteIds.map((id) => compareBySite.get(id) ?? []));
        const current = totalsOf(currentSeries);
        const previous = totalsOf(compareSeries);
        const changes = withChanges(current, previous, historyOk);
        const flaggedAnomalyDays = siteIds.reduce((a, id) => a + (flaggedInCurrentBySite.get(id) ?? 0), 0);
        const missingDays = siteIds.reduce((a, id) => a + (missingInCurrentBySite.get(id) ?? 0), 0);
        const missingDaysOutOfRetention = siteIds.reduce((a, id) => a + (missingOutOfRetentionInCurrentBySite.get(id) ?? 0), 0);
        const children: ChildKpi[] = siteIds.map((id) => ({
          name: siteById.get(id)?.name ?? id,
          current: totalsOf(currentBySite.get(id) ?? []),
          previous: totalsOf(compareBySite.get(id) ?? []),
        }));
        const regionFindings = buildPeriodFindings("continent", region, region, current, previous, historyOk, children, flattenOutagesFor(siteIds, compareOutagesBySite));
        const regionGap = checkOrganicSearchConsoleGap("continent", region, region, current.organicSessions, current.searchConsoleClicks);
        if (regionGap) regionFindings.push(regionGap);
        result.push({
          region,
          siteCount: siteIds.length,
          ...changes,
          flaggedAnomalyDays,
          missingDays,
          missingDaysOutOfRetention,
          dataOutages: [...flattenOutagesFor(siteIds, currentOutagesBySite), ...flattenOutagesFor(siteIds, compareOutagesBySite)],
          findings: regionFindings,
        });
      }
      result.sort((a, b) => b.sessions - a.sessions);
      return result;
    });
  });

  app.get<{ Querystring: { from?: string; to?: string; compare?: string; days?: string } }>("/api/overview", async (req) => {
    const period = parsePeriodQuery(req.query);
    const cacheKey = `overview:${period.from}:${period.to}:${period.compare}`;
    return cached(cacheKey, async () => {
      const [sites, earliestDate] = await Promise.all([getSites(), getEarliestSnapshotDate()]);
      const compareRange = resolveComparisonRange(period);
      const historyOk = hasEnoughHistoryFor(compareRange.from, earliestDate);
      const retentionFloorDate = effectiveHistoryFloor();
      const retentionLimited = !historyOk && compareRange.from < retentionFloorDate;
      const { currentBySite, compareBySite, flaggedInCurrentBySite, missingInCurrentBySite, missingOutOfRetentionInCurrentBySite } =
        await loadCleanSeriesBySite(sites.map((s) => s.id), period);
      const currentOutagesBySite = outagesBySite(sites, currentBySite, "current", earliestDate);
      const compareOutagesBySite = outagesBySite(sites, compareBySite, "compare", earliestDate);
      const allSiteIds = sites.map((s) => s.id);
      const currentSeries = aggregateDayPointSeries(sites.map((s) => currentBySite.get(s.id) ?? []));
      const compareSeries = aggregateDayPointSeries(sites.map((s) => compareBySite.get(s.id) ?? []));
      const current = totalsOf(currentSeries);
      const previous = totalsOf(compareSeries);
      const changes = withChanges(current, previous, historyOk);
      const flaggedAnomalyDays = sites.reduce((a, s) => a + (flaggedInCurrentBySite.get(s.id) ?? 0), 0);
      const missingDays = sites.reduce((a, s) => a + (missingInCurrentBySite.get(s.id) ?? 0), 0);
      const missingDaysOutOfRetention = sites.reduce((a, s) => a + (missingOutOfRetentionInCurrentBySite.get(s.id) ?? 0), 0);
      const dataOutages = [...flattenOutagesFor(allSiteIds, currentOutagesBySite), ...flattenOutagesFor(allSiteIds, compareOutagesBySite)];
      const globalChildren: ChildKpi[] = sites.map((s) => ({
        name: s.name,
        current: totalsOf(currentBySite.get(s.id) ?? []),
        previous: totalsOf(compareBySite.get(s.id) ?? []),
      }));
      const findings = buildPeriodFindings("global", "global", "Tous sites", current, previous, historyOk, globalChildren, flattenOutagesFor(allSiteIds, compareOutagesBySite));
      const globalGap = checkOrganicSearchConsoleGap("global", "global", "Tous sites", current.organicSessions, current.searchConsoleClicks);
      if (globalGap) findings.push(globalGap);

      // Synthesis bullets generated on the fly for exactly this period (reuses
      // the same rule engine as the cron-generated weekly synthesis_history,
      // see synthesis.ts) -- distinct from that stored weekly log, which stays
      // a fixed cadence for the dedicated Synthèses tab/history.
      const synthesisBullets = historyOk
        ? generateSynthesis(findings, {
            totalSessions: current.sessions,
            prevTotalSessions: previous.sessions,
            conversionRate: current.conversionRate,
            prevConversionRate: previous.conversionRate,
          }).bullets
        : [];

      return {
        periodFrom: period.from,
        periodTo: period.to,
        compare: period.compare,
        comparisonFrom: compareRange.from,
        comparisonTo: compareRange.to,
        historyOk,
        earliestDataDate: earliestDate,
        retentionLimited,
        retentionFloorDate,
        siteCount: sites.length,
        ...changes,
        series: currentSeries,
        flaggedAnomalyDays,
        missingDays,
        missingDaysOutOfRetention,
        dataOutages,
        findings,
        synthesisBullets,
      };
    });
  });

  // Comprehensive, period-scoped synthesis for the Synthèses tab: unlike
  // /api/overview's synthesisBullets (global scope only), this ranks findings
  // across every site AND region too, so a single site's collapse shows up
  // here even when it doesn't move the global total. Bot signal and geo
  // mismatch data are deliberately NOT included here -- both are cheap,
  // period-aware (bots) or already-stored (geo mismatch) and fetched directly
  // by the frontend (see api.bots / api.geoMismatches) to avoid duplicating
  // that logic server-side.
  app.get<{ Querystring: { from?: string; to?: string; compare?: string; days?: string } }>("/api/synthesis/period", async (req) => {
    const period = parsePeriodQuery(req.query);
    const cacheKey = `synthesis-period:${period.from}:${period.to}:${period.compare}`;
    return cached(cacheKey, async () => {
      const { findings, historyOk, retentionLimited, retentionFloorDate, compareRange, earliestDate, globalCurrent, globalPrevious, dataOutages } =
        await computeAllScopeFindings(period);

      const bullets = historyOk
        ? generateSynthesis(findings, {
            totalSessions: globalCurrent.sessions,
            prevTotalSessions: globalPrevious.sessions,
            conversionRate: globalCurrent.conversionRate,
            prevConversionRate: globalPrevious.conversionRate,
          }).bullets
        : [];

      return {
        periodFrom: period.from,
        periodTo: period.to,
        compare: period.compare,
        comparisonFrom: compareRange.from,
        comparisonTo: compareRange.to,
        historyOk,
        retentionLimited,
        retentionFloorDate,
        earliestDataDate: earliestDate,
        findings: findings.slice(0, 30),
        dataOutages,
        bullets,
      };
    });
  });

  app.get<{ Querystring: { scope: "site" | "region" | "global"; id?: string; from?: string; to?: string; days?: string } }>(
    "/api/series",
    async (req, reply) => {
      const { scope, id } = req.query;
      const period = parsePeriodQuery(req.query);

      // This endpoint feeds the detail/analyst view: it intentionally returns raw,
      // unfiltered data (unlike sites/summary, regions, overview) but flags
      // anomalous days so the chart can highlight them instead of silently hiding them.
      if (scope === "site") {
        if (!id) return reply.code(400).send({ error: "id is required for scope=site" });
        const bulk = await getSnapshotsForSites([id], period.from, period.to);
        const raw = bulk.get(id) ?? [];
        const anomalousDates = new Set(flagAnomalies(raw).keys());
        return zeroFillDayPoints(toDayPoints(raw, anomalousDates), period.from, period.to);
      }
      const sites = await getSites();
      const filtered = scope === "region" ? sites.filter((s) => s.continent === id) : sites;
      const bulk = await getSnapshotsForSites(
        filtered.map((s) => s.id),
        period.from,
        period.to
      );
      const rowsBySite = filtered.map((s) => bulk.get(s.id) ?? []);
      // Anomaly detection runs on the region/global's OWN aggregate totals,
      // not the union of each site's individual flag -- see aggregateDayPoints's
      // doc comment (with 15-20 sites, "any one site flagged" was showing a red
      // dot on almost every day even when the region's own traffic was normal).
      const aggregated = aggregateDayPoints(rowsBySite);
      const anomalousDates = flagAnomalies(aggregated);
      for (const p of aggregated) p.isAnomaly = anomalousDates.has(p.date);
      return zeroFillDayPoints(aggregated, period.from, period.to);
    }
  );

  app.get<{ Querystring: { limit?: string } }>("/api/findings", async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const { findings } = await runTrendAnalysis();
    return findings.slice(0, limit);
  });

  app.get("/api/synthesis/latest", async () => {
    return getLatestSynthesis();
  });

  app.get<{ Querystring: { limit?: string } }>("/api/synthesis/history", async (req) => {
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    return getSynthesisHistory(limit);
  });

  app.post("/api/synthesis/generate", async () => {
    await runSynthesis();
    clearCache();
    return getLatestSynthesis();
  });

  app.get("/api/geo-mismatches", async () => {
    return getGeoMismatches();
  });

  app.post<{ Querystring: { from?: string; to?: string; days?: string } }>("/api/geo-mismatches/check", async (req) => {
    const period = parsePeriodQuery(req.query);
    const result = await checkGeoMismatches(period.from, period.to);
    clearCache();
    return result;
  });

  app.get<{ Querystring: { from?: string; to?: string; days?: string } }>("/api/bots", async (req) => {
    const period = parsePeriodQuery(req.query);
    const cacheKey = `bots:${period.from}:${period.to}`;
    return cached(cacheKey, () => computeBotSignal(period));
  });

  // Manual trigger for the gap-scan backfill (see sync.ts#backfillGaps) so a
  // hole in the data (e.g. "no data July 1-19") can be closed on demand
  // instead of waiting for the next boot/wake-up.
  //
  // Runs in the background rather than blocking the request, same reasoning
  // and same fire-and-poll pattern as deep-backfill below: a single
  // backfillGaps() call caps itself at MAX_GAP_FILLS_PER_RUN, so a large
  // multi-day, multi-site outage needs several rounds to fully close --
  // runGapFillLoop() runs those rounds itself instead of requiring a human
  // to keep re-clicking the button every couple of minutes.
  app.post("/api/data/fill-gaps", async () => {
    if (getGapFillStatus().running) {
      return { alreadyRunning: true };
    }
    startGapFillStatus();
    runGapFillLoop((round, cumulative) => updateGapFillProgress(round, { ...cumulative, rounds: round }))
      .then((result) => finishGapFillStatus(result))
      .catch((err) => finishGapFillStatus(null, err instanceof Error ? err.message : String(err)));
    return { alreadyRunning: false };
  });

  app.get("/api/data/fill-gaps/status", async () => getGapFillStatus());

  // Extends history *before* the current earliest snapshot, back to the
  // Piwik Pro retention floor (see sync.ts#extendHistoryToRetentionFloor) --
  // unlike fill-gaps, this reaches further back than what's already known.
  // Exposed as a button (not just npm run backfill) because Render's free
  // plan has no Shell tab to run that manually.
  //
  // Runs in the background rather than blocking the request: a real 26-month
  // backfill takes a couple of minutes even batched, and Render's proxy (like
  // most) enforces a request timeout well under that -- a blocking call would
  // get killed mid-run. The client polls GET /api/data/deep-backfill/status
  // instead, same pattern as the initial-boot backfill (backfillStatus.ts).
  app.post("/api/data/deep-backfill", async () => {
    if (getDeepBackfillStatus().running) {
      return { alreadyRunning: true };
    }
    // Total starts at 0 (unknown) rather than the full site count: only
    // some sites may actually need extending, and extendHistoryToRetentionFloor
    // reports the real total via its first progress callback almost
    // immediately, before the client's first poll -- starting at "every
    // site" would flash a misleadingly large total for no reason.
    startDeepBackfillStatus(0);
    extendHistoryToRetentionFloor((done, total) => updateDeepBackfillProgress(done, total))
      .then((result) => finishDeepBackfillStatus(result))
      .catch((err) => finishDeepBackfillStatus(null, err instanceof Error ? err.message : String(err)));
    return { alreadyRunning: false };
  });

  app.get("/api/data/deep-backfill/status", async () => getDeepBackfillStatus());

  // Runs the 3 optional Piwik Pro queries (AI-referral, channel bounces,
  // Search Console) for one real site and reports success/failure + the raw
  // error per query -- so a "0"/"non disponible" KPI on the dashboard can be
  // diagnosed directly instead of only ever showing up in server logs.
  // Meaningless in demo mode (no real Piwik Pro calls happen at all).
  app.get("/api/diagnostics/optional-metrics", async (_req, reply) => {
    if (config.mode !== "live") {
      return reply.code(400).send({ error: "Diagnostics only meaningful in PIWIK_MODE=live." });
    }
    const sites = await getSites();
    if (sites.length === 0) return reply.code(404).send({ error: "No tracked sites." });
    const yesterday = addDaysIso(new Date().toISOString().slice(0, 10), -1);
    return probeOptionalMetrics(sites[0].id, sites[0].name, yesterday);
  });

  // Compares getDailyMetrics (single date_from=date_to=day, the proven path)
  // against getMetricsRange for that SAME single day (the batched path used
  // by the deep-backfill, which adds a day-breakdown dimension to the
  // query). Exists to answer a specific, serious question raised directly:
  // does adding that dimension change how Piwik Pro computes "sessions"
  // (a session-scoped metric) -- e.g. by forcing the whole query into event
  // scope, per Piwik Pro's own documented column-scope rules -- rather than
  // just affecting which dates come back. If the two sides disagree, the
  // batched path is producing wrong totals, not just an incomplete date
  // range, and must stop being used for anything until that's resolved.
  app.get("/api/diagnostics/range-vs-daily", async (_req, reply) => {
    if (config.mode !== "live") {
      return reply.code(400).send({ error: "Diagnostics only meaningful in PIWIK_MODE=live." });
    }
    const sites = await getSites();
    if (sites.length === 0) return reply.code(404).send({ error: "No tracked sites." });
    const site = sites[0];
    const yesterday = addDaysIso(new Date().toISOString().slice(0, 10), -1);
    try {
      const [daily, range] = await Promise.all([getDailyMetrics(site.id, yesterday), getMetricsRange(site.id, yesterday, yesterday)]);
      const rangeDay = range[0];
      return {
        siteId: site.id,
        siteName: site.name,
        date: yesterday,
        daily: { sessions: daily.sessions, pageviews: daily.pageviews, users: daily.users },
        range: rangeDay ? { sessions: rangeDay.sessions, pageviews: rangeDay.pageviews, users: rangeDay.users } : null,
        sessionsMatch: rangeDay ? daily.sessions === rangeDay.sessions : false,
      };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Answers a specific question raised directly: can the app query ONE
  // Piwik Pro property (a multi-site array in a normal query, or a Roll-Up
  // Reporting meta-property that aggregates every country site) and get
  // every site's data back broken down by origin, instead of one request
  // per site per query type? If either works, request volume for the
  // 26-month sync could drop by roughly the site count. Read-only, no data
  // written -- see piwik/client.ts#probeRollupSite for what each probe does.
  app.get<{ Querystring: { siteId?: string } }>("/api/diagnostics/rollup-site", async (req, reply) => {
    if (config.mode !== "live") {
      return reply.code(400).send({ error: "Diagnostics only meaningful in PIWIK_MODE=live." });
    }
    const sites = await getSites();
    if (sites.length === 0) return reply.code(404).send({ error: "No tracked sites." });
    // ?siteId=<id> (comma-separated for more than one) tests a specific
    // Piwik Pro site id directly -- for a Roll-Up Reporting property that
    // doesn't show up in the automatic /api/apps/v2 discovery (confirmed
    // empty for this account) but whose id is known from the Piwik Pro UI.
    const explicitSiteIds = (req.query.siteId ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    try {
      return await probeRollupSite(sites.map((s) => s.id), explicitSiteIds);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
