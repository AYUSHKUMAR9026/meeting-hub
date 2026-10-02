'use client';

import { useCallback, useEffect, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api, type DependencyCheck, type ReadyResponse } from '@/lib/api/client';

const REFRESH_MS = 5_000;

const LABELS: Record<keyof ReadyResponse['checks'], string> = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
  s3: 'Object storage (S3)',
};

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; data: ReadyResponse; checkedAt: Date }
  | { kind: 'unreachable'; message: string; checkedAt: Date };

async function fetchReadiness(): Promise<State> {
  try {
    // /ready answers 503 with the same body when a dependency is down.
    const { data, error } = await api.GET('/ready', { cache: 'no-store' });
    const body = data ?? error;
    return body
      ? { kind: 'ok', data: body, checkedAt: new Date() }
      : { kind: 'unreachable', message: 'Empty response', checkedAt: new Date() };
  } catch (err) {
    return {
      kind: 'unreachable',
      message: err instanceof Error ? err.message : String(err),
      checkedAt: new Date(),
    };
  }
}

export function StatusBoard() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const refresh = useCallback(() => {
    void fetchReadiness().then(setState);
  }, []);

  useEffect(() => {
    let active = true;
    const poll = () =>
      void fetchReadiness().then((next) => {
        if (active) setState(next);
      });
    poll();
    const id = setInterval(poll, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <OverallBadge state={state} />
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {state.kind !== 'loading' && <span>Checked {state.checkedAt.toLocaleTimeString()}</span>}
          <Button variant="outline" size="sm" onClick={refresh}>
            Refresh
          </Button>
        </div>
      </div>

      {state.kind === 'unreachable' && (
        <Card>
          <CardHeader>
            <CardTitle>API unreachable</CardTitle>
            <CardDescription>
              Could not reach {process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/ready —{' '}
              {state.message}. Is <code>pnpm dev</code> running?
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {(Object.keys(LABELS) as (keyof typeof LABELS)[]).map((name) => (
          <DependencyCard
            key={name}
            label={LABELS[name]}
            check={state.kind === 'ok' ? state.data.checks[name] : undefined}
            loading={state.kind === 'loading'}
          />
        ))}
      </div>
    </div>
  );
}

function OverallBadge({ state }: { state: State }) {
  if (state.kind === 'loading') return <Badge variant="secondary">Checking…</Badge>;
  if (state.kind === 'unreachable') return <Badge variant="destructive">API unreachable</Badge>;
  return state.data.status === 'ready' ? (
    <Badge>All systems ready</Badge>
  ) : (
    <Badge variant="destructive">Not ready</Badge>
  );
}

function DependencyCard({
  label,
  check,
  loading,
}: {
  label: string;
  check: DependencyCheck | undefined;
  loading: boolean;
}) {
  const healthy = check?.status === 'up';
  return (
    <Card data-testid={`dependency-${label}`}>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          {label}
          {check ? (
            <Badge variant={healthy ? 'default' : 'destructive'}>
              {healthy ? 'Healthy' : 'Down'}
            </Badge>
          ) : (
            <Badge variant="secondary">{loading ? '…' : 'Unknown'}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        {check ? (
          <>
            <div>Latency: {check.latencyMs} ms</div>
            {check.error && <div className="mt-1 break-words text-destructive">{check.error}</div>}
          </>
        ) : (
          <div>No data yet</div>
        )}
      </CardContent>
    </Card>
  );
}
