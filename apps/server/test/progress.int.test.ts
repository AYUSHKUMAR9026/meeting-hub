import {
  actionItems,
  and,
  auditLogs,
  eq,
  itemStatusEvents,
  meetingDocuments,
  meetings,
  meetingParticipants,
  people,
  progressSnapshots,
  sql,
  createDb,
  runMigrations,
  defaultMigrationsFolder,
  organization,
  workspaceSettings,
  user,
  decisions,
  domainEvents,
  progressRefreshRequests,
} from '@meeting-hub/db';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { progressQuerySchema } from '@meeting-hub/contracts';

import { localDate, shiftDate } from '../src/modules/progress/metrics';
import { progressOutboxHandler, type ProgressService } from '../src/modules/progress';
import {
  addMember,
  call,
  createTestApp,
  createUser,
  createWorkspace,
  type Session,
  type TestApp,
} from './support/harness';
import { reviewFixture } from './support/review-fixture';

let t: TestApp;
let owner: Session;
let outsider: Session;
let workspaceId: string;
let otherWorkspaceId: string;
type Summary = Awaited<ReturnType<ProgressService['summary']>>;
type Series = Awaited<ReturnType<ProgressService['timeseries']>>;
type Owners = Awaited<ReturnType<ProgressService['owners']>>;
type Recap = Awaited<ReturnType<ProgressService['recap']>>;
const query = progressQuerySchema.parse({});
beforeAll(async () => {
  t = await createTestApp({
    FEATURE_FLAGS_OVERRIDE:
      'progress.enabled=true,analysis.enabled=true,review.enabled=true,people.directory=true,workspaces.invitations=true',
  });
  owner = await createUser(t, 'progress-owner');
  outsider = await createUser(t, 'progress-outsider');
  workspaceId = (await createWorkspace(t, owner, 'Progress')).id;
  otherWorkspaceId = (await createWorkspace(t, outsider, 'Other progress')).id;
});
afterAll(() => t?.close());
const actor = () => ({ userId: owner.userId, workspaceId, role: 'owner' as const });
const get = (suffix: string, session: Session | null = owner) =>
  call(t, session, { method: 'GET', url: `/v1/workspaces/${workspaceId}/progress/${suffix}` });

