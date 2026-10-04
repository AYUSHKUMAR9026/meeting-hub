'use client';

import { useEffect, useRef, useState } from 'react';

import { FormError } from '@/components/app/form-field';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, type MeetingMedia, problemMessage } from '@/lib/api/client';
import { formatDuration, refreshDelayMs } from '@/lib/processing';

/**
 * Plays the meeting's normalized audio from a short-lived signed URL, fetching a fresh one before
 * it expires and swapping it in without losing the playback position. The waveform comes later.
 * Render it with `key={runId}` so a reprocess remounts it with the new audio.
 */
export function AudioPlayer({ meetingId }: { meetingId: string }) {
  const audio = useRef<HTMLAudioElement>(null);
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
        {/* Plain element for now; the waveform and transcript sync come in a later phase. */}
        <audio
          ref={audio}
          controls
          preload="metadata"
          hidden={!media}
          className="w-full"
          data-testid="meeting-audio"
          onLoadedMetadata={(e) => {
            const seconds = e.currentTarget.duration;
            if (Number.isFinite(seconds)) setElementDurationMs(Math.round(seconds * 1000));
          }}
        >
          Your browser can’t play this audio.
        </audio>
      </CardContent>
    </Card>
  );
}
