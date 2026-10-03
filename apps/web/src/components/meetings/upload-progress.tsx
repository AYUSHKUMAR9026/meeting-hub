'use client';

import { WifiOffIcon } from 'lucide-react';

import { FormError } from '@/components/app/form-field';
import { Button } from '@/components/ui/button';
import type { RecordingUploadState } from '@/hooks/use-recording-upload';
import { formatBytes, formatDuration } from '@/lib/upload/progress';

/** Progress bar with speed and time remaining, plus cancel / resume controls. */
export function UploadProgressView({
  state,
  onCancel,
  onResume,
}: {
  state: RecordingUploadState;
  onCancel: () => void;
  onResume: () => void;
}) {
  if (state.phase === 'uploading') {
    const { uploadedBytes, totalBytes } = state.progress;
    const percent = totalBytes ? Math.floor((uploadedBytes / totalBytes) * 100) : 0;
    const finishing = totalBytes > 0 && uploadedBytes >= totalBytes;
    return (
      <div className="grid gap-2" data-testid="upload-progress">
        <div
          role="progressbar"
          aria-label="Upload progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="font-medium">{finishing ? 'Finishing…' : `${percent}%`}</span>
          <span className="text-muted-foreground">
            {formatBytes(uploadedBytes)} of {formatBytes(totalBytes)}
          </span>
          {!finishing && state.bytesPerSecond > 0 && (
            <span className="text-muted-foreground">{formatBytes(state.bytesPerSecond)}/s</span>
          )}
          {!finishing && state.etaSeconds !== null && (
            <span className="text-muted-foreground">
              about {formatDuration(state.etaSeconds)} left
            </span>
          )}
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={onCancel}>
            Cancel upload
          </Button>
        </div>
        {state.offline && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <WifiOffIcon className="size-4" /> You&apos;re offline. The upload continues when the
            connection is back.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Keep this tab open until the upload finishes.
        </p>
      </div>
    );
  }

  if (state.phase === 'failed') {
    return (
      <div className="grid gap-2">
        <FormError message={state.message} />
        <div className="flex gap-2">
          {state.canResume && (
            <Button type="button" size="sm" onClick={onResume}>
              Resume upload
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {state.canResume ? 'Cancel upload' : 'Discard'}
          </Button>
        </div>
      </div>
    );
  }

  return null;
}
