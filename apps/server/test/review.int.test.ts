import { randomUUID } from 'node:crypto';

import {
  actionItems,
  and,
  auditLogs,
  decisions,
  eq,
  shareLinks,
  transcriptSegments,
} from '@meeting-hub/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMeetingMaintenance } from '../src/modules/meetings';
import { hashShareToken } from '../src/modules/sharing/token';
import { docxXml, pdfText } from './support/export-readers';
import {
  addMember,
  call,
  createTestApp,
  createUser,
  createWorkspace,
  type Session,
  type TestApp,
} from './support/harness';
import { linkReviewOwner, reviewFixture } from './support/review-fixture';

const enabled =
  'workspaces.invitations=true,people.directory=true,meetings.upload=true,transcription.enabled=true,analysis.enabled=true,exports.enabled=true,sharing.enabled=true,review.enabled=true';
let t: TestApp;
let owner: Session;
let workspaceId: string;
let outsider: Session;
let otherWorkspaceId: string;

beforeAll(async () => {
  t = await createTestApp({
    FEATURE_FLAGS_OVERRIDE: enabled,
    SHARE_MAX_DAYS: '5',
    EXPORT_MAX_BYTES: '64000',
    PUBLIC_WEB_URL: 'https://meetings.example.test',
  });
  owner = await createUser(t, 'review-owner');
  outsider = await createUser(t, 'review-outsider');
  workspaceId = (await createWorkspace(t, owner, 'Document review')).id;
  otherWorkspaceId = (await createWorkspace(t, outsider, 'Other workspace')).id;
});

afterAll(() => t?.close());

const meetingUrl = (meetingId: string) => '/v1/meetings/' + meetingId;
const sharePath = (url: string) => '/v1/public/shares/' + url.split('/').at(-1);
const get = (url: string, session: Session | null = owner) =>
  call(t, session, { method: 'GET', url });

