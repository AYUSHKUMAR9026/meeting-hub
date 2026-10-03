import { auditLogs, eq } from '@meeting-hub/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  addMember,
  call,
  createTestApp,
  createUser,
  createWorkspace,
  type Session,
  type TestApp,
} from './support/harness';
import { createMeeting, type MeetingBody, startUpload } from './support/meetings';

let t: TestApp;
let owner: Session;
let member: Session;
let otherMember: Session;
let viewer: Session;
let ws: string;
let otherWs: string;
let otherOwner: Session;

/** Adds a person to a workspace's directory and returns their id. */
async function addPerson(session: Session, workspaceId: string, displayName: string) {
  const res = await call(t, session, {
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/people`,
    payload: { displayName },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

beforeAll(async () => {
  t = await createTestApp();
  owner = await createUser(t, 'meetings-owner');
  ws = (await createWorkspace(t, owner, 'Meetings')).id;
  member = await createUser(t, 'meetings-member');
  otherMember = await createUser(t, 'meetings-member2');
  viewer = await createUser(t, 'meetings-viewer');
  await addMember(t, ws, owner, member, 'member');
  await addMember(t, ws, owner, otherMember, 'member');
  await addMember(t, ws, owner, viewer, 'viewer');
  otherOwner = await createUser(t, 'meetings-other');
  otherWs = (await createWorkspace(t, otherOwner, 'Other meetings')).id;
});

afterAll(() => t?.close());

describe('meetings', () => {
  it('creates a meeting with participants from the people directory', async () => {
    const ada = await addPerson(owner, ws, 'Ada Lovelace');
    const alan = await addPerson(owner, ws, 'Alan Turing');
    const meeting = await createMeeting(t, member, ws, {
      title: '  Planning  ',
      occurredAt: '2026-10-02T14:30:00+02:00',
      participantIds: [alan, ada],
    });
    expect(meeting).toMatchObject({
      title: 'Planning',
      occurredAt: '2026-10-02T12:30:00.000Z',
      status: 'awaiting_upload',
      createdBy: member.userId,
      recording: null,
    });
    expect(meeting.participants.map((p) => p.displayName)).toEqual(['Ada Lovelace', 'Alan Turing']);

    const audit = await t.deps.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetId, meeting.id));
    expect(audit.map((a) => a.action)).toEqual(['meeting.created']);
  });

  it('rejects participants from another workspace with problem+json', async () => {
    const stranger = await addPerson(otherOwner, otherWs, 'Stranger');
    const res = await call(t, owner, {
      method: 'POST',
      url: `/v1/workspaces/${ws}/meetings`,
      payload: { title: 'x', occurredAt: '2026-10-01T09:00:00Z', participantIds: [stranger] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'UNKNOWN_PARTICIPANTS' });
  });

  it('validates the request body', async () => {
    const res = await call(t, owner, {
      method: 'POST',
      url: `/v1/workspaces/${ws}/meetings`,
      payload: { title: '', occurredAt: 'not a date' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('lists newest first with cursor pagination and filters', async () => {
    const own = await createWorkspace(t, owner, 'Paging');
    for (const day of ['01', '02', '03', '04', '05']) {
      await createMeeting(t, owner, own.id, {
        title: `Day ${day}`,
        occurredAt: `2026-09-${day}T10:00:00Z`,
      });
    }
    const page = async (query: string) => {
      const res = await call(t, owner, {
        method: 'GET',
        url: `/v1/workspaces/${own.id}/meetings?${query}`,
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json<{ meetings: MeetingBody[]; nextCursor: string | null }>();
    };

    const first = await page('limit=2');
    expect(first.meetings.map((m) => m.title)).toEqual(['Day 05', 'Day 04']);
    const second = await page(`limit=2&cursor=${first.nextCursor}`);
    expect(second.meetings.map((m) => m.title)).toEqual(['Day 03', 'Day 02']);
    const last = await page(`limit=2&cursor=${second.nextCursor}`);
    expect(last.meetings.map((m) => m.title)).toEqual(['Day 01']);
    expect(last.nextCursor).toBeNull();

    const ranged = await page('from=2026-09-02T00:00:00Z&to=2026-09-04T00:00:00Z');
    expect(ranged.meetings.map((m) => m.title)).toEqual(['Day 03', 'Day 02']);
    expect((await page('status=uploaded')).meetings).toEqual([]);
    expect((await page('status=awaiting_upload')).meetings).toHaveLength(5);
  });

  it('lets members edit their own meetings but not other members’ (403, not 404)', async () => {
    const mine = await createMeeting(t, member, ws, { title: 'Mine' });
    const edit = (session: Session, id: string, payload: Record<string, unknown>) =>
      call(t, session, { method: 'PATCH', url: `/v1/meetings/${id}`, payload });

    const ok = await edit(member, mine.id, { title: 'Renamed', participantIds: [] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ title: 'Renamed' });

    const denied = await edit(otherMember, mine.id, { title: 'Hijacked' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'NOT_MEETING_CREATOR' });

    // ...and they can't upload to it either.
    const upload = await startUpload(t, otherMember, mine.id, { sizeBytes: 100 });
    expect(upload.statusCode).toBe(403);
    expect(upload.json()).toMatchObject({ code: 'NOT_MEETING_CREATOR' });

    const asAdmin = await edit(owner, mine.id, { occurredAt: '2026-10-05T08:00:00Z' });
    expect(asAdmin.statusCode, asAdmin.body).toBe(200);
  });

  it('lets viewers read but not create, edit or upload', async () => {
    const meeting = await createMeeting(t, owner, ws);
    expect(
      (await call(t, viewer, { method: 'GET', url: `/v1/meetings/${meeting.id}` })).statusCode,
    ).toBe(200);
    const create = await call(t, viewer, {
      method: 'POST',
      url: `/v1/workspaces/${ws}/meetings`,
      payload: { title: 'x', occurredAt: '2026-10-01T09:00:00Z' },
    });
    expect(create.statusCode).toBe(403);
    expect((await startUpload(t, viewer, meeting.id, { sizeBytes: 100 })).statusCode).toBe(403);
  });

  it('returns 404 for meetings in other workspaces and unknown ids', async () => {
    const theirs = await createMeeting(t, otherOwner, otherWs);
    for (const url of [
      `/v1/meetings/${theirs.id}`,
      '/v1/meetings/0199a1b2-0000-7000-8000-00000000abcd',
    ]) {
      const res = await call(t, owner, { method: 'GET', url });
      expect(res.statusCode).toBe(404);
    }
  });

  it('lists meetings.upload in the workspace features when the flag is on', async () => {
    const res = await call(t, viewer, { method: 'GET', url: `/v1/workspaces/${ws}` });
    expect(res.json<{ features: string[] }>().features).toContain('meetings.upload');
  });
});

describe('meetings with the meetings.upload flag off', () => {
  let off: TestApp;
  let user: Session;
  let wsId: string;

  beforeAll(async () => {
    off = await createTestApp({
      FEATURE_FLAGS_OVERRIDE:
        'workspaces.invitations=true,people.directory=true,meetings.upload=false',
    });
    user = await createUser(off, 'flag-off');
    wsId = (await createWorkspace(off, user, 'Flag off')).id;
  });

  afterAll(() => off?.close());

  it('still creates and reads meetings, hides the feature, and 404s the upload endpoints', async () => {
    const meeting = await createMeeting(off, user, wsId);
    const ws = await call(off, user, { method: 'GET', url: `/v1/workspaces/${wsId}` });
    expect(ws.json<{ features: string[] }>().features).not.toContain('meetings.upload');

    const upload = await startUpload(off, user, meeting.id, { sizeBytes: 100 });
    expect(upload.statusCode).toBe(404);
    const parts = await call(off, user, {
      method: 'POST',
      url: `/v1/meetings/${meeting.id}/uploads/${meeting.id}/parts`,
      payload: { partNumbers: [1] },
    });
    expect(parts.statusCode).toBe(404);
  });
});
