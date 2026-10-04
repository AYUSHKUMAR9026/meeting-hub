/**
 * AUTO-GENERATED authorization matrix: every registered /v1 route × every kind of caller.
 *
 * Cases are generated from the app's route catalog, not written by hand. For each route the table
 * below says what kind of access it needs (and how to build a valid request); the expected status
 * per caller then comes from the permission matrix:
 *
 *   signed-out → 401 · non-member → 404 · role allowed → success · role not allowed → 403
 *
 * Every workspace-scoped route is also called by members of workspace A against workspace B's
 * resources, which must always be 404. A /v1 route missing from ROUTES fails this test.
 */
import { randomUUID } from 'node:crypto';

import { invitation, meetings, member, people, recordings, user } from '@meeting-hub/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RouteAccess } from '../src/http/access';
import { type Action, roleCan, type WorkspaceRole, workspaceRoles } from '../src/modules/auth';
import {
  addMember,
  call,
  createTestApp,
  createUser,
  createWorkspace,
  type Session,
  type TestApp,
  uniqueEmail,
  WEB_ORIGIN,
} from './support/harness';

type Caller = WorkspaceRole | 'non-member' | 'signed-out';
const CALLERS: Caller[] = [...workspaceRoles, 'non-member', 'signed-out'];

interface Workspace {
  id: string;
  owner: Session;
}

/** What a case needs to build its request: the target workspace and who is calling. */
interface CaseContext {
  ws: Workspace;
  caller: Session | null;
}

interface CaseRequest {
  url: string;
  payload?: Record<string, unknown>;
  headers?: Record<string, string>;
}

interface RouteSpec {
  /** Must match the route's own `config.access` (checked below), so the two can't drift. */
  access: 'public' | 'authenticated' | Action;
  success: number;
  request: (ctx: CaseContext) => CaseRequest | Promise<CaseRequest>;
  /** A response that never ends (SSE): call over a real socket and stop after the status. */
  streaming?: boolean;
}

let wsA: Workspace;
let wsB: Workspace;
let host: Workspace; // a third workspace used to send invitations to the callers
let baseUrl: string; // the app on a real socket, for streaming routes
const sessions = {} as Record<WorkspaceRole | 'non-member', Session>;

// --- fixtures written straight to the database (fast, and independent of the routes under test) --

async function insertUser(): Promise<string> {
  const [row] = await t.deps.db.db
    .insert(user)
    .values({ name: 'Target', email: uniqueEmail('target'), emailVerified: true })
    .returning({ id: user.id });
  return row!.id;
}

async function insertMember(workspaceId: string, role: WorkspaceRole = 'viewer'): Promise<string> {
  const userId = await insertUser();
  await t.deps.db.db.insert(member).values({ organizationId: workspaceId, userId, role });
  return userId;
}

async function insertInvitation(ws: Workspace, email = uniqueEmail('invitee')): Promise<string> {
  const [row] = await t.deps.db.db
    .insert(invitation)
    .values({
      organizationId: ws.id,
      email,
      role: 'viewer',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
      inviterId: ws.owner.userId,
    })
    .returning({ id: invitation.id });
  return row!.id;
}

async function insertPerson(workspaceId: string): Promise<string> {
  const [row] = await t.deps.db.db
    .insert(people)
    .values({ workspaceId, displayName: `Person ${randomUUID().slice(0, 6)}` })
    .returning({ id: people.id });
  return row!.id;
}

/**
 * A meeting in `ws`, created by the caller when there is one (members may only modify their own
 * meetings, and the matrix expects role-allowed callers to succeed).
 */
async function insertMeeting({ ws, caller }: CaseContext): Promise<string> {
  const [row] = await t.deps.db.db
    .insert(meetings)
    .values({
      workspaceId: ws.id,
      title: 'Matrix meeting',
      occurredAt: new Date(),
      createdBy: caller?.userId ?? ws.owner.userId,
    })
    .returning({ id: meetings.id });
  return row!.id;
}

/** A real multipart upload in progress (in Garage) for a fresh meeting of the caller. */
async function insertUpload(ctx: CaseContext, sizeBytes = 16) {
  const meetingId = await insertMeeting(ctx);
  const session = await t.deps.uploads.start(
    { userId: ctx.ws.owner.userId, workspaceId: ctx.ws.id, role: 'owner' },
    meetingId,
    { fileName: 'matrix.wav', contentType: 'audio/wav', sizeBytes },
    `matrix-${randomUUID()}`,
    {},
  );
  return { meetingId, session };
}

/** An upload whose single part is already in storage, ready to complete. */
async function insertUploadedPart(ctx: CaseContext) {
  const { meetingId, session } = await insertUpload(ctx);
  const res = await fetch(session.parts[0]!.url, { method: 'PUT', body: Buffer.alloc(16, 1) });
  return { meetingId, uploadId: session.uploadId, etag: res.headers.get('etag')! };
}

