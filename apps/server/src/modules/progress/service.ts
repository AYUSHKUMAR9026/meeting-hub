import type { ProgressQuery, ProgressTotals } from '@meeting-hub/contracts';
import { eq, sql, workspaceSettings, progressSnapshots } from '@meeting-hub/db';
import type { SQL } from 'drizzle-orm';

import type { Database, Transaction } from '../../lib/db';
import { BadRequestError, NotFoundError } from '../../lib/errors';
import { authorize, type WorkspaceActor } from '../auth';
import type { FeatureFlagService } from '../platform';
import { bucketDate, completionRate, localDate, shiftDate } from './metrics';

type MeetingRow = {
  id: string;
  title: string;
  occurredAt: string;
  open: number;
  done: number;
  overdue: number;
  decisions: number;
  items: number;
  completionRate: number;
};
type OwnerRow = {
  key: string;
  name: string;
  ownerPersonId: string | null;
  ownerSpeakerId: string | null;
  open: number;
  done: number;
  overdue: number;
};
type ItemRow = {
  id: string;
  title: string;
  meetingId: string;
  status: string;
  dueDate: string | null;
};

/** All queries use tenant joins and a local timeout; no content is attached to failures. */
async function rows<T extends Record<string, unknown>>(tx: Transaction, query: SQL): Promise<T[]> {
  const result = await tx.execute(query);
  return result.rows as T[];
}

function scope(workspaceId: string, q: Partial<ProgressQuery>, timezone: string) {
  return sql`m.workspace_id = ${workspaceId} AND m.deleted_at IS NULL
    ${q.meetingId ? sql`AND m.id = ${q.meetingId}` : sql``}
    ${q.from ? sql`AND m.occurred_at >= (${q.from}::date::timestamp AT TIME ZONE ${timezone})` : sql``}
    ${q.to ? sql`AND m.occurred_at < ((${q.to}::date + 1)::timestamp AT TIME ZONE ${timezone})` : sql``}`;
}

function actions(workspaceId: string, q: Partial<ProgressQuery>, timezone: string) {
  return sql`SELECT a.*, m.id AS meeting_id FROM action_items a
    JOIN meeting_documents d ON d.id = a.document_id AND d.workspace_id = a.workspace_id AND d.is_current
    JOIN meetings m ON m.id = d.meeting_id AND m.workspace_id = d.workspace_id
    WHERE ${scope(workspaceId, q, timezone)} AND a.deleted_at IS NULL
    ${q.ownerPersonId ? sql`AND coalesce(a.owner_person_id, (SELECT s.person_id FROM transcript_speakers s WHERE s.id = a.owner_speaker_id AND s.workspace_id = a.workspace_id)) = ${q.ownerPersonId}` : sql``}`;
}

export class ProgressService {
  private cursor: string | undefined;
  constructor(private readonly db: Database) {}

