'use client';
import { useState } from 'react';
import { api, problemMessage } from '@/lib/api/client';
import { useApiQuery } from '@/hooks/use-api-query';
import { useWorkspace } from '@/components/app/workspace-context';
import { formatInZone } from '@/lib/time-zone';

export function SavedChat({ meetingId }: { meetingId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="rounded border p-4" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-medium">Meeting chat</summary>
      {open && <Messages meetingId={meetingId} />}
    </details>
  );
}

function Messages({ meetingId }: { meetingId: string }) {
  const workspace = useWorkspace();
  const { state } = useApiQuery(`chat:${meetingId}`, () =>
    api.GET('/v1/meetings/{id}/room/chat', { params: { path: { id: meetingId } } }),
  );
  if (state.status === 'loading') return <p role="status">Loading chat…</p>;
  if (state.status === 'error') return <p role="alert">{problemMessage(state.error)}</p>;
  if (!state.data.messages.length) return <p>No saved messages.</p>;
  return (
    <ol className="mt-3 grid max-h-96 gap-3 overflow-auto">
      {state.data.messages.map((message) => (
        <li key={message.id}>
          <p className="text-sm text-muted-foreground">
            {message.name} · {formatInZone(message.createdAt, workspace.settings.timezone)}
          </p>
          <p className="whitespace-pre-wrap break-words">{message.text}</p>
        </li>
      ))}
    </ol>
  );
}