/** A meeting with a completed recording upload. */
async function insertRecordedMeeting(ctx: CaseContext): Promise<string> {
  const { meetingId, uploadId, etag } = await insertUploadedPart(ctx);
  await t.deps.uploads.complete(
    { userId: ctx.ws.owner.userId, workspaceId: ctx.ws.id, role: 'owner' },
    meetingId,
    uploadId,
    [{ partNumber: 1, etag }],
    {},
  );
  return meetingId;
}

/** A meeting with processed (normalized) audio, written straight to the database. */
async function insertProcessedMeeting(ctx: CaseContext): Promise<string> {
  const meetingId = await insertMeeting(ctx);
  await t.deps.db.db.insert(recordings).values({
    meetingId,
    workspaceId: ctx.ws.id,
    kind: 'normalized',
    storageKey: `ws/${ctx.ws.id}/meetings/${meetingId}/normalized/${randomUUID()}`,
    peaksStorageKey: `ws/${ctx.ws.id}/meetings/${meetingId}/peaks/${randomUUID()}`,
    originalFilename: 'm.m4a',
    contentType: 'audio/mp4',
    sizeBytes: 16,
    durationMs: 1_000,
    status: 'uploaded',
  });
  return meetingId;
}

/** An invitation to `host` addressed to the caller (or to nobody in particular when signed out). */
const invitationForCaller = ({ caller }: CaseContext) =>
  insertInvitation(host, caller?.email ?? uniqueEmail('anyone'));

// --- the route table ------------------------------------------------------------------------------

