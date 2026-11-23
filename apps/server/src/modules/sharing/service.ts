import type { PublicShare, ShareLink } from '@meeting-hub/contracts';
import {
  and,
  desc,
  eq,
  gt,
  isNull,
  meetings,
  shareLinks,
  sql,
  workspaceSettings,
} from '@meeting-hub/db';

import type { Database } from '../../lib/db';
import { ForbiddenError, NotFoundError } from '../../lib/errors';
import type { DocumentService } from '../analysis';
import type { AuditService, RequestOrigin } from '../audit';
import { assertCanModifyMeeting, type WorkspaceActor } from '../auth';
import type { FeatureFlagService } from '../platform';
import { readTranscriptSource } from '../transcription';
import { createShareToken, hashShareToken, isShareToken, publicText, shareExpiry } from './token';

const missing = () => new NotFoundError('Share link not found');

function linkView(row: typeof shareLinks.$inferSelect): ShareLink {
  return {
    id: row.id,
    scope: row.scope,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    lastAccessedAt: row.lastAccessedAt?.toISOString() ?? null,
    accessCount: row.accessCount,
  };
}

export class ShareService {
  constructor(
    private readonly deps: {
      db: Database;
      documents: DocumentService;
      flags: FeatureFlagService;
      audit: AuditService;
      publicWebUrl: string;
      maxDays: number;
      maxBytes: number;
    },
  ) {}

