import type { Metadata } from 'next';

import { StatusBoard } from './status-board';

export const metadata: Metadata = { title: 'System status · Meeting Hub' };

export default function StatusPage() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-12">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">System status</h1>
        <p className="text-sm text-muted-foreground">
          Live readiness of the API&apos;s dependencies, from <code>GET /ready</code>.
        </p>
      </div>
      <StatusBoard />
    </main>
  );
}
