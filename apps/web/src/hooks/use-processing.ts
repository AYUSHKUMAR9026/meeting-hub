'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type MeetingProcessing } from '@/lib/api/client';

/** How often to poll GET /processing while the live stream is down. */
export const POLL_INTERVAL_MS = 5_000;
/** The SSE event carrying a MeetingProcessing body (see the API's `/events` route). */
const RUN_UPDATED = 'run.updated';

export type ProcessingState =
  | { status: 'loading' }
  | { status: 'ok'; data: MeetingProcessing; live: boolean }
  | { status: 'error'; httpStatus: number };

/**
 * A meeting's processing state, kept current: Server-Sent Events from `/v1/meetings/{id}/events`
 * (same origin, through the Next.js proxy), and polling every 5 s whenever the stream is down.
 * EventSource reconnects on its own; polling stops again once it does.
 */
export function useProcessing(meetingId: string) {
  const [state, setState] = useState<ProcessingState>({ status: 'loading' });
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const live = useRef(false);

  const fetchOnce = useCallback(async () => {
    const { data, response } = await api.GET('/v1/meetings/{id}/processing', {
      params: { path: { id: meetingId } },
    });
    if (data) setState({ status: 'ok', data, live: live.current });
    else
      setState((prev) =>
        prev.status === 'ok' ? prev : { status: 'error', httpStatus: response.status },
      );
  }, [meetingId]);

  useEffect(() => {
    let closed = false;
    const stopPolling = () => {
      clearInterval(pollTimer.current);
      pollTimer.current = undefined;
    };
    const startPolling = () => {
      if (pollTimer.current || closed) return;
      void fetchOnce();
      pollTimer.current = setInterval(() => void fetchOnce(), POLL_INTERVAL_MS);
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
      return () => {
        closed = true;
        stopPolling();
      };
    }
    const source = new EventSource(`/v1/meetings/${meetingId}/events`);
    source.addEventListener(RUN_UPDATED, (event) => {
      live.current = true;
      stopPolling();
      setState({
        status: 'ok',
        data: JSON.parse((event as MessageEvent<string>).data) as MeetingProcessing,
        live: true,
      });
    });
    source.addEventListener('meeting.gone', () => {
      source.close();
      setState({ status: 'error', httpStatus: 404 });
    });
    source.onerror = () => {
      live.current = false;
      setState((prev) => (prev.status === 'ok' ? { ...prev, live: false } : prev));
      // A refused connection (404/403) closes the source for good; a dropped one retries.
      startPolling();
    };
    return () => {
      closed = true;
      source.close();
      stopPolling();
    };
  }, [meetingId, fetchOnce]);

  return { state, refresh: fetchOnce };
}

/** Calls `reload` every `intervalMs` while `active`. */
export function useRefreshWhile(
  active: boolean,
  reload: () => void,
  intervalMs = POLL_INTERVAL_MS,
) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, intervalMs);
    return () => clearInterval(timer);
  }, [active, reload, intervalMs]);
}
