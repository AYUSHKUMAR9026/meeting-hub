'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useWorkspace } from '@/components/app/workspace-context';
import { api, problemMessage } from '@/lib/api/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

import type { RoomView } from '@meeting-hub/contracts';

export function RoomControls({ id, allowStart }: { id: string; allowStart: boolean }) {
  const ws = useWorkspace();
  const [room, setRoom] = useState<RoomView>();
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(true);
  useEffect(() => {
    if (!ws.features.includes('rooms.enabled')) return;
    const load = () => {
      void api
        .GET('/v1/meetings/{id}/room', { params: { path: { id } } })
        .then((r) => {
          if (r.data) setRoom(r.data);
        })
        .catch(() => setError('Could not refresh room status.'));
    };
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [id, ws.features]);
  if (!room) return error ? <p role="alert">{error}</p> : null;
  if (room.status === 'none' && !allowStart) return null;
  return (
    <section className="grid gap-3 rounded-lg border p-4">
      <p>
        {room.status === 'live' ? (
          <Badge>Live</Badge>
        ) : room.status === 'ended' ? (
          'Meeting ended'
        ) : (
          'Meeting room'
        )}
      </p>
      {room.present.length > 0 && <p>{room.present.map((p) => p.name).join(', ')}</p>}
      {room.recordingStatus === 'failed' && <p role="alert">Recording failed</p>}
      {allowStart && room.canHost && (room.status === 'none' || room.status === 'scheduled') && (
        <>
          <label>
            <input
              type="checkbox"
              checked={recording}
              onChange={(e) => setRecording(e.target.checked)}
            />{' '}
            Record this meeting
          </label>
          <Button
            onClick={() => {
              void (async () => {
                const r = await api.POST('/v1/meetings/{id}/room/start', {
                  params: { path: { id } },
                  body: { recordingEnabled: recording },
                });
                if (r.data) setRoom(r.data);
                else setError(problemMessage(r.error));
              })().catch((e) => setError(problemMessage(e)));
            }}
          >
            Start meeting
          </Button>
        </>
      )}
      {room.status === 'live' && room.canJoin && (
        <Link className="underline" href={`/w/${ws.slug}/m/${id}/room`}>
          Join meeting
        </Link>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