const ROUTES: Record<string, RouteSpec> = {
  'GET /v1/system/flags': {
    access: 'public',
    success: 200,
    request: () => ({ url: '/v1/system/flags' }),
  },
  'GET /v1/auth/providers': {
    access: 'public',
    success: 200,
    request: () => ({ url: '/v1/auth/providers' }),
  },
  'GET /v1/me': { access: 'authenticated', success: 200, request: () => ({ url: '/v1/me' }) },
  'GET /v1/workspaces': {
    access: 'authenticated',
    success: 200,
    request: () => ({ url: '/v1/workspaces' }),
  },
  'POST /v1/workspaces': {
    access: 'authenticated',
    success: 201,
    request: () => ({ url: '/v1/workspaces', payload: { name: 'Matrix Created' } }),
  },
  'GET /v1/workspaces/:wid': {
    access: 'workspace.read',
    success: 200,
    request: ({ ws }) => ({ url: `/v1/workspaces/${ws.id}` }),
  },
  'PATCH /v1/workspaces/:wid': {
    access: 'workspace.update',
    success: 200,
    request: ({ ws }) => ({
      url: `/v1/workspaces/${ws.id}`,
      payload: { settings: { retentionDays: 45 } },
    }),
  },
  'GET /v1/workspaces/:wid/members': {
    access: 'member.read',
    success: 200,
    request: ({ ws }) => ({ url: `/v1/workspaces/${ws.id}/members` }),
  },
  'PATCH /v1/workspaces/:wid/members/:userId': {
    access: 'member.update',
    success: 200,
    request: async ({ ws }) => ({
      url: `/v1/workspaces/${ws.id}/members/${await insertMember(ws.id)}`,
      payload: { role: 'member' },
    }),
  },
  'DELETE /v1/workspaces/:wid/members/:userId': {
    access: 'member.remove',
    success: 204,
    request: async ({ ws }) => ({
      url: `/v1/workspaces/${ws.id}/members/${await insertMember(ws.id)}`,
    }),
  },
  'POST /v1/workspaces/:wid/invitations': {
    access: 'invitation.create',
    success: 201,
    request: ({ ws }) => ({
      url: `/v1/workspaces/${ws.id}/invitations`,
      payload: { email: uniqueEmail('matrix-invite'), role: 'viewer' },
    }),
  },
  'GET /v1/workspaces/:wid/invitations': {
    access: 'invitation.read',
    success: 200,
    request: ({ ws }) => ({ url: `/v1/workspaces/${ws.id}/invitations` }),
  },
  'DELETE /v1/workspaces/:wid/invitations/:id': {
    access: 'invitation.cancel',
    success: 204,
    request: async ({ ws }) => ({
      url: `/v1/workspaces/${ws.id}/invitations/${await insertInvitation(ws)}`,
    }),
  },
  'GET /v1/invitations/:id': {
    access: 'authenticated',
    success: 200,
    request: async (ctx) => ({ url: `/v1/invitations/${await invitationForCaller(ctx)}` }),
  },
  'POST /v1/invitations/:id/accept': {
    access: 'authenticated',
    success: 200,
    request: async (ctx) => ({ url: `/v1/invitations/${await invitationForCaller(ctx)}/accept` }),
  },
  'GET /v1/workspaces/:wid/people': {
    access: 'people.read',
    success: 200,
    request: ({ ws }) => ({ url: `/v1/workspaces/${ws.id}/people` }),
  },
  'POST /v1/workspaces/:wid/people': {
    access: 'people.create',
    success: 201,
    request: ({ ws }) => ({
      url: `/v1/workspaces/${ws.id}/people`,
      payload: { displayName: 'Matrix Person' },
    }),
  },
  'PATCH /v1/people/:id': {
    access: 'people.update',
    success: 200,
    request: async ({ ws }) => ({
      url: `/v1/people/${await insertPerson(ws.id)}`,
      payload: { aliases: ['matrix'] },
    }),
  },
  'DELETE /v1/people/:id': {
    access: 'people.delete',
    success: 204,
    request: async ({ ws }) => ({ url: `/v1/people/${await insertPerson(ws.id)}` }),
  },
  'GET /v1/workspaces/:wid/audit-logs': {
    access: 'audit.read',
    success: 200,
    request: ({ ws }) => ({ url: `/v1/workspaces/${ws.id}/audit-logs` }),
  },
  'POST /v1/workspaces/:wid/meetings': {
    access: 'meeting.create',
    success: 201,
    request: ({ ws }) => ({
      url: `/v1/workspaces/${ws.id}/meetings`,
      payload: { title: 'Matrix', occurredAt: '2026-10-01T09:00:00Z' },
    }),
  },
  'GET /v1/workspaces/:wid/meetings': {
    access: 'meeting.read',
    success: 200,
    request: ({ ws }) => ({ url: `/v1/workspaces/${ws.id}/meetings` }),
  },
  'GET /v1/meetings/:id': {
    access: 'meeting.read',
    success: 200,
    request: async (ctx) => ({ url: `/v1/meetings/${await insertMeeting(ctx)}` }),
  },
  'PATCH /v1/meetings/:id': {
    access: 'meeting.update',
    success: 200,
    request: async (ctx) => ({
      url: `/v1/meetings/${await insertMeeting(ctx)}`,
      payload: { title: 'Matrix renamed' },
    }),
  },
  'DELETE /v1/meetings/:id': {
    access: 'meeting.delete',
    success: 202,
    request: async (ctx) => ({ url: `/v1/meetings/${await insertMeeting(ctx)}` }),
  },
  'POST /v1/meetings/:id/uploads': {
    access: 'recording.upload',
    success: 201,
    request: async (ctx) => ({
      url: `/v1/meetings/${await insertMeeting(ctx)}/uploads`,
      headers: { 'idempotency-key': `matrix-${randomUUID()}` },
      payload: {
        fileName: 'm.wav',
        contentType: 'audio/wav',
        sizeBytes: 16,
        consentConfirmed: true,
      },
    }),
  },
  'POST /v1/meetings/:id/uploads/:uploadId/parts': {
    access: 'recording.upload',
    success: 200,
    request: async (ctx) => {
      const { meetingId, session } = await insertUpload(ctx);
      return {
        url: `/v1/meetings/${meetingId}/uploads/${session.uploadId}/parts`,
        payload: { partNumbers: [1] },
      };
    },
  },
  'POST /v1/meetings/:id/uploads/:uploadId/complete': {
    access: 'recording.upload',
    success: 202,
    request: async (ctx) => {
      const { meetingId, uploadId, etag } = await insertUploadedPart(ctx);
      return {
        url: `/v1/meetings/${meetingId}/uploads/${uploadId}/complete`,
        payload: { parts: [{ partNumber: 1, etag }] },
      };
    },
  },
  'DELETE /v1/meetings/:id/uploads/:uploadId': {
    access: 'recording.upload',
    success: 204,
    request: async (ctx) => {
      const { meetingId, session } = await insertUpload(ctx);
      return { url: `/v1/meetings/${meetingId}/uploads/${session.uploadId}` };
    },
  },
  'GET /v1/meetings/:id/recording': {
    access: 'recording.download',
    success: 200,
    request: async (ctx) => ({ url: `/v1/meetings/${await insertRecordedMeeting(ctx)}/recording` }),
  },
  'GET /v1/meetings/:id/processing': {
    access: 'meeting.read',
    success: 200,
    request: async (ctx) => ({ url: `/v1/meetings/${await insertMeeting(ctx)}/processing` }),
  },
  'GET /v1/meetings/:id/events': {
    access: 'meeting.read',
    success: 200,
    streaming: true,
    request: async (ctx) => ({ url: `/v1/meetings/${await insertMeeting(ctx)}/events` }),
  },
  'POST /v1/meetings/:id/runs': {
    access: 'processing.reprocess',
    success: 202,
    request: async (ctx) => ({
      url: `/v1/meetings/${await insertRecordedMeeting(ctx)}/runs`,
      payload: {},
    }),
  },
  'GET /v1/meetings/:id/media': {
    access: 'meeting.read',
    success: 200,
    request: async (ctx) => ({ url: `/v1/meetings/${await insertProcessedMeeting(ctx)}/media` }),
  },
};

