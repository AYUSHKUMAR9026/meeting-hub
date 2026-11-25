'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { useWorkspace } from '@/components/app/workspace-context';
import { Button } from '@/components/ui/button';
import { useApiQuery } from '@/hooks/use-api-query';
import { api, problemMessage } from '@/lib/api/client';
import type { components } from '@/lib/api/schema';

type Summary = components['schemas']['ProgressSummary'];
type Series = components['schemas']['ProgressSeries'];
type Owners = components['schemas']['ProgressOwners'];
type Meetings = components['schemas']['ProgressMeetings'];

function ChartSection({
  title,
  children,
  table,
}: {
  title: string;
  children: ReactNode;
  table: ReactNode;
}) {
  return (
    <section className="min-w-0 break-inside-avoid rounded-lg border p-4" aria-label={title}>
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      <div className="h-64 w-full print:hidden" aria-hidden="true">
        {children}
      </div>
      <details className="mt-4 print:hidden">
        <summary className="cursor-pointer underline">
          View {title.toLowerCase()} data table
        </summary>
        {table}
      </details>
      <div className="hidden print:block">{table}</div>
    </section>
  );
}

export function ProgressDashboard() {
  const workspace = useWorkspace();
  if (!workspace.features.includes('progress.enabled'))
    return <p>Progress is unavailable in this workspace.</p>;
  return <Dashboard key={workspace.id} />;
}

