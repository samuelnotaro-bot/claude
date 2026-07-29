export interface GapFillResultSummary {
  sitesWithGaps: number;
  daysFilled: number;
  daysRemaining: number;
  daysFailed: number;
  daysOutOfRetention: number;
  rounds: number;
}

export interface GapFillJobStatus {
  running: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  round: number;
  result: GapFillResultSummary | null;
}

let status: GapFillJobStatus = {
  running: false,
  startedAt: null,
  finishedAt: null,
  error: null,
  round: 0,
  result: null,
};

export function getGapFillStatus(): GapFillJobStatus {
  return { ...status };
}

export function startGapFillStatus(): void {
  status = { running: true, startedAt: new Date().toISOString(), finishedAt: null, error: null, round: 0, result: null };
}

export function updateGapFillProgress(round: number, cumulative: GapFillResultSummary): void {
  status.round = round;
  status.result = cumulative;
}

export function finishGapFillStatus(result: GapFillResultSummary | null, error: string | null = null): void {
  status.running = false;
  status.finishedAt = new Date().toISOString();
  status.error = error;
  if (result) status.result = result;
}