describe('workspace progress', () => {
  it('backfills a legacy database with known audit times and marked unknown completion observations', async () => {
    const name = 'progress_' + randomUUID().replaceAll('-', '');
    const folder = await mkdtemp(join(tmpdir(), 'meeting-hub-progress-'));
    if (!resolve(folder).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected test migration directory');
    await t.deps.db.pool.query(`CREATE DATABASE "${name}"`);
    const url = new URL(t.deps.config.DATABASE_URL);
    url.pathname = '/' + name;
    const client = createDb({ connectionString: url.toString() });
    try {
      const journal = JSON.parse(
        await readFile(join(defaultMigrationsFolder, 'meta/_journal.json'), 'utf8'),
      ) as { entries: { tag: string }[] };
      journal.entries = journal.entries.filter((e) => Number(e.tag.slice(0, 4)) < 9);
      await mkdir(join(folder, 'meta'));
      await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
      for (const entry of journal.entries)
        await copyFile(
          join(defaultMigrationsFolder, entry.tag + '.sql'),
          join(folder, entry.tag + '.sql'),
        );
      await runMigrations(url.toString(), folder);
      await client.db
        .insert(user)
        .values({ id: owner.userId, name: 'Legacy owner', email: `legacy-${name}@example.test` });
      const [ws] = await client.db
        .insert(organization)
        .values({ name: 'Legacy', slug: name })
        .returning();
      const wid = ws!.id;
      await client.db
        .insert(workspaceSettings)
        .values({ workspaceId: wid, timezone: 'America/New_York' });
      const fixture = await reviewFixture(
        { ...t, deps: { ...t.deps, db: client } },
        wid,
        owner.userId,
      );
      await client.db
        .update(actionItems)
        .set({ status: 'done' })
        .where(eq(actionItems.id, fixture.actionId));
      await client.db
        .update(decisions)
        .set({ status: 'confirmed' })
        .where(eq(decisions.id, fixture.decisionId));
      const known = new Date('2026-11-22T16:00:00Z');
      await client.db.insert(auditLogs).values({
        workspaceId: wid,
        action: 'analysis.items_reviewed',
        targetType: 'meeting',
        targetId: fixture.meetingId,
        createdAt: known,
        metadata: { decisionIds: [fixture.decisionId], status: 'confirmed' },
      });
      const before = Date.now();
      await runMigrations(url.toString());
      await runMigrations(url.toString());
      const events = await client.db.select().from(itemStatusEvents);
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.backfilled)).toBe(true);
      expect(events.find((e) => e.itemType === 'decision')!.changedAt.toISOString()).toBe(
        known.toISOString(),
      );
      expect(
        events.find((e) => e.itemType === 'action_item')!.changedAt.getTime(),
      ).toBeGreaterThanOrEqual(before - 1000);
      const [snapshot] = await client.db.select().from(progressSnapshots);
      expect(snapshot).toMatchObject({
        backfilled: true,
        openCount: 0,
        doneCount: 1,
        decisionsConfirmed: 1,
        meetingsCount: 1,
      });
      expect(snapshot!.snapshotDate).toBe(localDate(new Date(), 'America/New_York'));
      await client.db.delete(organization).where(eq(organization.id, wid));
      expect(await client.db.select().from(progressSnapshots)).toHaveLength(0);
      expect(await client.db.select().from(itemStatusEvents)).toHaveLength(0);
    } finally {
      await client.close();
      await t.deps.db.pool.query(`DROP DATABASE "${name}"`);
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('hides progress when disabled without changing existing review routes', async () => {
    const disabled = await createTestApp({
      FEATURE_FLAGS_OVERRIDE: 'progress.enabled=false,review.enabled=true',
    });
    try {
      const response = await call(disabled, owner, {
        method: 'GET',
        url: `/v1/workspaces/${workspaceId}/progress/summary`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(
        (
          await call(disabled, owner, {
            method: 'GET',
            url: `/v1/workspaces/${workspaceId}/action-items`,
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await disabled.close();
    }
  });
  it('matches trackers, records atomic status changes, excludes old revisions and preserves past snapshots', async () => {
    const f = await reviewFixture(t, workspaceId, owner.userId);
    await t.deps.db.db.insert(actionItems).values([
      {
        workspaceId,
        documentId: f.documentId,
        transcriptId: f.transcriptId,
        idx: 1,
        title: 'Rejected',
        description: '',
        status: 'rejected',
      },
      {
        workspaceId,
        documentId: f.documentId,
        transcriptId: f.transcriptId,
        idx: 2,
        title: 'Deleted done',
        description: '',
        status: 'done',
        deletedAt: new Date(),
      },
    ]);
    const before = await get('summary');
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json<Summary>().totals).toMatchObject({
      open: 1,
      done: 0,
      decisionsProposed: 1,
      completionRate: 0,
    });
    const tracker = await call(t, owner, {
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/action-items?status=open`,
    });
    expect(tracker.json<{ items: { id: string }[] }>().items).toHaveLength(
      before.json<Summary>().totals.open,
    );
    await t.deps.progress.snapshot(workspaceId);
    await t.deps.progress.snapshot(workspaceId);
    const snapshots = await t.deps.db.db
      .select()
      .from(progressSnapshots)
      .where(eq(progressSnapshots.workspaceId, workspaceId));
    expect(snapshots).toHaveLength(1);
    const today = localDate(new Date(), 'UTC');
    await t.deps.db.db
      .insert(progressSnapshots)
      .values({ ...snapshots[0]!, id: undefined, snapshotDate: shiftDate(today, -1) });
    const response = await call(t, owner, {
      method: 'PATCH',
      url: `/v1/meetings/${f.meetingId}/action-items/${f.actionId}`,
      payload: { status: 'done' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const events = await t.deps.db.db
      .select()
      .from(itemStatusEvents)
      .where(
        and(eq(itemStatusEvents.workspaceId, workspaceId), eq(itemStatusEvents.itemId, f.actionId)),
      );
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.toStatus === 'done')).toMatchObject({
      fromStatus: 'open',
      toStatus: 'done',
      changedBy: owner.userId,
      backfilled: false,
    });
    expect((await get('summary')).json<Summary>().totals).toMatchObject({
      open: 0,
      done: 1,
      completionRate: 100,
    });
    // A transaction rollback also rolls back the database-enforced status event.
    await expect(
      t.deps.db.db.transaction(async (tx) => {
        await tx.update(actionItems).set({ status: 'open' }).where(eq(actionItems.id, f.actionId));
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(
      await t.deps.db.db
        .select()
        .from(itemStatusEvents)
        .where(eq(itemStatusEvents.itemId, f.actionId)),
    ).toHaveLength(2);
    await t.deps.db.db
      .update(meetingDocuments)
      .set({ isCurrent: false })
      .where(eq(meetingDocuments.id, f.documentId));
    await t.deps.progress.snapshot(workspaceId);
    expect((await get('summary')).json<Summary>().totals).toMatchObject({ open: 0, done: 0 });
    const history = (
      await get(`timeseries?from=${shiftDate(today, -1)}&to=${today}`)
    ).json<Series>();
    expect(history.points[0]).toMatchObject({ date: shiftDate(today, -1), open: 1, done: 0 });
    expect(history.points[1]).toMatchObject({ date: today, open: 0, done: 0 });
    await t.deps.db.db
      .update(meetingDocuments)
      .set({ isCurrent: true })
      .where(eq(meetingDocuments.id, f.documentId));
  });

  it('groups linked speakers, people and unassigned separately and carries earlier participant work', async () => {
    const f = await reviewFixture(t, workspaceId, owner.userId);
    const db = t.deps.db.db;
    const [person] = await db
      .insert(people)
      .values({ workspaceId, displayName: 'Pat' })
      .returning();
    await db
      .update(actionItems)
      .set({ ownerPersonId: person!.id })
      .where(eq(actionItems.id, f.actionId));
    await db.insert(actionItems).values({
      workspaceId,
      documentId: f.documentId,
      transcriptId: f.transcriptId,
      idx: 1,
      title: 'Unassigned',
      description: '',
    });
    const owners = (await get('owners')).json<Owners>().owners;
    expect(owners.find((o: { key: string }) => o.key === 'unassigned')).toMatchObject({
      name: 'Unassigned',
      open: 1,
    });
    expect(owners.find((o: { key: string }) => o.key === person!.id)).toMatchObject({
      name: 'Pat',
      open: 1,
    });
    const later = await reviewFixture(t, workspaceId, owner.userId);
    await db
      .update(meetings)
      .set({ occurredAt: new Date('2026-11-23T15:00:00Z') })
      .where(eq(meetings.id, later.meetingId));
    await db.insert(meetingParticipants).values([
      { workspaceId, meetingId: f.meetingId, personId: person!.id },
      { workspaceId, meetingId: later.meetingId, personId: person!.id },
    ]);
    const recap = await call(t, owner, {
      method: 'GET',
      url: `/v1/meetings/${later.meetingId}/progress`,
    });
    expect(recap.statusCode, recap.body).toBe(200);
    expect(recap.json<Recap>().carriedOver.map((i: { id: string }) => i.id)).toContain(f.actionId);
    expect((await get(`owners?ownerPersonId=${person!.id}`)).json<Owners>().owners).toHaveLength(1);
  });

  it('isolates workspaces, enforces auth, validates limits, and exports audited CSV', async () => {
    await reviewFixture(t, otherWorkspaceId, outsider.userId);
    expect((await get('summary', outsider)).statusCode).toBe(404);
    expect((await get('summary', null)).statusCode).toBe(401);
    expect((await get('timeseries?from=2025-01-01&to=2026-02-01')).statusCode).toBe(400);
    expect((await get(`timeseries?ownerPersonId=${owner.userId}`)).statusCode).toBe(400);
    const viewer = await createUser(t, 'progress-viewer');
    await addMember(t, workspaceId, owner, viewer, 'viewer');
    expect((await get('summary', viewer)).statusCode).toBe(200);
    await t.deps.progress.snapshot(workspaceId);
    const exported = await get('export');
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.body).toContain('"date","open","done","overdue"');
    expect(exported.body).not.toContain('Planning summary');
    const audits = await t.deps.db.db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.workspaceId, workspaceId), eq(auditLogs.action, 'progress.exported')),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ bucket: 'day' });
  });

  it('cascades meeting events on purge and preserves content-free historical aggregates', async () => {
    const f = await reviewFixture(t, workspaceId, owner.userId);
    await t.deps.progress.snapshot(workspaceId);
    await t.deps.db.db
      .delete(meetings)
      .where(and(eq(meetings.workspaceId, workspaceId), eq(meetings.id, f.meetingId)));
    expect(
      await t.deps.db.db
        .select()
        .from(itemStatusEvents)
        .where(eq(itemStatusEvents.meetingId, f.meetingId)),
    ).toHaveLength(0);
    expect(
      (
        await t.deps.db.db
          .select()
          .from(progressSnapshots)
          .where(eq(progressSnapshots.workspaceId, workspaceId))
      ).length,
    ).toBeGreaterThan(0);
    await t.deps.progress.snapshot(workspaceId);
    expect(
      (
        await t.deps.db.db
          .select()
          .from(progressSnapshots)
          .where(eq(progressSnapshots.workspaceId, workspaceId))
      ).length,
    ).toBeGreaterThan(0);
  });

  it('enforces same-workspace event meeting references', async () => {
    const f = await reviewFixture(t, otherWorkspaceId, outsider.userId);
    await expect(
      t.deps.db.db.insert(itemStatusEvents).values({
        workspaceId,
        meetingId: f.meetingId,
        itemId: f.actionId,
        itemType: 'action_item',
        toStatus: 'done',
      }),
    ).rejects.toThrow();
    // The maintenance marker is durable and contains identifiers only.
    const result = await t.deps.db.db.execute(
      sql`SELECT * FROM progress_refresh_requests WHERE workspace_id = ${workspaceId}`,
    );
    expect(result.rows.length).toBeLessThanOrEqual(1);
    expect((await t.deps.progress.summary(actor(), query)).totals.open).toBeGreaterThanOrEqual(0);
  });

  it('coalesces outbox notifications durably and captures bulk review in the edit transaction', async () => {
    const f = await reviewFixture(t, workspaceId, owner.userId);
    await t.deps.documents.bulkReview(actor(), f.meetingId, [f.decisionId], 'confirmed', {});
    const events = await t.deps.db.db
      .select()
      .from(itemStatusEvents)
      .where(eq(itemStatusEvents.itemId, f.decisionId));
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.toStatus === 'confirmed')).toMatchObject({
      fromStatus: 'proposed',
      changedBy: owner.userId,
    });
    const outbox = await t.deps.db.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.type, 'progress.changed'))
      .limit(1);
    expect(outbox).toHaveLength(1);
    const handler = progressOutboxHandler();
    await t.deps.db.db.transaction((tx) =>
      handler.handle({ ...outbox[0]!, payload: { workspaceId } }, tx),
    );
    const [first] = await t.deps.db.db
      .select()
      .from(progressRefreshRequests)
      .where(eq(progressRefreshRequests.workspaceId, workspaceId));
    await t.deps.db.db.transaction((tx) =>
      handler.handle({ ...outbox[0]!, payload: { workspaceId } }, tx),
    );
    const [second] = await t.deps.db.db
      .select()
      .from(progressRefreshRequests)
      .where(eq(progressRefreshRequests.workspaceId, workspaceId));
    expect(second!.availableAt.toISOString()).toBe(first!.availableAt.toISOString());
    // A notification racing a snapshot read must survive; no-op conflict updates advance the
    // marker's MVCC version and force the stale snapshot transaction to retry.
    await expect(
      t.deps.db.db.transaction(
        async (tx) => {
          await tx
            .select()
            .from(progressRefreshRequests)
            .where(eq(progressRefreshRequests.workspaceId, workspaceId));
          await t.deps.db.db.transaction((other) =>
            handler.handle({ ...outbox[0]!, payload: { workspaceId } }, other),
          );
          await tx
            .delete(progressRefreshRequests)
            .where(eq(progressRefreshRequests.workspaceId, workspaceId));
        },
        { isolationLevel: 'repeatable read' },
      ),
    ).rejects.toThrow();
    expect(
      await t.deps.db.db
        .select()
        .from(progressRefreshRequests)
        .where(eq(progressRefreshRequests.workspaceId, workspaceId)),
    ).toHaveLength(1);
    await t.deps.db.db.execute(
      sql`UPDATE progress_refresh_requests SET available_at = now() - interval '1 second' WHERE workspace_id = ${workspaceId}`,
    );
    await t.deps.progress.sweep(t.deps.flags);
    expect(
      await t.deps.db.db
        .select()
        .from(progressRefreshRequests)
        .where(eq(progressRefreshRequests.workspaceId, workspaceId)),
    ).toHaveLength(0);
    const before = await t.deps.progress.summary(actor(), query);
    await t.deps.progress.snapshot(workspaceId);
    const [snapshot] = await t.deps.db.db
      .select()
      .from(progressSnapshots)
      .where(
        and(
          eq(progressSnapshots.workspaceId, workspaceId),
          eq(progressSnapshots.snapshotDate, before.today),
        ),
      );
    expect(snapshot).toMatchObject({
      openCount: before.totals.open,
      doneCount: before.totals.done,
      decisionsConfirmed: before.totals.decisionsConfirmed,
    });
  });
});
