'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { createApiTransport } from '@/lib/upload/api-transport';
import {
  ApiError,
  MultipartUploader,
  UploadCancelledError,
  type UploadProgress,
} from '@/lib/upload/multipart-uploader';
import { etaSeconds, SpeedMeter } from '@/lib/upload/progress';

export type RecordingUploadState =
  | { phase: 'idle' }
  | {
      phase: 'uploading';
      progress: UploadProgress;
      bytesPerSecond: number;
      etaSeconds: number | null;
      offline: boolean;
    }
  | { phase: 'done' }
  | { phase: 'failed'; message: string; canResume: boolean; progress: UploadProgress | null }
  | { phase: 'cancelled' };

/** How often progress re-renders (XHR progress events fire far more often). */
const RENDER_EVERY_MS = 200;

function failureMessage(err: unknown): { message: string; canResume: boolean } {
  if (err instanceof ApiError) {
    // The API refused (wrong type, too large, upload gone…): resuming the same upload won't help.
    return { message: err.message, canResume: err.status >= 500 };
  }
  return {
    message:
      'The upload stopped because the connection kept failing. Resume to continue from where it stopped.',
    canResume: true,
  };
}

/**
 * Drives one recording upload: progress, speed and time remaining, resume after a failure,
 * cancel, and a "leave site?" warning while bytes are in flight.
 */
export function useRecordingUpload() {
  const [state, setState] = useState<RecordingUploadState>({ phase: 'idle' });
  const uploader = useRef<MultipartUploader | null>(null);
  const meter = useRef(new SpeedMeter());
  const lastProgress = useRef<UploadProgress | null>(null);
  const lastRender = useRef(0);

  const active = state.phase === 'uploading';

  // Warn before closing or reloading the tab mid-upload (the bytes so far would be lost).
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [active]);

  // Show "waiting for network" while offline; the uploader itself pauses its retries.
  useEffect(() => {
    if (!active) return;
    const update = () =>
      setState((s) => (s.phase === 'uploading' ? { ...s, offline: !navigator.onLine } : s));
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, [active]);

  const onProgress = useCallback((progress: UploadProgress) => {
    lastProgress.current = progress;
    const speed = meter.current.update(progress.uploadedBytes);
    const now = Date.now();
    if (
      now - lastRender.current < RENDER_EVERY_MS &&
      progress.uploadedBytes < progress.totalBytes
    ) {
      return;
    }
    lastRender.current = now;
    setState({
      phase: 'uploading',
      progress,
      bytesPerSecond: speed,
      etaSeconds: etaSeconds(progress.totalBytes - progress.uploadedBytes, speed),
      offline: typeof navigator !== 'undefined' && !navigator.onLine,
    });
  }, []);

  const drive = useCallback(async (): Promise<boolean> => {
    const current = uploader.current;
    if (!current) return false;
    meter.current.reset();
    setState({
      phase: 'uploading',
      progress: lastProgress.current ?? {
        uploadedBytes: 0,
        totalBytes: 0,
        partsDone: 0,
        partCount: 0,
      },
      bytesPerSecond: 0,
      etaSeconds: null,
      offline: false,
    });
    try {
      await current.run();
      setState({ phase: 'done' });
      return true;
    } catch (err) {
      if (err instanceof UploadCancelledError) {
        setState({ phase: 'cancelled' });
      } else {
        setState({ phase: 'failed', ...failureMessage(err), progress: lastProgress.current });
      }
      return false;
    }
  }, []);

  /** Uploads `file` to the meeting. Resolves true once the API has marked it uploaded. */
  const start = useCallback(
    (meetingId: string, file: File, contentType: string) => {
      lastProgress.current = null;
      uploader.current = new MultipartUploader(
        file,
        contentType,
        createApiTransport(meetingId),
        onProgress,
      );
      return drive();
    },
    [drive, onProgress],
  );

  /** Continues a failed upload: only parts that didn't finish are sent again. */
  const resume = useCallback(() => drive(), [drive]);

  const cancel = useCallback(async () => {
    try {
      await uploader.current?.cancel();
    } finally {
      setState({ phase: 'cancelled' });
    }
  }, []);

  const reset = useCallback(() => {
    uploader.current = null;
    lastProgress.current = null;
    setState({ phase: 'idle' });
  }, []);

  return { state, start, resume, cancel, reset };
}