/**
 * Sends a case's request. Streaming routes go over a real socket: the status line is all the
 * matrix needs, then the stream is closed.
 */
async function send(
  spec: RouteSpec,
  method: string,
  session: Session | null,
  { url, payload, headers }: CaseRequest,
): Promise<{ statusCode: number; body: string }> {
  if (!spec.streaming) {
    const res = await call(t, session, {
      method: method as 'GET',
      url,
      ...(payload ? { payload } : {}),
      ...(headers ? { headers } : {}),
    });
    return { statusCode: res.statusCode, body: res.body };
  }
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    signal: controller.signal,
    headers: { origin: WEB_ORIGIN, ...(session ? { cookie: session.cookie } : {}), ...headers },
  });
  const body = res.ok ? '' : await res.text();
  controller.abort();
  return { statusCode: res.status, body };
}

function expectedStatus(spec: RouteSpec, caller: Caller): number {
  if (spec.access === 'public') return spec.success;
  if (caller === 'signed-out') return 401;
  if (spec.access === 'authenticated') return spec.success;
  if (caller === 'non-member') return 404;
  return roleCan(caller, spec.access) ? spec.success : 403;
}

const declaredKind = (access: RouteAccess | undefined) =>
  access?.kind === 'workspace' ? access.action : access?.kind;

// The catalog is only known once the app is built, so build it before collecting tests.
const t: TestApp = await createTestApp();
const catalog = t.app.routeCatalog.filter((r) => r.url.startsWith('/v1/'));

beforeAll(async () => {
  baseUrl = await t.app.listen({ host: '127.0.0.1', port: 0 });
  const owner = await createUser(t, 'matrix-owner');
  wsA = { id: (await createWorkspace(t, owner, 'Matrix A')).id, owner };
  sessions.owner = owner;
  for (const role of ['admin', 'member', 'viewer'] as const) {
    sessions[role] = await createUser(t, `matrix-${role}`);
    await addMember(t, wsA.id, owner, sessions[role], role);
  }
  // The non-member owns workspace B: they are signed in and have a workspace, just not A.
  sessions['non-member'] = await createUser(t, 'matrix-outsider');
  wsB = {
    id: (await createWorkspace(t, sessions['non-member'], 'Matrix B')).id,
    owner: sessions['non-member'],
  };
  const hostOwner = await createUser(t, 'matrix-host');
  host = { id: (await createWorkspace(t, hostOwner, 'Matrix Host')).id, owner: hostOwner };
});

afterAll(() => t?.close());

describe('authorization matrix', () => {
  it('covers every /v1 route (add new routes to ROUTES)', () => {
    const registered = catalog.map((r) => `${r.method} ${r.url}`).sort();
    expect(registered).toEqual(Object.keys(ROUTES).sort());
  });

  it.each(catalog.map((r) => [`${r.method} ${r.url}`, r.access] as const))(
    '%s declares the access its matrix entry expects',
    (key, access) => {
      expect(ROUTES[key], `${key} has no entry in ROUTES`).toBeDefined();
      expect(declaredKind(access)).toBe(ROUTES[key]!.access);
    },
  );

  const cases = catalog.flatMap(({ method, url }) =>
    CALLERS.map((caller) => [`${method} ${url}`, caller, method] as const),
  );

  it.each(cases)('%s as %s', async (key, caller, method) => {
    const spec = ROUTES[key];
    expect(spec, `${key} has no entry in ROUTES`).toBeDefined();
    const session = caller === 'signed-out' ? null : sessions[caller];
    const req = await spec!.request({ ws: wsA, caller: session });
    const res = await send(spec!, method, session, req);
    expect(res.statusCode, res.body).toBe(expectedStatus(spec!, caller));
  });

  const workspaceRoutes = catalog.filter((r) => r.access?.kind === 'workspace');
  const crossCases = workspaceRoutes.flatMap(({ method, url }) =>
    workspaceRoles.map((role) => [`${method} ${url}`, role, method] as const),
  );

  it.each(crossCases)("%s as workspace A's %s, on workspace B → 404", async (key, role, method) => {
    const session = sessions[role];
    const req = await ROUTES[key]!.request({ ws: wsB, caller: session });
    const res = await send(ROUTES[key]!, method, session, req);
    expect(res.statusCode, res.body).toBe(404);
  });
});
