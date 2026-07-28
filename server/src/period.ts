export type CompareMode = "previous_period" | "previous_year";

export interface PeriodQuery {
  from: string;
  to: string;
  compare: CompareMode;
}

// Guards against a mistyped/malicious range asking for an absurd amount of history.
const MAX_RANGE_DAYS = 5 * 365;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isValidIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + "T00:00:00Z").getTime());
}

export function addDaysIso(date: string, delta: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function addYearsIso(date: string, delta: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCFullYear(d.getUTCFullYear() + delta);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenInclusive(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z").getTime();
  const b = new Date(to + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86_400_000) + 1;
}

/** Presets shown in the UI period selector (relative to today), in days. */
const PRESET_DAYS = new Set([7, 30, 90, 365]);

/**
 * Parses `from`/`to`/`compare`/`days` query params into a validated period.
 * `days=N` (legacy/quick preset) takes precedence when given and is resolved
 * to `[today-N+1, today]`; otherwise `from`/`to` are used as a free custom
 * range. Falls back to the last 7 days on missing/invalid input.
 */
export function parsePeriodQuery(query: { from?: string; to?: string; compare?: string; days?: string }): PeriodQuery {
  const compare: CompareMode = query.compare === "previous_year" ? "previous_year" : "previous_period";
  const to = todayIso();

  if (query.days) {
    const n = Number(query.days);
    const days = PRESET_DAYS.has(n) ? n : 7;
    return { from: addDaysIso(to, -(days - 1)), to, compare };
  }

  if (query.from && query.to && isValidIsoDate(query.from) && isValidIsoDate(query.to) && query.from <= query.to) {
    const cappedFrom = daysBetweenInclusive(query.from, query.to) > MAX_RANGE_DAYS ? addDaysIso(query.to, -(MAX_RANGE_DAYS - 1)) : query.from;
    return { from: cappedFrom, to: query.to, compare };
  }

  return { from: addDaysIso(to, -6), to, compare };
}

export interface ComparisonRange {
  from: string;
  to: string;
}

/** The window to compare `[from, to]` against, per the chosen comparison mode. */
export function resolveComparisonRange(period: PeriodQuery): ComparisonRange {
  if (period.compare === "previous_year") {
    return { from: addYearsIso(period.from, -1), to: addYearsIso(period.to, -1) };
  }
  const days = daysBetweenInclusive(period.from, period.to);
  const prevTo = addDaysIso(period.from, -1);
  const prevFrom = addDaysIso(prevTo, -(days - 1));
  return { from: prevFrom, to: prevTo };
}

/**
 * % change vs the comparison period, or null when there isn't enough history
 * to compare fairly -- or when either side is itself unavailable (a failed
 * Piwik query, see trends.DayPoint), since a % change against an unknown
 * value would be fabricated, not computed.
 */
export function pctChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  if (previous <= 0) return null;
  return (current - previous) / previous;
}

/**
 * Whether there's enough real history to trust a comparison against
 * `comparisonFrom` -- i.e. data collection started at or before that date.
 * Replaces a fragile "does the array have exactly N entries" check (which
 * broke on any single missing day, e.g. a cron run missed while the Render
 * free-tier instance was asleep) with a calendar-based one: series are
 * zero-filled (see trends.zeroFillDayPoints) so array length alone can no
 * longer signal a gap.
 */
export function hasEnoughHistoryFor(comparisonFrom: string, earliestSnapshotDate: string | null): boolean {
  if (!earliestSnapshotDate) return false;
  return earliestSnapshotDate <= comparisonFrom;
}