async function share(
  meetingId: string,
  scope: 'document' | 'document_and_transcript' = 'document',
  session = owner,
) {
  const response = await call(t, session, {
    method: 'POST',
    url: meetingUrl(meetingId) + '/share-links',
    payload: { scope, expiresInDays: 1 },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string; url: string }>();
}

describe('Phase 7 exports, sharing and tracker', () => {
  it('opens every export format, applies transcript scope, and writes format-only audits', async () => {
    const fixture = await reviewFixture(t, workspaceId, owner.userId);
    const path = meetingUrl(fixture.meetingId);
    const db = t.deps.db.db;
    const { documentId, transcriptId } = fixture;
    await db.insert(decisions).values([
      {
        workspaceId,
        documentId,
        transcriptId,
        idx: 1,
        title: 'Rejected secret',
        description: 'Hidden',
        status: 'rejected',
      },
      {
        workspaceId,
        documentId,
        transcriptId,
        idx: 2,
        title: 'Deleted secret',
        description: 'Hidden',
        deletedAt: new Date(),
      },
    ]);
    for (const format of ['md', 'docx', 'pdf'] as const) {
      const response = await get(path + '/export?format=' + format + '&include=transcript');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="meeting-roadmap-review-cafe.' + format + '"',
      );
      expect(response.headers['cache-control']).toBe('private, no-store');
      const content =
        format === 'md'
          ? response.body
          : format === 'docx'
            ? docxXml(response.rawPayload)
            : await pdfText(response.rawPayload);
      for (const piece of [
        'Date:',
        'Participants:',
        'Summary',
        'Planning summary',
        'Decisions',
        'Unconfirmed',
        'Action items',
        '2026-11-24',
        'Evidence:',
        '00:00:01',
        'Transcript',
        'Private cue',
      ]) {
        expect(content, format).toContain(piece);
      }
      expect(content).not.toMatch(/Rejected secret|Deleted secret/);
    }
    expect((await get(path + '/export?format=md')).body).not.toContain('Private cue');
    const txt = await get(path + '/transcript/export?format=txt');
    expect(txt.statusCode, txt.body).toBe(200);
    expect(txt.body).toContain('[00:00:01] Alex & Co.: Private cue');
    const srt = await get(path + '/transcript/export?format=srt');
    expect(srt.statusCode, srt.body).toBe(200);
    expect(srt.body).toContain('00:00:01,234 --> 00:00:05,000');
    expect(srt.body).toContain('&lt;i&gt;');
    expect((await get(path + '/export?format=md', outsider)).statusCode).toBe(404);
    const audits = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.targetId, fixture.meetingId), eq(auditLogs.action, 'export.downloaded')),
      );
    expect(audits.map(({ metadata }) => metadata.format).sort()).toEqual([
      'docx',
      'md',
      'md',
      'pdf',
      'srt',
      'txt',
    ]);
    expect(audits.every((event) => event.actorUserId === owner.userId)).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('Private cue');
    await db
      .update(transcriptSegments)
      .set({ text: 'a'.repeat(70_000) })
      .where(eq(transcriptSegments.id, fixture.segmentId));
    expect((await get(path + '/transcript/export?format=txt')).statusCode).toBe(413);
    expect((await get(path + '/export?format=md')).statusCode).toBe(200);
  });

  it('hashes tokens, enforces scope, settings, expiry and revocation, and purges links', async () => {
    const { meetingId } = await reviewFixture(t, workspaceId, owner.userId);
    const path = meetingUrl(meetingId) + '/share-links';
    const document = await share(meetingId);
    const full = await share(meetingId, 'document_and_transcript');
    const expiry = await share(meetingId);
    const token = document.url.split('/').at(-1)!;
    expect(document.url).toMatch(/^https:\/\/meetings\.example\.test\/share\/[A-Za-z0-9_-]{43}$/);
    const db = t.deps.db.db;
    const [stored] = await db.select().from(shareLinks).where(eq(shareLinks.id, document.id));
    expect(stored?.tokenHash).toBe(hashShareToken(token));

    const view = await get(sharePath(document.url), null);
    expect(view.statusCode, view.body).toBe(200);
    expect(view.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.headers['referrer-policy']).toBe('no-referrer');
    expect(view.json()).toMatchObject({ transcript: null, decisions: [{ timestampsMs: [1234] }] });
    expect(view.body).not.toMatch(
      /Private cue|notes@example\.test|workspaceId|transcriptId|segmentId|recording|audio/,
    );
    const transcript = await get(sharePath(full.url), null);
    expect(transcript.statusCode, transcript.body).toBe(200);
    expect(transcript.json()).toMatchObject({
      transcript: [{ speaker: 'Speaker A', text: 'Private cue <i> & [email removed]' }],
    });
    expect(transcript.body).not.toMatch(/cue@example\.test|notes@example\.test/);

    const list = await get(path);
    const accessed = list
      .json<{ links: { id: string; accessCount: number; lastAccessedAt: string | null }[] }>()
      .links.find(({ id }) => id === document.id);
    expect(accessed?.accessCount).toBe(1);
    expect(accessed?.lastAccessedAt).toBeTruthy();
    expect(list.body).not.toContain(token);
    expect((await get(path, outsider)).statusCode).toBe(404);
    const overLimit = await call(t, owner, {
      method: 'POST',
      url: path,
      payload: { scope: 'document', expiresInDays: 6 },
    });
    expect(overLimit.statusCode).toBe(400);

    await db
      .update(shareLinks)
      .set({
        createdAt: new Date('2026-01-01T00:00:00Z'),
        expiresAt: new Date('2026-01-02T00:00:00Z'),
      })
      .where(eq(shareLinks.id, expiry.id));
    const revoked = await call(t, owner, { method: 'DELETE', url: path + '/' + document.id });
    expect(revoked.statusCode).toBe(204);
    const problems: Record<string, unknown>[] = [];
    for (const url of [
      '/v1/public/shares/invalid',
      '/v1/public/shares/' + 'b'.repeat(43),
      sharePath(expiry.url),
      sharePath(document.url),
    ]) {
      const miss = await get(url, null);
      expect(miss.statusCode).toBe(404);
      expect(miss.headers['cache-control']).toBe('no-store');
      const { requestId, ...problem } = miss.json<
        { requestId: string } & Record<string, unknown>
      >();
      expect(requestId).toBeTruthy();
      problems.push(problem);
    }
    expect(
      problems.every((problem) => JSON.stringify(problem) === JSON.stringify(problems[0])),
    ).toBe(true);

    const toggle = (sharingEnabled: boolean) =>
      call(t, owner, {
        method: 'PATCH',
        url: '/v1/workspaces/' + workspaceId,
        payload: { settings: { sharingEnabled } },
      });
    expect((await toggle(false)).statusCode).toBe(200);
    expect((await get(sharePath(full.url), null)).statusCode).toBe(404);
    expect(
      (
        await call(t, owner, {
          method: 'POST',
          url: path,
          payload: { scope: 'document', expiresInDays: 1 },
        })
      ).statusCode,
    ).toBe(403);
    expect((await toggle(true)).statusCode).toBe(200);
    expect((await get(sharePath(full.url), null)).statusCode).toBe(200);

    const deleted = await call(t, owner, { method: 'DELETE', url: meetingUrl(meetingId) });
    expect(deleted.statusCode, deleted.body).toBe(202);
    expect((await get(sharePath(full.url), null)).statusCode).toBe(404);
    const maintenance = createMeetingMaintenance({
      db,
      storage: t.deps.storage,
      audit: t.deps.audit,
      logger: t.deps.logger,
      runs: t.deps.processing.runs,
      staleAfterHours: 24,
    });
    expect(await maintenance.purgeMeeting(meetingId, owner.userId)).toMatchObject({ purged: true });
    expect(await db.select().from(shareLinks).where(eq(shareLinks.meetingId, meetingId))).toEqual(
      [],
    );
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.targetId, meetingId));
    expect(audits.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        'share.created',
        'share.accessed',
        'share.revoked',
        'meeting.purged',
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(t.logLines)).not.toMatch(
      /Private cue|Planning summary|notes@example\.test/,
    );
    expect(JSON.stringify(t.logLines)).not.toContain(token);
  });

  it('limits members to sharing meetings they created', async () => {
    const member = await createUser(t, 'share-member');
    await addMember(t, workspaceId, owner, member, 'member');
    const other = await reviewFixture(t, workspaceId, owner.userId);
    const own = await reviewFixture(t, workspaceId, member.userId);
    expect((await get(meetingUrl(other.meetingId) + '/share-links', member)).statusCode).toBe(403);
    expect((await get(meetingUrl(own.meetingId) + '/share-links', member)).statusCode).toBe(200);
    expect(await share(own.meetingId, 'document', member)).toHaveProperty('url');
  });

  it('filters current workspace items, paginates, and applies bulk review atomically', async () => {
    const fixture = await reviewFixture(t, workspaceId, owner.userId);
    const foreign = await reviewFixture(t, otherWorkspaceId, outsider.userId);
    const db = t.deps.db.db;
    const personId = await linkReviewOwner(t, fixture, owner.userId);
    await db
      .update(actionItems)
      .set({ ownerPersonId: personId })
      .where(eq(actionItems.id, fixture.actionId));
    const { meetingId, transcriptId, documentId } = fixture;
    await db.insert(decisions).values({
      workspaceId,
      transcriptId,
      documentId,
      idx: 1,
      title: 'Choose 100X coverage',
      description: 'Comparison',
    });
    const tracker = '/v1/workspaces/' + workspaceId;
    const first = await get(
      tracker +
        '/decisions?meetingId=' +
        meetingId +
        '&sort=title&limit=1&q=' +
        encodeURIComponent('100%'),
    );
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      items: [
        { id: fixture.decisionId, citation: { segmentId: fixture.segmentId, startMs: 1234 } },
      ],
      nextCursor: null,
    });
    expect(
      (await get(tracker + '/decisions?meetingId=' + meetingId + '&limit=1')).json(),
    ).toMatchObject({ nextCursor: 1 });
    expect(
      (await get(tracker + '/decisions?meetingId=' + meetingId + '&limit=1&cursor=1')).json(),
    ).toMatchObject({ nextCursor: null });
    expect((await get(tracker + '/decisions?meetingId=' + foreign.meetingId)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await get('/v1/workspaces/' + otherWorkspaceId + '/decisions')).statusCode).toBe(404);
    const actions = await get(
      tracker +
        '/action-items?mine=true&status=open&dueFrom=2026-11-24&dueTo=2026-11-24&ownerPersonId=' +
        personId,
    );
    expect(actions.statusCode, actions.body).toBe(200);
    expect(actions.json()).toMatchObject({
      items: [{ id: fixture.actionId, dueDate: '2026-11-24', ownerPersonId: personId }],
      nextCursor: null,
    });
    expect((await get(tracker + '/action-items?mine=true&dueFrom=2026-11-25')).json()).toEqual({
      items: [],
      nextCursor: null,
    });

    const bulk = (ids: string[]) =>
      call(t, owner, {
        method: 'POST',
        url: meetingUrl(meetingId) + '/decisions/bulk-review',
        payload: { ids, status: 'confirmed' },
      });
    expect((await bulk([fixture.decisionId, randomUUID()])).statusCode).toBe(409);
    expect(
      (await get(tracker + '/decisions?status=confirmed&meetingId=' + meetingId)).json(),
    ).toEqual({ items: [], nextCursor: null });
    expect((await bulk([fixture.decisionId])).statusCode).toBe(204);
    expect(
      (await get(tracker + '/decisions?status=confirmed&meetingId=' + meetingId)).json(),
    ).toMatchObject({ items: [{ id: fixture.decisionId, status: 'confirmed' }] });
    const [updated] = await db.select().from(decisions).where(eq(decisions.id, fixture.decisionId));
    expect(updated?.editedByUser).toBe(true);
    const query = 'private-tracker-filter';
    await get(tracker + '/decisions?q=' + query);
    expect(JSON.stringify(t.logLines)).not.toContain(query);
  });

  it('leaves the Phase 6 routes available with Phase 7 flags off', async () => {
    const disabled = await createTestApp({ FEATURE_FLAGS_OVERRIDE: 'analysis.enabled=true' });
    try {
      const fixture = await reviewFixture(t, workspaceId, owner.userId);
      const link = await share(fixture.meetingId);
      for (const [url, status, session] of [
        [meetingUrl(fixture.meetingId) + '/document', 200, owner],
        [meetingUrl(fixture.meetingId) + '/export?format=md', 404, owner],
        [meetingUrl(fixture.meetingId) + '/share-links', 404, owner],
        ['/v1/workspaces/' + workspaceId + '/decisions', 404, owner],
        [sharePath(link.url), 404, null],
      ] as const) {
        expect((await call(disabled, session, { method: 'GET', url })).statusCode).toBe(status);
      }
    } finally {
      await disabled.close();
    }
  });

  it('rate-limits anonymous token lookups', async () => {
    const limited = await createTestApp({ RATE_LIMIT_ENABLED: 'true' });
    try {
      for (let i = 0; i < 30; i++) {
        expect(
          (
            await limited.app.inject({
              method: 'GET',
              url: '/v1/public/shares/invalid',
              remoteAddress: '198.51.100.47',
            })
          ).statusCode,
        ).toBe(404);
      }
      const limitedResponse = await limited.app.inject({
        method: 'GET',
        url: '/v1/public/shares/invalid',
        remoteAddress: '198.51.100.47',
      });
      expect(limitedResponse.statusCode).toBe(429);
      expect(limitedResponse.headers['cache-control']).toBe('no-store');
    } finally {
      await limited.close();
    }
  });
});