function Dashboard() {
  const workspace = useWorkspace();
  const router = useRouter();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: workspace.settings.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const initial = new Date(`${today}T12:00:00Z`);
  initial.setUTCDate(initial.getUTCDate() - 29);
  const [from, setFrom] = useState(initial.toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [bucket, setBucket] = useState<'day' | 'week'>('day');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setVersion((v) => v + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const invalid =
    from > to || !from || !to || Date.parse(to) - Date.parse(from) >= 366 * 86_400_000;
  const path = { wid: workspace.id };
  const range = invalid ? {} : { from, to, bucket };
  const key = JSON.stringify([path, range, version]);
  const summary = useApiQuery<Summary>(key, () =>
    api.GET('/v1/workspaces/{wid}/progress/summary', { params: { path, query: range } }),
  );
  const series = useApiQuery<Series>(key, () =>
    api.GET('/v1/workspaces/{wid}/progress/timeseries', { params: { path, query: range } }),
  );
  const weeks = useApiQuery<Series>(key, () =>
    api.GET('/v1/workspaces/{wid}/progress/timeseries', {
      params: { path, query: { ...range, bucket: 'week' } },
    }),
  );
  const owners = useApiQuery<Owners>(`${workspace.id}:${version}`, () =>
    api.GET('/v1/workspaces/{wid}/progress/owners', { params: { path } }),
  );
  const meetings = useApiQuery<Meetings>(`${workspace.id}:${version}`, () =>
    api.GET('/v1/workspaces/{wid}/progress/meetings', { params: { path } }),
  );
  const base = `/w/${workspace.slug}`;
  const tracker = (filters: Record<string, string> = {}, kind = 'action-items') =>
    `${base}/${kind}?${new URLSearchParams(filters)}`;
  const jump = (status: string) => router.push(tracker({ status }));
  const ownerFilters = (o: Owners['owners'][number]): Record<string, string> =>
    o.ownerPersonId
      ? { ownerPersonId: o.ownerPersonId }
      : o.ownerSpeakerId
        ? { ownerSpeakerId: o.ownerSpeakerId }
        : { unassigned: 'true' };
  const failure = [summary.state, series.state, weeks.state, owners.state, meetings.state].find(
    (s) => s.status === 'error',
  );
  const loading = [summary.state, series.state, weeks.state, owners.state, meetings.state].some(
    (s) => s.status === 'loading',
  );
  const t = summary.state.status === 'ok' ? summary.state.data.totals : null;
  const points = series.state.status === 'ok' ? series.state.data.points : [];
  const weekly = weeks.state.status === 'ok' ? weeks.state.data.points : [];
  const perOwner = owners.state.status === 'ok' ? owners.state.data.owners : [];
  const perMeeting = meetings.state.status === 'ok' ? meetings.state.data.meetings : [];
  const cell = 'border-b px-3 py-2 text-left';
  return (
    <div className="grid gap-5" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Progress</h1>
        <Button variant="outline" onClick={() => setVersion((v) => v + 1)}>
          Refresh progress
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Workspace time zone: {workspace.settings.timezone}. Current totals include all meetings.
        History shows observed snapshots; missing dates have no observation. Weeks start Monday.
      </p>
      <div className="flex flex-wrap items-end gap-4 print:hidden">
        <label>
          From
          <input
            aria-label="From"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="ml-2 rounded border p-2"
          />
        </label>
        <label>
          To
          <input
            aria-label="To"
            type="date"
            value={to}
            max={today}
            onChange={(e) => setTo(e.target.value)}
            className="ml-2 rounded border p-2"
          />
        </label>
        <label>
          Bucket
          <select
            aria-label="Bucket"
            value={bucket}
            onChange={(e) => setBucket(e.target.value === 'week' ? 'week' : 'day')}
            className="ml-2 rounded border p-2"
          >
            <option value="day">Day</option>
            <option value="week">Week</option>
          </select>
        </label>
        {!invalid && (
          <a
            className="underline"
            href={`/v1/workspaces/${workspace.id}/progress/export?${new URLSearchParams({ from, to, bucket })}`}
          >
            Export CSV
          </a>
        )}
      </div>
      {invalid && <p role="alert">Choose an ordered date range of at most 366 days.</p>}
      {failure?.status === 'error' && (
        <p role="alert">
          {problemMessage(failure.error, 'Could not load progress. Try Refresh progress.')}
        </p>
      )}
      {loading && <p role="status">Loading progress…</p>}
      {owners.state.status === 'ok' && owners.state.data.truncated && (
        <p role="status">
          Showing the first 1,000 owner groups. Narrow the owner filter in the tracker for more.
        </p>
      )}
      {t && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Open', t.open, tracker({ status: 'open' })],
            ['Done', t.done, tracker({ status: 'done' })],
            [
              'Overdue',
              t.overdue,
              tracker({
                status: 'open',
                overdue: 'true',
              }),
            ],
            ['Completion rate', `${t.completionRate}%`, tracker()],
          ].map(([label, value, href]) => (
            <Link
              key={label}
              href={String(href)}
              className="rounded-lg border p-4"
              data-testid={`progress-${String(label).toLowerCase().replaceAll(' ', '-')}`}
            >
              <span className="block text-sm">{label}</span>
              <strong className="text-2xl">{value}</strong>
            </Link>
          ))}
        </div>
      )}
      {summary.state.status === 'ok' && (
        <p className="text-sm">
          {summary.state.data.change
            ? `Change since ${summary.state.data.comparisonDate}: open ${summary.state.data.change.open}, done ${summary.state.data.change.done}, overdue ${summary.state.data.change.overdue}, completion ${summary.state.data.change.completionRate} percentage points.`
            : 'No prior observation is available for comparison.'}
        </p>
      )}
      {!loading &&
        !failure &&
        t &&
        t.open + t.done + t.decisionsProposed + t.decisionsConfirmed === 0 && (
          <p>No progress items yet. Generate a meeting summary to get started.</p>
        )}
      {!invalid && (
        <>
          <ChartSection
            title="Actions over time"
            table={
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <caption>
                    Observed counts, {workspace.settings.timezone}; links show current tracker
                    items.
                  </caption>
                  <thead>
                    <tr>
                      {['Date', 'Open', 'Done', 'Overdue'].map((h) => (
                        <th className={cell} key={h}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((p) => (
                      <tr key={p.date}>
                        <th scope="row" className={cell}>
                          {p.date}
                          {p.backfilled ? ' (backfilled)' : ''}
                        </th>
                        {(['open', 'done', 'overdue'] as const).map((s) => (
                          <td className={cell} key={s}>
                            <Link
                              className="underline"
                              href={tracker(
                                s === 'overdue'
                                  ? {
                                      status: 'open',
                                      overdue: 'true',
                                    }
                                  : { status: s },
                              )}
                            >
                              {p[s]}
                            </Link>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!points.length && <p>No snapshots in this range.</p>}
              </div>
            }
          >
            <ResponsiveContainer>
              <LineChart accessibilityLayer={false} data={points}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Line
                  name="Open — solid"
                  dataKey="open"
                  stroke="#2563eb"
                  strokeWidth={2}
                  dot={{ r: 4, onClick: () => jump('open') }}
                  isAnimationActive={false}
                />
                <Line
                  name="Done — dashed"
                  dataKey="done"
                  stroke="#15803d"
                  strokeDasharray="7 3"
                  strokeWidth={2}
                  dot={{ r: 4, onClick: () => jump('done') }}
                  isAnimationActive={false}
                />
                <Line
                  name="Overdue — dotted"
                  dataKey="overdue"
                  stroke="#b45309"
                  strokeDasharray="2 4"
                  strokeWidth={2}
                  dot={{
                    r: 5,
                    onClick: () =>
                      router.push(
                        tracker({
                          status: 'open',
                          overdue: 'true',
                        }),
                      ),
                  }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </ChartSection>
          <div className="grid gap-5 lg:grid-cols-2">
            <ChartSection
              title="Decisions per week"
              table={
                <table className="w-full text-sm">
                  <caption>Decision creation and status transitions per Monday week</caption>
                  <thead>
                    <tr>
                      {['Week', 'Proposed', 'Confirmed'].map((h) => (
                        <th className={cell} key={h}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {weekly.map((p) => (
                      <tr key={p.date}>
                        <th scope="row" className={cell}>
                          {p.date}
                        </th>
                        <td className={cell}>
                          <Link href={tracker({ status: 'proposed' }, 'decisions')}>
                            {p.decisionsProposed}
                          </Link>
                        </td>
                        <td className={cell}>
                          <Link href={tracker({ status: 'confirmed' }, 'decisions')}>
                            {p.decisionsConfirmed}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              }
            >
              <ResponsiveContainer>
                <BarChart accessibilityLayer={false} data={weekly}>
                  <defs>
                    <pattern
                      id="confirmed-progress"
                      width="6"
                      height="6"
                      patternUnits="userSpaceOnUse"
                    >
                      <rect width="6" height="6" fill="#15803d" />
                      <path d="M0 0L6 6" stroke="white" />
                    </pattern>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  <Bar
                    name="Proposed — solid"
                    dataKey="decisionsProposed"
                    fill="#2563eb"
                    onClick={() => router.push(tracker({ status: 'proposed' }, 'decisions'))}
                    isAnimationActive={false}
                  />
                  <Bar
                    name="Confirmed — striped"
                    dataKey="decisionsConfirmed"
                    fill="url(#confirmed-progress)"
                    onClick={() => router.push(tracker({ status: 'confirmed' }, 'decisions'))}
                    isAnimationActive={false}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartSection>
            <ChartSection
              title="Actions by owner"
              table={
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <caption>Current counts; overdue is a subset of open</caption>
                    <thead>
                      <tr>
                        {['Owner', 'Open', 'Done', 'Overdue'].map((h) => (
                          <th className={cell} key={h}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {perOwner.map((o) => (
                        <tr key={o.key}>
                          <th scope="row" className={cell}>
                            <Link className="underline" href={tracker(ownerFilters(o))}>
                              {o.name}
                            </Link>
                          </th>
                          {(['open', 'done', 'overdue'] as const).map((s) => (
                            <td className={cell} key={s}>
                              <Link
                                href={tracker({
                                  ...ownerFilters(o),
                                  status: s === 'done' ? 'done' : 'open',

                                  ...(s === 'overdue'
                                    ? {
                                        overdue: 'true',
                                      }
                                    : {}),
                                })}
                              >
                                {o[s]}
                              </Link>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              }
            >
              <ResponsiveContainer>
                <BarChart
                  accessibilityLayer={false}
                  data={perOwner.map((o) => ({ ...o, notOverdue: o.open - o.overdue }))}
                >
                  <defs>
                    <pattern
                      id="overdue-progress"
                      width="5"
                      height="5"
                      patternUnits="userSpaceOnUse"
                    >
                      <rect width="5" height="5" fill="#b45309" />
                      <circle cx="2" cy="2" r="1" fill="white" />
                    </pattern>
                    <pattern id="done-progress" width="6" height="6" patternUnits="userSpaceOnUse">
                      <rect width="6" height="6" fill="#15803d" />
                      <path d="M0 0L6 6" stroke="white" />
                    </pattern>
                  </defs>
                  <XAxis dataKey="name" />
                  <YAxis allowDecimals={false} />
                  <Tooltip />
                  <Legend />
                  {(['notOverdue', 'done', 'overdue'] as const).map((s, i) => (
                    <Bar
                      key={s}
                      dataKey={s}
                      name={['Open (not overdue) — solid', 'Done — striped', 'Overdue — dotted'][i]}
                      stackId="items"
                      fill={['#2563eb', 'url(#done-progress)', 'url(#overdue-progress)'][i]}
                      isAnimationActive={false}
                      onClick={(data) => {
                        const o = perOwner.find((o) => o.key === data.key);
                        if (o)
                          router.push(
                            tracker({
                              ...ownerFilters(o),
                              status: s === 'done' ? 'done' : 'open',
                              ...(s === 'notOverdue' ? { overdue: 'false' } : {}),
                              ...(s === 'overdue'
                                ? {
                                    overdue: 'true',
                                  }
                                : {}),
                            }),
                          );
                      }}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </ChartSection>
          </div>
        </>
      )}
      <section className="rounded-lg border p-4">
        <h2 className="text-lg font-semibold">Latest meetings</h2>
        <ul className="divide-y">
          {perMeeting.map((m) => (
            <li key={m.id} className="flex flex-wrap justify-between gap-2 py-3">
              <Link className="underline" href={`${base}/m/${m.id}`}>
                {m.title}
              </Link>
              <span>
                {m.decisions} decisions · {m.items} actions · {m.completionRate}% done
              </span>
              <Link className="underline" href={tracker({ meetingId: m.id })}>
                View meeting actions
              </Link>
            </li>
          ))}
        </ul>
        {!loading && !perMeeting.length && <p>No meetings yet.</p>}
      </section>
    </div>
  );
}
