import type { ProcessingRun, RunStatus } from '@/lib/api/client';

const STEP_LABELS: Record<string, string> = {
  prepare_media: 'Preparing audio',
};

const PHASE_LABELS: Record<string, string> = {
  downloading: 'Fetching the recording',
  transcoding: 'Converting audio',
  uploading: 'Saving',
};

/** Human label for a step name; unknown (future) steps get a readable fallback. */
export function stepLabel(name: string): string {
  return STEP_LABELS[name] ?? name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export const phaseLabel = (phase: string | null | undefined) =>
  phase ? (PHASE_LABELS[phase] ?? phase) : null;

const ACTIVE: readonly RunStatus[] = [
  'queued',
  'preparing_media',
  'transcribing',
  'analyzing',
  'indexing',
];

export const isRunActive = (status: RunStatus | undefined) =>
  status !== undefined && ACTIVE.includes(status);

/** "45 s", "3 min 05 s", "1 h 02 min". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}

/** "1:05", "1:02:09" for a media duration. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Elapsed time of a run: until it finished, or until `now` while it is going. */
export function runElapsedMs(
  run: Pick<ProcessingRun, 'createdAt' | 'finishedAt'>,
  now: number,
): number {
  const start = new Date(run.createdAt).getTime();
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
  return Math.max(0, end - start);
}

/**
 * When to fetch fresh signed media URLs: a minute before they expire (or halfway, for very short
 * lifetimes), never sooner than 5 s from now.
 */
export function refreshDelayMs(expiresAt: string, now: number): number {
  const remaining = new Date(expiresAt).getTime() - now;
  const margin = Math.min(60_000, remaining / 2);
  return Math.max(5_000, remaining - margin);
}

/** Whether a list shows meetings whose status is about to change (worth refreshing it). */
export const hasMeetingsInFlight = (
  meetings: readonly { status: string }[],
  pipelineEnabled: boolean,
) =>
  meetings.some((m) => m.status === 'processing' || (pipelineEnabled && m.status === 'uploaded'));
