export interface DeepBackfillResultSummary {
  extended: boolean;
  dateFrom: string | null;
  dateTo: string | null;
  daysAdded: number;
  ok: number;
  failed: number;
  batchError?: string;
}

export interface DeepBackfillStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  sitesTotal: number;
  sitesDone: number;
  result: DeepBackfillResultSummary | null;
}

let status: DeepBackfillStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  sitesTotal: 0,
  sitesDone: 0,
  result: null,
};

export function getDeepBackfillStatus(): DeepBackfillStatus {
  return { ...status };
}

export function startDeepBackfillStatus(sitesTotal: number): void {
  status = { running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null, sitesTotal, sitesDone: 0, result: null };
}

export function updateDeepBackfillProgress(sitesDone: number, sitesTotal: number): void {
  status.sitesDone = sitesDone;
  status.sitesTotal = sitesTotal;
}

export function finishDeepBackfillStatus(result: DeepBackfillResultSummary | null, error: string | null = null): void {
  status.running = false;
  status.finishedAt = new Date().toISOString();
  status.error = error;
  status.result = result;
}
