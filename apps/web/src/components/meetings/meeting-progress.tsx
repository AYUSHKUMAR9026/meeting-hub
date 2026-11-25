'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useWorkspace } from '@/components/app/workspace-context';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, problemMessage } from '@/lib/api/client';

export function MeetingProgress({ meetingId }: { meetingId: string }) {
  const workspace = useWorkspace();
  if (!workspace.features.includes('progress.enabled')) return null;
  return <Panel key={`${workspace.id}:${meetingId}`} meetingId={meetingId} />;
}

function Panel({ meetingId }: { meetingId: string }) {
  const workspace = useWorkspace();
  const { state, reload } = useApiQuery(`meeting-progress:${workspace.id}:${meetingId}`, () =>
    api.GET('/v1/meetings/{id}/progress', { params: { path: { id: meetingId } } }),
  );
  useEffect(() => {
    const timer = setInterval(reload, 15_000);
    return () => clearInterval(timer);
  }, [reload]);
  return (
    <section className="grid gap-3 rounded-lg border p-4" aria-label="Progress">
      <h2 className="text-lg font-semibold">Progress</h2>
      {state.status === 'loading' && <p role="status">Loading meeting progress…</p>}
      {state.status === 'error' && (
        <p role="alert">{problemMessage(state.error, 'Could not load meeting progress.')}</p>
      )}
      {state.status === 'ok' && (
        <>
          <p>
            {state.data.recap.done} of {state.data.recap.items} actions done (
            {state.data.recap.completionRate}%). Time zone: {workspace.settings.timezone}.
          </p>
          {(
            [
              ['This meeting’s items', state.data.items],
              ['Carried over from earlier meetings', state.data.carriedOver],
            ] as const
          ).map(([title, items]) => (
            <div key={title}>
              <h3 className="font-medium">{title}</h3>
              {items.length ? (
                <ul className="list-inside list-disc">
                  {items.map((i) => (
                    <li key={i.id}>
                      <Link
                        className="underline"
                        href={`/w/${workspace.slug}/action-items?meetingId=${i.meetingId}&itemId=${i.id}`}
                      >
                        {i.title}
                      </Link>{' '}
                      — {i.status}
                      {i.dueDate ? ` · due ${i.dueDate}` : ''}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No items.</p>
              )}
            </div>
          ))}
          {state.data.truncated && <p>Showing the first 500 items. Open the tracker for more.</p>}
        </>
      )}
    </section>
  );
}
