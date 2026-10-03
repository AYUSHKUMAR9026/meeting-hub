import { randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, name: string): void {
  // Keys are built from ids we generated; anything else is a bug, never user input to escape.
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID to build a storage key`);
}

/** Everything a meeting owns in storage lives under this prefix (deletion sweeps it). */
export function meetingPrefix(workspaceId: string, meetingId: string): string {
  assertUuid(workspaceId, 'workspaceId');
  assertUuid(meetingId, 'meetingId');
  return `ws/${workspaceId}/meetings/${meetingId}/`;
}

/**
 * `ws/{workspaceId}/meetings/{meetingId}/original/{randomUuid}`. Never contains file names or other
 * user input; the original file name is kept in the database only (ADR 0003).
 */
export function originalRecordingKey(workspaceId: string, meetingId: string): string {
  return `${meetingPrefix(workspaceId, meetingId)}original/${randomUUID()}`;
}
