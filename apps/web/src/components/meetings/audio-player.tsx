'use client';

import { type RefObject, useEffect, useImperativeHandle, useRef, useState } from 'react';

import { FormError } from '@/components/app/form-field';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, type MeetingMedia, problemMessage } from '@/lib/api/client';
import { formatDuration, refreshDelayMs } from '@/lib/processing';

import { Waveform } from './waveform';

export interface AudioPlayerHandle {
  seek(positionMs: number): void;
}

/** Plays normalized audio and refreshes its signed URL without losing the playback position. */
export function AudioPlayer({
  meetingId,
  playerRef,
  waveform,
  onTime,
  initialPositionMs,
}: {
  meetingId: string;
  playerRef: RefObject<AudioPlayerHandle | null>;
  waveform: boolean;
  onTime: (ms: number) => void;
  initialPositionMs?: number;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const pendingSeek = useRef(initialPositionMs);
  useImperativeHandle(
    playerRef,
    () => ({
      seek(positionMs) {
        const element = audio.current;
        if (element && element.readyState > 0) element.currentTime = positionMs / 1000;
        else pendingSeek.current = positionMs;
        onTime(positionMs);
      },
    }),
    [onTime],
  );
  const [media, setMedia] = useState<MeetingMedia | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elementDurationMs, setElementDurationMs] = useState<number | null>(null);
  /** Bumped to fetch fresh signed URLs. */
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    void api
      .GET('/v1/meetings/{id}/media', { params: { path: { id: meetingId } } })
      .then(({ data, error: apiError }) => {
        if (!active) return;
        if (data) {
          setMedia(data);
          setError(null);
        } else {
          setError(problemMessage(apiError, 'Could not load the audio.'));
        }
      });
    return () => {
      active = false;
    };
  }, [meetingId, generation]);

  // Fresh URLs a minute before these expire.
  useEffect(() => {
    if (!media) return;
    const timer = setTimeout(
      () => setGeneration((g) => g + 1),
      refreshDelayMs(media.expiresAt, Date.now()),
    );
    return () => clearTimeout(timer);
  }, [media]);

  // Swap the source in place: same audio, new URL; keep the position and play state.
  useEffect(() => {
    const element = audio.current;
    if (!element || !media) return;
    if (!element.getAttribute('src')) {
      element.src = media.audio.url;
      return;
    }
    const position = element.currentTime;
    const playing = !element.paused;
    element.src = media.audio.url;
    element.currentTime = position;
    if (playing) void element.play().catch(() => {});
  }, [media]);

  const durationMs = elementDurationMs ?? media?.audio.durationMs ?? null;

  return (
    <Card data-testid="audio-card">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>Audio</CardTitle>
          {durationMs !== null && (
            <span className="text-sm text-muted-foreground" data-testid="audio-duration">
              {formatDuration(durationMs)}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        {error && <FormError message={error} />}
        {!media && !error && <Skeleton className="h-10 w-full" />}
        {waveform && media?.peaks && <Waveform url={media.peaks.url} />}
        <audio
          ref={audio}
          controls
          onTimeUpdate={(e) => onTime(Math.round(e.currentTarget.currentTime * 1000))}
          preload="metadata"
          hidden={!media}
          className="w-full"
          data-testid="meeting-audio"
          onLoadedMetadata={(e) => {
            const seconds = e.currentTarget.duration;
            if (Number.isFinite(seconds)) setElementDurationMs(Math.round(seconds * 1000));
            if (pendingSeek.current !== undefined) {
              const position = pendingSeek.current;
              pendingSeek.current = undefined;
              e.currentTarget.currentTime = position / 1000;
              onTime(position);
            }
          }}
        >
          Your browser can’t play this audio.
        </audio>
      </CardContent>
    </Card>
  );
}
