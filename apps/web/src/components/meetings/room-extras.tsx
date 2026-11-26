'use client';
import { useChat, useParticipants } from '@livekit/components-react';
import { useEffect, useRef, useState } from 'react';
import { useCurrentUser } from '@/components/app/workspace-context';
import { api } from '@/lib/api/client';

/** Persist only messages sent by this authenticated browser; never trust a claimed remote sender. */
export function RoomExtras({ meetingId }: { meetingId: string }) {
  const user = useCurrentUser();
  const participants = useParticipants();
  const { chatMessages } = useChat();
  const saved = useRef(new Set<string>());
  const [error, setError] = useState('');
  useEffect(() => {
    const persist = async () => {
      for (const message of chatMessages) {
        if (message.from?.identity !== user.id) continue;
        const clientId = String(message.id ?? message.timestamp);
        if (saved.current.has(clientId)) continue;
        const r = await api.POST('/v1/meetings/{id}/room/chat', {
          params: { path: { id: meetingId } },
          body: { clientId, text: message.message },
        });
        if (r.response.ok) {
          saved.current.add(clientId);
          setError('');
        } else
          setError('Chat is delivered live, but saving it failed. Keep this tab open to retry.');
      }
    };
    void persist();
    const timer = setInterval(() => void persist(), 3000);
    return () => clearInterval(timer);
  }, [chatMessages, meetingId, user.id]);
  return (
    <aside aria-label="Participants" className="max-h-28 overflow-auto rounded border p-3">
      <h2 className="font-semibold">Participants ({participants.length})</h2>
      <ul>
        {participants.map((p) => (
          <li key={p.identity}>
            {p.name || p.identity}
            {p.isLocal ? ' (you)' : ''}
          </li>
        ))}
      </ul>
      {error && <p role="status">{error}</p>}
    </aside>
  );
}
