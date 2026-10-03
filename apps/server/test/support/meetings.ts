/** Helpers for meeting and upload tests: create meetings, and upload parts like a browser would. */
import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { call, type Session, type TestApp, WEB_ORIGIN } from './harness';

export const MiB = 1024 * 1024;

export interface MeetingBody {
  id: string;
  title: string;
  status: string;
  createdBy: string | null;
  occurredAt: string;
  participants: { id: string; displayName: string }[];
  recording: { id: string; status: string; fileName: string; sizeBytes: number } | null;
}

export interface UploadSessionBody {
  uploadId: string;
  meetingId: string;
  partSize: number;
  partCount: number;
  urlsExpireAt: string;
  parts: { partNumber: number; url: string }[];
}

export async function createMeeting(
  t: TestApp,
  session: Session,
  workspaceId: string,
  body: Record<string, unknown> = {},
): Promise<MeetingBody> {
  const res = await call(t, session, {
    method: 'POST',
    url: `/v1/workspaces/${workspaceId}/meetings`,
    payload: { title: 'Weekly sync', occurredAt: '2026-10-01T09:00:00Z', ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<MeetingBody>();
}

export function startUpload(
  t: TestApp,
  session: Session,
  meetingId: string,
  body: Record<string, unknown>,
  idempotencyKey: string | null = `key-${randomUUID()}`,
) {
  return call(t, session, {
    method: 'POST',
    url: `/v1/meetings/${meetingId}/uploads`,
    payload: { fileName: 'sync.wav', contentType: 'audio/wav', consentConfirmed: true, ...body },
    ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
  });
}

/** Deterministic test bytes. */
export const bytes = (size: number, seed = 1) => {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4096) buf[i] = (i / 4096 + seed) % 256;
  return buf;
};

/** PUTs each part straight to storage with the browser's Origin, returning the ETags. */
export async function putParts(
  urls: { partNumber: number; url: string }[],
  data: Buffer,
  partSize: number,
): Promise<{ partNumber: number; etag: string }[]> {
  return Promise.all(
    urls.map(async ({ partNumber, url }) => {
      const chunk = data.subarray((partNumber - 1) * partSize, partNumber * partSize);
      const res = await fetch(url, { method: 'PUT', body: chunk, headers: { origin: WEB_ORIGIN } });
      expect(res.status, await res.clone().text()).toBe(200);
      // What a browser needs: CORS for our origin, and the ETag readable by script.
      expect(res.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
      expect(res.headers.get('access-control-expose-headers')?.toLowerCase()).toContain('etag');
      const etag = res.headers.get('etag');
      expect(etag).toBeTruthy();
      return { partNumber, etag: etag! };
    }),
  );
}

export function complete(
  t: TestApp,
  session: Session,
  meetingId: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
) {
  return call(t, session, {
    method: 'POST',
    url: `/v1/meetings/${meetingId}/uploads/${uploadId}/complete`,
    payload: { parts },
  });
}

/** Start → PUT every part → complete; returns the started session and the completion response. */
export async function uploadRecording(
  t: TestApp,
  session: Session,
  meetingId: string,
  data: Buffer,
  body: Record<string, unknown> = {},
) {
  const started = await startUpload(t, session, meetingId, { sizeBytes: data.length, ...body });
  expect(started.statusCode, started.body).toBe(201);
  const upload = started.json<UploadSessionBody>();
  const etags = await putParts(upload.parts, data, upload.partSize);
  const done = await complete(t, session, meetingId, upload.uploadId, etags);
  expect(done.statusCode, done.body).toBe(202);
  return { upload, etags };
}