  async create(
    actor: WorkspaceActor,
    meetingId: string,
    input: { scope: ShareLink['scope']; expiresInDays: number },
    origin: RequestOrigin,
  ) {
    const { db, audit, documents, maxDays, publicWebUrl } = this.deps;
    const meeting = await this.authorizedMeeting(actor, meetingId);
    if (!meeting.sharingEnabled)
      throw new ForbiddenError('Public sharing is disabled in this workspace.', {
        code: 'SHARING_DISABLED',
      });
    if (!(await documents.readScoped(actor.workspaceId, meetingId)).document)
      throw new NotFoundError('Meeting document not found');
    const now = new Date();
    const token = createShareToken();
    const [row] = await db
      .insert(shareLinks)
      .values({
        workspaceId: actor.workspaceId,
        meetingId,
        createdBy: actor.userId,
        createdAt: now,
        tokenHash: hashShareToken(token),
        scope: input.scope,
        expiresAt: shareExpiry(now, input.expiresInDays, maxDays),
      })
      .returning();
    await audit.record({
      action: 'share.created',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id: meetingId },
      metadata: { shareId: row!.id, scope: input.scope, expiresAt: row!.expiresAt.toISOString() },
      origin,
    });
    return { ...linkView(row!), url: new URL('/share/' + token, publicWebUrl).href };
  }

  async list(actor: WorkspaceActor, meetingId: string) {
    await this.authorizedMeeting(actor, meetingId);
    const links = await this.deps.db
      .select()
      .from(shareLinks)
      .where(
        and(eq(shareLinks.workspaceId, actor.workspaceId), eq(shareLinks.meetingId, meetingId)),
      )
      .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id));
    return { links: links.map(linkView) };
  }

  async revoke(actor: WorkspaceActor, meetingId: string, shareId: string, origin: RequestOrigin) {
    await this.authorizedMeeting(actor, meetingId);
    const db = this.deps.db;
    const scope = and(
      eq(shareLinks.id, shareId),
      eq(shareLinks.workspaceId, actor.workspaceId),
      eq(shareLinks.meetingId, meetingId),
    );
    const [row] = await db
      .update(shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(scope, isNull(shareLinks.revokedAt)))
      .returning({ id: shareLinks.id });
    if (!row) {
      const [existing] = await db.select({ id: shareLinks.id }).from(shareLinks).where(scope);
      if (!existing) throw missing();
      return;
    }
    await this.deps.audit.record({
      action: 'share.revoked',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id: meetingId },
      metadata: { shareId },
      origin,
    });
  }

  async view(token: string): Promise<PublicShare> {
    if (!isShareToken(token)) throw missing();
    const { db, flags, documents, audit, maxBytes } = this.deps;
    const tokenHash = hashShareToken(token);
    const [row] = await db
      .select({
        id: shareLinks.id,
        workspaceId: shareLinks.workspaceId,
        meetingId: shareLinks.meetingId,
        scope: shareLinks.scope,
        title: meetings.title,
        occurredAt: meetings.occurredAt,
        sharingEnabled: workspaceSettings.sharingEnabled,
      })
      .from(shareLinks)
      .innerJoin(
        meetings,
        and(
          eq(meetings.id, shareLinks.meetingId),
          eq(meetings.workspaceId, shareLinks.workspaceId),
        ),
      )
      .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, shareLinks.workspaceId))
      .where(
        and(
          eq(shareLinks.tokenHash, tokenHash),
          isNull(shareLinks.revokedAt),
          gt(shareLinks.expiresAt, new Date()),
          isNull(meetings.deletedAt),
        ),
      );
    if (
      !row ||
      row.sharingEnabled === false ||
      !(await flags.isEnabled('sharing.enabled', { workspaceId: row.workspaceId }))
    )
      throw missing();
    const { workspaceId, meetingId, id: shareId } = row;
    const { document } = await documents.readScoped(workspaceId, meetingId);
    if (!document) throw missing();
    const transcript =
      row.scope === 'document_and_transcript'
        ? await readTranscriptSource(
            db,
            { workspaceId, meetingId, transcriptId: document.transcriptId, maxBytes },
            AbortSignal.timeout(10_000),
          )
        : null;
    const [counted] = await db
      .update(shareLinks)
      .set({
        lastAccessedAt: new Date(),
        accessCount: sql`least(${shareLinks.accessCount}::bigint + 1, 2147483647)`,
      })
      .where(
        and(
          eq(shareLinks.id, shareId),
          eq(shareLinks.workspaceId, workspaceId),
          isNull(shareLinks.revokedAt),
          gt(shareLinks.expiresAt, new Date()),
          sql`exists (select 1 from ${meetings} where ${meetings.id} = ${meetingId} and ${meetings.workspaceId} = ${workspaceId} and ${meetings.deletedAt} is null)`,
          sql`not exists (select 1 from ${workspaceSettings} where ${workspaceSettings.workspaceId} = ${workspaceId} and not ${workspaceSettings.sharingEnabled})`,
        ),
      )
      .returning({ id: shareLinks.id });
    if (!counted) throw missing();
    await audit.record({
      action: 'share.accessed',
      workspaceId,
      target: { type: 'meeting', id: meetingId },
      metadata: { shareId },
    });
    return {
      title: publicText(row.title),
      occurredAt: row.occurredAt.toISOString(),
      summary: {
        paragraph: publicText(document.summary.paragraph),
        bullets: document.summary.bullets.map(publicText),
      },
      decisions: document.decisions.flatMap((item) =>
        item.status === 'rejected'
          ? []
          : [
              {
                title: publicText(item.title),
                description: publicText(item.description),
                rationale: item.rationale ? publicText(item.rationale) : null,
                status: item.status,
                timestampsMs: item.citations.map(({ startMs }) => startMs),
              },
            ],
      ),
      actionItems: document.actionItems.flatMap((item) =>
        item.status === 'rejected'
          ? []
          : [
              {
                title: publicText(item.title),
                description: publicText(item.description),
                owner: item.ownerName ? publicText(item.ownerName) : null,
                dueDate: item.dueDate,
                status: item.status,
                timestampsMs: item.citations.map(({ startMs }) => startMs),
              },
            ],
      ),
      transcript:
        transcript?.map(({ startMs, endMs, label, text }) => ({
          startMs,
          endMs,
          speaker: publicText(label),
          text: publicText(text),
        })) ?? null,
    };
  }

  private async authorizedMeeting(actor: WorkspaceActor, meetingId: string) {
    const [meeting] = await this.deps.db
      .select({
        createdBy: meetings.createdBy,
        sharingEnabled: workspaceSettings.sharingEnabled,
      })
      .from(meetings)
      .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, meetings.workspaceId))
      .where(
        and(
          eq(meetings.id, meetingId),
          eq(meetings.workspaceId, actor.workspaceId),
          isNull(meetings.deletedAt),
        ),
      );
    if (!meeting) throw new NotFoundError('Meeting not found');
    assertCanModifyMeeting(actor, 'meeting.update', meeting);
    return { sharingEnabled: meeting.sharingEnabled ?? true };
  }
}