  private async read<T>(
    actor: WorkspaceActor,
    run: (tx: Transaction, timezone: string, today: string) => Promise<T>,
  ) {
    authorize(actor, 'workspace.read');
    return this.db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        const [settings] = await tx
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, actor.workspaceId));
        if (!settings) throw new NotFoundError('Workspace not found');
        return run(tx, settings.timezone, localDate(new Date(), settings.timezone));
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  private async totals(
    tx: Transaction,
    workspaceId: string,
    timezone: string,
    today: string,
    q: Partial<ProgressQuery> = {},
  ): Promise<ProgressTotals> {
    const [a] = await rows<{ open: number; done: number; overdue: number; rejected: number }>(
      tx,
      sql`
      WITH a AS (${actions(workspaceId, q, timezone)}) SELECT
      count(*) FILTER (WHERE status = 'open')::int AS open,
      count(*) FILTER (WHERE status = 'done')::int AS done,
      count(*) FILTER (WHERE status = 'open' AND due_date < ${today}::date)::int AS overdue,
      count(*) FILTER (WHERE status = 'rejected')::int AS rejected FROM a`,
    );
    const [d] = await rows<{ proposed: number; confirmed: number; rejected: number }>(
      tx,
      sql`
      SELECT count(*) FILTER (WHERE a.status = 'proposed')::int AS proposed,
      count(*) FILTER (WHERE a.status = 'confirmed')::int AS confirmed,
      count(*) FILTER (WHERE a.status = 'rejected')::int AS rejected
      FROM decisions a JOIN meeting_documents d ON d.id = a.document_id AND d.workspace_id = a.workspace_id AND d.is_current
      JOIN meetings m ON m.id = d.meeting_id AND m.workspace_id = d.workspace_id
      WHERE ${scope(workspaceId, q, timezone)} AND a.deleted_at IS NULL ${q.ownerPersonId ? sql`AND false` : sql``}`,
    );
    const [m] = await rows<{ count: number }>(
      tx,
      sql`SELECT count(*)::int AS count FROM meetings m WHERE ${scope(workspaceId, q, timezone)}`,
    );
    return {
      open: a!.open,
      done: a!.done,
      overdue: a!.overdue,
      rejected: a!.rejected + d!.rejected,
      proposed: d!.proposed,
      decisionsProposed: d!.proposed,
      decisionsConfirmed: d!.confirmed,
      meetings: m!.count,
      completionRate: completionRate(a!.open, a!.done),
    };
  }

  async summary(actor: WorkspaceActor, q: ProgressQuery) {
    return this.read(actor, async (tx, timezone, today) => {
      const { from } = this.range(q, today);
      const totals = await this.totals(tx, actor.workspaceId, timezone, today, {
        meetingId: q.meetingId,
        ownerPersonId: q.ownerPersonId,
      });
      // Historical comparisons are available only at the persisted workspace granularity.
      const previous =
        q.ownerPersonId || q.meetingId
          ? []
          : await rows<{
              snapshot_date: string;
              open_count: number;
              done_count: number;
              overdue_count: number;
            }>(
              tx,
              sql`
        SELECT snapshot_date::text, open_count, done_count, overdue_count FROM progress_snapshots
        WHERE workspace_id = ${actor.workspaceId} AND snapshot_date < ${from}::date
        ORDER BY snapshot_date DESC LIMIT 1`,
            );
      const p = previous[0];
      return {
        timezone,
        today,
        totals,
        comparisonDate: p?.snapshot_date ?? null,
        change: p
          ? {
              open: totals.open - p.open_count,
              done: totals.done - p.done_count,
              overdue: totals.overdue - p.overdue_count,
              completionRate:
                Math.round(
                  (totals.completionRate - completionRate(p.open_count, p.done_count)) * 10,
                ) / 10,
            }
          : null,
      };
    });
  }

  private range(q: Partial<ProgressQuery>, today: string) {
    const to = q.to ?? today;
    const from = q.from ?? shiftDate(to, -29);
    if (from > to || (Date.parse(to) - Date.parse(from)) / 86_400_000 >= 366)
      throw new BadRequestError('Date range must be ordered and at most 366 days.');
    return { from, to };
  }

  async timeseries(actor: WorkspaceActor, q: ProgressQuery) {
    return this.read(actor, async (tx, timezone, today) => {
      if (q.ownerPersonId || q.meetingId)
        throw new BadRequestError(
          'Historical charts are workspace snapshots; owner and meeting filters apply to current totals only.',
        );
      const { from, to } = this.range(q, today);
      const snapshots = await rows<{
        date: string;
        open: number;
        done: number;
        overdue: number;
        backfilled: boolean;
      }>(
        tx,
        sql`
        SELECT snapshot_date::text AS date, open_count AS open, done_count AS done, overdue_count AS overdue, backfilled
        FROM progress_snapshots WHERE workspace_id = ${actor.workspaceId} AND snapshot_date BETWEEN ${from}::date AND ${to}::date
        ORDER BY snapshot_date LIMIT 366`,
      );
      const events = await rows<{ date: string; proposed: number; confirmed: number }>(
        tx,
        sql`
        SELECT (changed_at AT TIME ZONE ${timezone})::date::text AS date,
        count(*) FILTER (WHERE to_status = 'proposed')::int AS proposed,
        count(*) FILTER (WHERE to_status = 'confirmed')::int AS confirmed
        FROM item_status_events WHERE workspace_id = ${actor.workspaceId} AND item_type = 'decision'
        AND changed_at >= (${from}::date::timestamp AT TIME ZONE ${timezone})
        AND changed_at < ((${to}::date + 1)::timestamp AT TIME ZONE ${timezone}) GROUP BY 1 ORDER BY 1 LIMIT 366`,
      );
      const meetingCounts = await rows<{ date: string; count: number }>(
        tx,
        sql`
        SELECT (occurred_at AT TIME ZONE ${timezone})::date::text AS date, count(*)::int AS count FROM meetings m
        WHERE ${scope(actor.workspaceId, { from, to }, timezone)} GROUP BY 1 ORDER BY 1 LIMIT 366`,
      );
      const points = new Map<
        string,
        {
          date: string;
          open: number;
          done: number;
          overdue: number;
          backfilled: boolean;
          decisionsProposed: number;
          decisionsConfirmed: number;
          meetings: number;
        }
      >();
      if (from <= today && to >= today) {
        const live = await this.totals(tx, actor.workspaceId, timezone, today);
        const current = snapshots.find((s) => s.date === today);
        if (current)
          Object.assign(current, { open: live.open, done: live.done, overdue: live.overdue });
        else
          snapshots.push({
            date: today,
            open: live.open,
            done: live.done,
            overdue: live.overdue,
            backfilled: false,
          });
      }
      for (const s of snapshots) {
        const date = bucketDate(s.date, q.bucket);
        const old = points.get(date);
        points.set(date, {
          ...s,
          date,
          backfilled: s.backfilled || !!old?.backfilled,
          decisionsProposed: 0,
          decisionsConfirmed: 0,
          meetings: 0,
        });
      }
      // Event-only buckets are intentionally absent if no snapshot was observed; never fabricate past state.
      for (const e of events) {
        const p = points.get(bucketDate(e.date, q.bucket));
        if (p) {
          p.decisionsProposed += e.proposed;
          p.decisionsConfirmed += e.confirmed;
        }
      }
      for (const m of meetingCounts) {
        const p = points.get(bucketDate(m.date, q.bucket));
        if (p) p.meetings += m.count;
      }
      return { timezone, points: [...points.values()] };
    });
  }

  async owners(actor: WorkspaceActor, q: ProgressQuery) {
    return this.read(actor, async (tx, timezone, today) => {
      this.range(q, today);
      const owners = await rows<OwnerRow>(
        tx,
        sql`WITH a AS (${actions(actor.workspaceId, q, timezone)}), owned AS (
        SELECT a.*, coalesce(a.owner_person_id, s.person_id) AS person_id,
        coalesce(p.display_name, s.display_name, s.label, 'Unassigned') AS owner_name
        FROM a LEFT JOIN transcript_speakers s ON s.id = a.owner_speaker_id AND s.workspace_id = a.workspace_id
        LEFT JOIN people p ON p.id = coalesce(a.owner_person_id, s.person_id) AND p.workspace_id = a.workspace_id
      ) SELECT coalesce(person_id::text, owner_speaker_id::text, 'unassigned') AS key,
        min(owner_name) AS name, person_id AS "ownerPersonId",
        CASE WHEN person_id IS NULL THEN owner_speaker_id ELSE NULL END AS "ownerSpeakerId",
        count(*) FILTER (WHERE status = 'open')::int AS open, count(*) FILTER (WHERE status = 'done')::int AS done,
        count(*) FILTER (WHERE status = 'open' AND due_date < ${today}::date)::int AS overdue
        FROM owned WHERE status <> 'rejected'
        GROUP BY person_id, CASE WHEN person_id IS NULL THEN owner_speaker_id ELSE NULL END,
        coalesce(person_id::text, owner_speaker_id::text, 'unassigned') ORDER BY key LIMIT 1001`,
      );
      return { owners: owners.slice(0, 1000), truncated: owners.length > 1000 };
    });
  }

  private async meetingRows(
    tx: Transaction,
    workspaceId: string,
    q: Partial<ProgressQuery>,
    timezone: string,
    today: string,
  ) {
    const result = await rows<MeetingRow>(
      tx,
      sql`WITH selected AS (
      SELECT m.id, m.title, m.occurred_at FROM meetings m WHERE ${scope(workspaceId, q, timezone)}
      ORDER BY m.occurred_at DESC, m.id DESC LIMIT ${q.limit ?? 20}
    ), a AS (${actions(workspaceId, q, timezone)})
    SELECT m.id, m.title, to_char(m.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",
      count(a.id) FILTER (WHERE a.status = 'open')::int AS open,
      count(a.id) FILTER (WHERE a.status = 'done')::int AS done,
      count(a.id) FILTER (WHERE a.status = 'open' AND a.due_date < ${today}::date)::int AS overdue,
      count(a.id) FILTER (WHERE a.status <> 'rejected')::int AS items,
      (SELECT count(*)::int FROM decisions c JOIN meeting_documents d ON d.id = c.document_id AND d.workspace_id = c.workspace_id AND d.is_current
       WHERE d.meeting_id = m.id AND d.workspace_id = ${workspaceId} AND c.deleted_at IS NULL AND c.status <> 'rejected') AS decisions
    FROM selected m LEFT JOIN a ON a.meeting_id = m.id GROUP BY m.id, m.title, m.occurred_at ORDER BY m.occurred_at DESC, m.id DESC`,
    );
    return result.map((m) => ({ ...m, completionRate: completionRate(m.open, m.done) }));
  }

  async meetings(actor: WorkspaceActor, q: ProgressQuery) {
    return this.read(actor, async (tx, timezone, today) => {
      this.range(q, today);
      return { meetings: await this.meetingRows(tx, actor.workspaceId, q, timezone, today) };
    });
  }

  async recap(actor: WorkspaceActor, meetingId: string) {
    return this.read(actor, async (tx, timezone, today) => {
      const [recap] = await this.meetingRows(
        tx,
        actor.workspaceId,
        { meetingId, limit: 1 },
        timezone,
        today,
      );
      if (!recap) throw new NotFoundError('Meeting not found');
      const items = await rows<ItemRow>(
        tx,
        sql`WITH a AS (${actions(actor.workspaceId, { meetingId }, timezone)})
        SELECT id, title, meeting_id AS "meetingId", status, due_date::text AS "dueDate" FROM a WHERE status <> 'rejected' ORDER BY idx, id LIMIT 501`,
      );
      const carriedOver = await rows<ItemRow>(
        tx,
        sql`WITH a AS (${actions(actor.workspaceId, {}, timezone)})
        SELECT a.id, a.title, a.meeting_id AS "meetingId", a.status, a.due_date::text AS "dueDate" FROM a
        JOIN meetings earlier ON earlier.id = a.meeting_id AND earlier.workspace_id = ${actor.workspaceId}
        JOIN meetings current ON current.id = ${meetingId} AND current.workspace_id = earlier.workspace_id
        WHERE a.status = 'open' AND earlier.occurred_at < current.occurred_at AND EXISTS (
          SELECT 1 FROM meeting_participants p JOIN meeting_participants c ON c.person_id = p.person_id AND c.workspace_id = p.workspace_id
          WHERE p.workspace_id = ${actor.workspaceId} AND p.meeting_id = earlier.id AND c.meeting_id = current.id
        ) ORDER BY earlier.occurred_at DESC, a.id LIMIT 501`,
      );
      return {
        recap,
        items: items.slice(0, 500),
        carriedOver: carriedOver.slice(0, 500),
        truncated: items.length > 500 || carriedOver.length > 500,
      };
    });
  }

  /** Only the current calendar date can be upserted. Earlier observations are immutable. */
  async snapshot(workspaceId: string, now = new Date(), backfilled = false) {
    await this.db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 10))`);
        const [settings] = await tx
          .select()
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, workspaceId));
        if (!settings) return;
        const today = localDate(now, settings.timezone);
        const t = await this.totals(tx, workspaceId, settings.timezone, today);
        const values = {
          workspaceId,
          snapshotDate: today,
          openCount: t.open,
          doneCount: t.done,
          overdueCount: t.overdue,
          proposedCount: t.proposed,
          rejectedCount: t.rejected,
          decisionsProposed: t.decisionsProposed,
          decisionsConfirmed: t.decisionsConfirmed,
          meetingsCount: t.meetings,
          backfilled,
        };
        await tx
          .insert(progressSnapshots)
          .values(values)
          .onConflictDoUpdate({
            target: [progressSnapshots.workspaceId, progressSnapshots.snapshotDate],
            set: {
              ...values,
              backfilled: sql`${progressSnapshots.backfilled}`,
            },
          });
        await tx.execute(
          sql`DELETE FROM progress_refresh_requests WHERE workspace_id = ${workspaceId} AND available_at <= ${now}`,
        );
      },
      { isolationLevel: 'repeatable read' },
    );
  }

  /** Fair keyset sweep, bounded to 100 workspaces per minute, including new local dates. */
  async sweep(flags: FeatureFlagService) {
    const page = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      return rows<{ workspace_id: string; needs_refresh: boolean }>(
        tx,
        sql`SELECT s.workspace_id,
        (EXISTS (SELECT 1 FROM progress_refresh_requests r WHERE r.workspace_id = s.workspace_id AND r.available_at <= now())
        OR NOT EXISTS (SELECT 1 FROM progress_snapshots p WHERE p.workspace_id = s.workspace_id AND p.snapshot_date = (now() AT TIME ZONE s.timezone)::date)) AS needs_refresh
        FROM workspace_settings s ${this.cursor ? sql`WHERE s.workspace_id > ${this.cursor}::uuid` : sql``} ORDER BY s.workspace_id LIMIT 100`,
      );
    });
    this.cursor = page.length === 100 ? page.at(-1)!.workspace_id : undefined;
    for (const w of page)
      if (
        w.needs_refresh &&
        (await flags.isEnabled('progress.enabled', { workspaceId: w.workspace_id }))
      )
        await this.snapshot(w.workspace_id);
  }
}
