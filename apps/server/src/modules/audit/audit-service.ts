import { and, auditLogs, desc, eq, lt, or } from '@meeting-hub/db';

import type { Database } from '../../lib/db';
import type { Logger } from '../../lib/logger';

/** Every audit action we write. Stable strings: they are stored and shown to admins. */
export const auditActions = [
  'auth.sign_in',
  'auth.sign_out',
  'auth.sign_in_failed',
  'workspace.created',
  'workspace.updated',
  'member.invited',
  'member.joined',
  'member.removed',
  'member.role_changed',
  'invitation.revoked',
  'person.created',
  'person.updated',
  'person.deleted',
  'meeting.created',
  'meeting.updated',
  'meeting.deleted',
  'meeting.purged',
  'upload.started',
  'upload.completed',
  'upload.aborted',
  'upload.failed',
  'recording.downloaded',
  'processing.run_started',
  'processing.run_completed',
  'processing.run_failed',
  'processing.run_cancelled',
  'processing.reprocess_requested',
] as const;
export type AuditAction = (typeof auditActions)[number];

/** Where a request came from; attached to every audit entry when known. */
export interface RequestOrigin {
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  action: AuditAction;
  workspaceId?: string | null;
  actorUserId?: string | null;
  target?: { type: string; id: string };
  metadata?: Record<string, unknown>;
  origin?: RequestOrigin;
}

export interface AuditLogItem {
  id: string;
  action: string;
  actorUserId: string | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditPage {
  items: AuditLogItem[];
  nextCursor: string | null;
}

/** Keys that must never be persisted, whatever a caller passes in. */
const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie/i;

export function scrubMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, value]) => [
        key,
        value && typeof value === 'object' && !Array.isArray(value)
          ? scrubMetadata(value as Record<string, unknown>)
          : value,
      ]),
  );
}

const encodeCursor = (row: { createdAt: Date; id: string }) =>
  Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(iso ?? '');
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}

/**
 * Writes and reads the append-only audit log. Writing never throws: a failed audit write is logged
 * at error level instead of failing the user's request (Better Auth writes can't share our
 * transaction anyway, see ADR 0002).
 */
export class AuditService {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.db.insert(auditLogs).values({
        action: entry.action,
        workspaceId: entry.workspaceId ?? null,
        actorUserId: entry.actorUserId ?? null,
        targetType: entry.target?.type ?? null,
        targetId: entry.target?.id ?? null,
        ip: entry.origin?.ip ?? null,
        userAgent: entry.origin?.userAgent?.slice(0, 512) ?? null,
        metadata: scrubMetadata(entry.metadata ?? {}),
      });
    } catch (err) {
      this.logger.error({ err, action: entry.action }, 'audit write failed');
    }
  }

  /** Newest first, keyset-paginated on (created_at, id). Always scoped to one workspace. */
  async list(
    workspaceId: string,
    options: { cursor?: string | undefined; limit: number },
  ): Promise<AuditPage> {
    const after = options.cursor ? decodeCursor(options.cursor) : null;
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.workspaceId, workspaceId),
          after
            ? or(
                lt(auditLogs.createdAt, after.createdAt),
                and(eq(auditLogs.createdAt, after.createdAt), lt(auditLogs.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(options.limit + 1);

    const items = rows.slice(0, options.limit);
    const last = items.at(-1);
    return {
      items: items.map(({ workspaceId: _ws, ...item }) => item),
      nextCursor: rows.length > options.limit && last ? encodeCursor(last) : null,
    };
  }
}
