'use client';

import {
  CheckCircle2Icon,
  CircleDashedIcon,
  LoaderCircleIcon,
  RotateCcwIcon,
  XCircleIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, type ProcessingRun, type ProcessingStep, problemMessage } from '@/lib/api/client';
import { formatElapsed, isRunActive, phaseLabel, runElapsedMs, stepLabel } from '@/lib/processing';

/** Re-renders every second while `active`, for a ticking elapsed time. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function StepIcon({ step }: { step: ProcessingStep }) {
  switch (step.status) {
    case 'succeeded':
      return <CheckCircle2Icon className="size-4 text-emerald-600" aria-hidden />;
    case 'failed':
      return <XCircleIcon className="size-4 text-destructive" aria-hidden />;
    case 'running':
    case 'waiting_external':
      return <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" aria-hidden />;
    default:
      return <CircleDashedIcon className="size-4 text-muted-foreground" aria-hidden />;
  }
}

function ProgressBar({ value, label }: { value: number; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
      data-testid="processing-progress"
    >
      <div
        className="h-full bg-primary transition-[width] duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/**
 * The meeting's processing run: steps, overall progress and elapsed time, live while it runs; the
 * reason when it failed (plus the internal detail for owners and admins), and Reprocess for them.
 */
export function ProcessingPanel({
  meetingId,
  run,
  live,
  canReprocess,
  onReprocessed,
}: {
  meetingId: string;
  run: ProcessingRun;
  live: boolean;
  canReprocess: boolean;
  onReprocessed: () => void;
}) {
  const active = isRunActive(run.status);
  const now = useNow(active);
  const [submitting, setSubmitting] = useState(false);
  const elapsed = formatElapsed(runElapsedMs(run, now));
  const running = run.steps.find((s) => s.status === 'running');

  async function reprocess() {
    setSubmitting(true);
    const { error } = await api.POST('/v1/meetings/{id}/runs', {
      params: { path: { id: meetingId } },
      body: {},
    });
    setSubmitting(false);
    if (error) {
      toast.error(problemMessage(error, 'Could not start processing.'));
      return;
    }
    toast.success('Processing started again');
    onReprocessed();
  }

  const title =
    run.status === 'completed'
      ? 'Processed'
      : run.status === 'failed'
        ? 'Processing failed'
        : run.status === 'cancelled'
          ? 'Processing cancelled'
          : 'Processing';

  return (
    <Card data-testid="processing-panel" data-run-status={run.status}>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>{title}</CardTitle>
          <span className="text-sm text-muted-foreground" data-testid="processing-elapsed">
            {active ? `${elapsed} so far` : `took ${elapsed}`}
          </span>
          {active && !live && (
            <span className="text-xs text-muted-foreground">(updating every few seconds)</span>
          )}
          {canReprocess && !active && (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={submitting}
              onClick={() => void reprocess()}
            >
              <RotateCcwIcon /> {submitting ? 'Starting…' : 'Reprocess'}
            </Button>
          )}
        </div>
        {active && (
          <CardDescription>
            {running
              ? `${stepLabel(running.name)}${phaseLabel(running.phase) ? ` · ${phaseLabel(running.phase)}` : ''}`
              : 'Waiting to start…'}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {(active || run.status === 'completed') && (
          <ProgressBar value={run.progress} label="Processing progress" />
        )}
        <ol className="grid gap-2" aria-label="Processing steps">
          {run.steps.map((step) => (
            <li
              key={step.name}
              className="flex items-center gap-2 text-sm"
              data-step-status={step.status}
            >
              <StepIcon step={step} />
              <span>{stepLabel(step.name)}</span>
              {step.status === 'running' && (
                <span className="text-muted-foreground">{Math.round(step.progress * 100)}%</span>
              )}
              {step.status === 'pending' && step.errorCode && (
                <span className="text-muted-foreground">retrying after an error…</span>
              )}
            </li>
          ))}
        </ol>
        {run.status === 'failed' && (
          <Alert variant="destructive" data-testid="processing-error">
            <AlertTitle>{run.errorMessage ?? 'Processing failed.'}</AlertTitle>
            <AlertDescription>
              <span>Code: {run.errorCode}</span>
              {run.steps
                .filter((s) => s.errorDetail)
                .map((s) => (
                  <details key={s.name} className="mt-2">
                    <summary className="cursor-pointer">Technical details (admins only)</summary>
                    <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-xs">
                      {s.errorDetail}
                    </pre>
                  </details>
                ))}
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
