'use client';
import type { components } from '@/lib/api/schema';
import Link from 'next/link';
import { useCan, useWorkspace } from '@/components/app/workspace-context';
import { useApiQuery } from '@/hooks/use-api-query';
import { api } from '@/lib/api/client';
import { Button } from '@/components/ui/button';

export default function ReadinessPage() {
  const ws = useWorkspace();
  const can = useCan();
  const query = useApiQuery<components['schemas']['SystemReadiness']>('readiness:' + ws.id, () =>
    can('workspace.update')
      ? api.GET('/v1/workspaces/{wid}/readiness', { params: { path: { wid: ws.id } } })
      : Promise.resolve({ response: new Response(null, { status: 403 }) }),
  );
  if (!can('workspace.update')) return <p>Only owners and admins can view system readiness.</p>;
  return (
    <section className="grid gap-4">
      <h1 className="text-2xl font-semibold">System readiness</h1>
      <Button variant="outline" onClick={query.reload}>
        Check again
      </Button>
      {query.state.status === 'loading' && <p>Checking services…</p>}
      {query.state.status === 'error' && (
        <p role="alert">Could not check readiness. Please retry.</p>
      )}
      {query.state.status === 'ok' &&
        query.state.data.features.map((f) => (
          <article key={f.name} className="rounded border p-4">
            <h2 className="font-semibold">
              {f.name}: {f.state}
            </h2>
            <p>{f.reason}</p>
            {f.fix === 'settings' && (
              <Link className="underline" href={`/w/${ws.slug}/settings`}>
                Open settings
              </Link>
            )}
            {f.fix === 'environment' && (
              <p className="text-sm text-muted-foreground">
                Check .env.local and run pnpm dev:full. Restart after changing server configuration.
              </p>
            )}
          </article>
        ))}
    </section>
  );
}
