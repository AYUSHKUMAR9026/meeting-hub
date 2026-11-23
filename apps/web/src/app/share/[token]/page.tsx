import { publicShareSchema, type PublicShare } from '@meeting-hub/contracts';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';

import { formatDuration } from '@/lib/processing';

export const metadata: Metadata = {
  title: 'Shared meeting',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

async function loadShare(token: string): Promise<PublicShare | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const apiUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/$/, '');
  try {
    const forwarded = (await headers()).get('x-forwarded-for');
    const response = await fetch(apiUrl + '/v1/public/shares/' + token, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
      headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Share request failed');
    const data = publicShareSchema.safeParse(await response.json());
    if (data.success) return data.data;
  } catch {
    throw new Error('Could not load the shared meeting.');
  }
  throw new Error('Could not read the shared meeting.');
}

export default async function SharedMeetingPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const share = await loadShare(token);
  if (!share) notFound();
  return (
    <main className="mx-auto grid max-w-3xl gap-8 px-5 py-10">
      <header className="grid gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{share.title}</h1>
        <time className="text-sm text-muted-foreground" dateTime={share.occurredAt}>
          {share.occurredAt.slice(0, 10)}
        </time>
      </header>
      <section className="grid gap-2">
        <h2 className="text-xl font-semibold">Summary</h2>
        <p className="whitespace-pre-wrap">{share.summary.paragraph}</p>
        <ul className="list-disc pl-5">
          {share.summary.bullets.map((bullet, index) => (
            <li key={index}>{bullet}</li>
          ))}
        </ul>
      </section>
      {[
        { title: 'Decisions', items: share.decisions },
        { title: 'Action items', items: share.actionItems },
      ].map(({ title, items }) => (
        <section key={title} className="grid gap-3">
          <h2 className="text-xl font-semibold">{title}</h2>
          {items.length === 0 && <p className="text-muted-foreground">No {title.toLowerCase()}.</p>}
          {items.map((item, index) => (
            <article key={index} className="grid gap-1 rounded-md border p-4">
              <h3 className="font-medium">{item.title}</h3>
              <p className="text-sm text-muted-foreground capitalize">
                {item.status === 'proposed' ? 'Unconfirmed' : item.status}
              </p>
              <p className="whitespace-pre-wrap">{item.description}</p>
              {'rationale' in item && item.rationale && <p>{item.rationale}</p>}
              {'owner' in item && (item.owner || item.dueDate) && (
                <p className="text-sm text-muted-foreground">
                  {[item.owner, item.dueDate].filter(Boolean).join(' · ')}
                </p>
              )}
              {item.timestampsMs.length > 0 && (
                <p className="font-mono text-xs text-muted-foreground">
                  {item.timestampsMs.map(formatDuration).join(' · ')}
                </p>
              )}
            </article>
          ))}
        </section>
      ))}
      {share.transcript && (
        <section className="grid gap-3">
          <h2 className="text-xl font-semibold">Transcript</h2>
          {share.transcript.length === 0 && (
            <p className="text-muted-foreground">No transcript segments.</p>
          )}
          {share.transcript.map((segment, index) => (
            <article key={index} className="grid gap-1 border-t pt-3">
              <p className="text-sm font-medium">
                <span className="mr-2 font-mono text-muted-foreground">
                  {formatDuration(segment.startMs)}
                </span>
                {segment.speaker}
              </p>
              <p className="whitespace-pre-wrap">{segment.text}</p>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}
