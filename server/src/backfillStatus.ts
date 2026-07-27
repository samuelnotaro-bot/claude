export interface BackfillStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  sitesTotal: number;
  daysTotal: number;
  daysDone: number;
}

let status: BackfillStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  sitesTotal: 0,
  daysTotal: 0,
  daysDone: 0,
};

export function getBackfillStatus(): BackfillStatus {
  return { ...status };
}

export function startBackfillStatus(sitesTotal: number, daysTotal: number): void {
  status = { running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null, sitesTotal, daysTotal, daysDone: 0 };
}

export function incrementBackfillDays(n = 1): void {
  status.daysDone += n;
}

export function finishBackfillStatus(error: string | null = null): void {
  status.running = false;
  status.finishedAt = new Date().toISOString();
  status.error = error;
}
