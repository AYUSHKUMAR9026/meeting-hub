import { createHash } from 'node:crypto';
import {
  and,
  desc,
  documentFiles,
  eq,
  isNull,
  meetingDocuments,
  meetings,
  organization,
  roomExports,
  recordings,
  processingRuns,
  sql,
  transcripts,
  workspaceSettings,
} from '@meeting-hub/db';
import type { Database } from '../../lib/db';
import { NotFoundError } from '../../lib/errors';
import { withTimeout } from '../../lib/time';
import type { Logger } from '../../lib/logger';
import { DocumentService } from '../analysis';
import type { AuditService } from '../audit';
import { authorize, type WorkspaceActor } from '../auth';
import { renderDocument } from '../exports';
import { decisionPdfKey, temporaryMeetingPrefix, type ObjectStorage } from '../media';
import { readTranscriptSource } from '../transcription';
import { purgeStoredContent } from './purge';
import { assemblePdf } from './assemble';
import { audioPurgeReason, meetingDateTime, pdfIsDue, shouldPurgeTranscript } from './policy';

/** Durable dirty markers and immutable files make worker crashes/retries repairable. */
export class ResultService {
  constructor(
    private readonly deps: {
      db: Database;
      storage: ObjectStorage;
      audit: AuditService;
      logger: Logger;
      ttlHours: number;
      maxBytes: number;
      changed?: (meetingId: string) => Promise<void>;
    },
  ) {}

  purge(actor: WorkspaceActor, input: Parameters<typeof purgeStoredContent>[3]) {
    return purgeStoredContent(this.deps.db, this.deps.storage, actor, input);
  }

  async view(actor: WorkspaceActor, meetingId: string) {
    authorize(actor, 'meeting.read');
    const meeting = await this.visible(actor.workspaceId, meetingId);
    const files = await this.deps.db
      .select({
        id: documentFiles.id,
        revisionId: documentFiles.revisionId,
        size: documentFiles.size,
        generatedAt: documentFiles.generatedAt,
        locale: documentFiles.locale,
        meetingDateTime: documentFiles.meetingDateTime,
      })
      .from(documentFiles)
      .where(
        and(
          eq(documentFiles.workspaceId, actor.workspaceId),
          eq(documentFiles.meetingId, meetingId),
        ),
      )
      .orderBy(desc(documentFiles.generatedAt), desc(documentFiles.id));
    return {
      state: meeting.pdfState,
      pending: meeting.pdfDirtyAt !== null,
      transcriptPurged: meeting.transcriptPurgedAt !== null,
      temporaryAudio: meeting.resultPolicy === 'temporary',
      files: files.map((f) => ({ ...f, generatedAt: f.generatedAt.toISOString() })),
    };
  }

  async open(actor: WorkspaceActor, meetingId: string, fileId?: string) {
    authorize(actor, 'meeting.read');
    await this.visible(actor.workspaceId, meetingId);
    const [file] = await this.deps.db
      .select()
      .from(documentFiles)
      .where(
        and(
          eq(documentFiles.workspaceId, actor.workspaceId),
          eq(documentFiles.meetingId, meetingId),
          fileId ? eq(documentFiles.id, fileId) : undefined,
        ),
      )
      .orderBy(desc(documentFiles.generatedAt), desc(documentFiles.id))
      .limit(1);
    if (!file) throw new NotFoundError('The PDF is not ready yet');
    const stream = await this.deps.storage.streamObject(file.storageKey);
    await this.deps.audit.record({
      action: 'export.downloaded',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id: meetingId },
      metadata: { format: 'pdf', fileId: file.id, stored: true },
    });
    return { file, stream };
  }

  async retry(actor: WorkspaceActor, meetingId: string) {
    authorize(actor, 'processing.reprocess');
    await this.visible(actor.workspaceId, meetingId);
    await this.deps.db
      .update(meetings)
      .set({ pdfDirtyAt: new Date(0), pdfState: 'pending' })
      .where(and(eq(meetings.workspaceId, actor.workspaceId), eq(meetings.id, meetingId)));
  }

  async sweep(now = new Date()) {
    const rows = await this.deps.db
      .select({ id: meetings.id, workspaceId: meetings.workspaceId })
      .from(meetings)
      .where(
        and(
          isNull(meetings.deletedAt),
          sql`(${meetings.pdfDirtyAt} IS NOT NULL OR (${meetings.resultPolicy} = 'temporary' AND (
          EXISTS (SELECT 1 FROM recordings r WHERE r.meeting_id = ${meetings.id} AND r.purged_at IS NULL)
          OR EXISTS (SELECT 1 FROM room_exports e WHERE e.meeting_id = ${meetings.id} AND e.workspace_id = ${meetings.workspaceId})
)))`,
        ),
      )
      .limit(500);
    let settled = 0;
    let audioPurged = 0;
    let expired = 0;
    for (const row of rows) {
      try {
        const counts = await this.settle(row.workspaceId, row.id, now);
        audioPurged += counts.audioPurged;
        expired += counts.expired;
        settled++;
      } catch {
        this.deps.logger.warn({ meetingId: row.id }, 'saved result maintenance failed; will retry');
      }
    }
    const counts = { scanned: rows.length, settled, audioPurged, expired };
    if (audioPurged || expired) this.deps.logger.info(counts, 'temporary audio sweep completed');
    return counts;
  }

  async settle(workspaceId: string, meetingId: string, now = new Date()) {
    const { db, storage, audit } = this.deps;
    const counts = { audioPurged: 0, expired: 0 };
    // Serialize purge/render with other result workers. Item/document triggers lock this meeting too.
    await db.transaction(async (tx) => {
      // Match the driver's run -> meeting lock order, including the hard-expiry path.
      await tx
        .select({ id: processingRuns.id })
        .from(processingRuns)
        .where(
          and(
            eq(processingRuns.workspaceId, workspaceId),
            eq(processingRuns.meetingId, meetingId),
            sql`${processingRuns.status} IN ('queued','preparing_media','transcribing','analyzing','indexing')`,
          ),
        )
        .for('update');
      const [meeting] = await tx
        .select()
        .from(meetings)
        .where(
          and(
            eq(meetings.workspaceId, workspaceId),
            eq(meetings.id, meetingId),
            isNull(meetings.deletedAt),
          ),
        )
        .for('update');
      if (!meeting) return;
      const [settings] = await tx
        .select()
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId));
      const scope = and(
        eq(recordings.workspaceId, workspaceId),
        eq(recordings.meetingId, meetingId),
        isNull(recordings.purgedAt),
      );
      const audio = await tx.select().from(recordings).where(scope);
      const exports = await tx
        .select()
        .from(roomExports)
        .where(and(eq(roomExports.workspaceId, workspaceId), eq(roomExports.meetingId, meetingId)));
      const [transcript] = await tx
        .select()
        .from(transcripts)
        .where(
          and(
            eq(transcripts.workspaceId, workspaceId),
            eq(transcripts.meetingId, meetingId),
            eq(transcripts.status, 'completed'),
          ),
        )
        .limit(1);
      const reason =
        meeting.resultPolicy === 'temporary' && (audio.length || exports.length)
          ? audioPurgeReason({
              createdAt: [...audio, ...exports].reduce(
                (d, r) => (r.createdAt < d ? r.createdAt : d),
                (audio[0] ?? exports[0])!.createdAt,
              ),
              now,
              ttlHours: this.deps.ttlHours,
              transcribed: Boolean(transcript) || meeting.transcriptPurgedAt !== null,
              permanentlyFailed: ['failed', 'partially_ready'].includes(meeting.status),
            })
          : null;
      if (reason) {
        counts.audioPurged = audio.length || exports.length;
        counts.expired = reason === 'expired' ? counts.audioPurged : 0;
        for (const r of audio)
          if (r.s3UploadId && r.storageKey)
            await storage.abortMultipartUpload(r.storageKey, r.s3UploadId);
        await storage.deletePrefix(temporaryMeetingPrefix(workspaceId, meetingId));
        await storage.deleteObjects(
          audio.flatMap((r) =>
            [r.storageKey, r.peaksStorageKey].filter((k): k is string => Boolean(k)),
          ),
        );
        await tx
          .update(recordings)
          .set({
            status: 'deleted',
            storageKey: '',
            peaksStorageKey: null,
            s3UploadId: null,
            purgedAt: now,
            purgeReason: reason,
          })
          .where(scope);
        await tx.execute(
          sql`DELETE FROM room_exports WHERE workspace_id = ${workspaceId} AND meeting_id = ${meetingId}`,
        );
        await tx.execute(
          sql`INSERT INTO audit_logs (workspace_id, action, target_type, target_id, metadata) VALUES (${workspaceId}, 'recording.purged', 'meeting', ${meetingId}, ${JSON.stringify({ count: audio.length, reason })}::jsonb)`,
        );
        if (reason === 'expired' && !transcript) {
          await tx.execute(
            sql`UPDATE processing_runs SET status = 'failed', error_code = 'RECORDING_EXPIRED', error_message = 'Expired before processing, please upload again.', finished_at = ${now} WHERE workspace_id = ${workspaceId} AND meeting_id = ${meetingId} AND status IN ('queued','preparing_media','transcribing','analyzing','indexing')`,
          );
          await tx.update(meetings).set({ status: 'failed' }).where(eq(meetings.id, meetingId));
        }
      }
      if (
        !meeting.pdfDirtyAt ||
        (meeting.pdfState !== 'pending' && !pdfIsDue(meeting.pdfDirtyAt, now))
      )
        return;
      const [revision] = await tx
        .select()
        .from(meetingDocuments)
        .where(
          and(
            eq(meetingDocuments.workspaceId, workspaceId),
            eq(meetingDocuments.meetingId, meetingId),
            eq(meetingDocuments.isCurrent, true),
          ),
        );
      if (!revision) return;
      try {
        await tx.transaction(async (tx) => {
          // This read sees committed document data. The meeting lock prevents its dirty marker
          // being cleared over a concurrently committed edit; that edit queues another version.
          const { document } = await new DocumentService(tx, audit).readScoped(
            workspaceId,
            meetingId,
          );
          if (!document) return;
          const [project] = await tx
            .select()
            .from(organization)
            .where(eq(organization.id, workspaceId));
          const participants = await tx.execute<{ display_name: string }>(
            sql`SELECT p.display_name FROM meeting_participants mp JOIN people p ON p.id = mp.person_id AND p.workspace_id = mp.workspace_id WHERE mp.workspace_id = ${workspaceId} AND mp.meeting_id = ${meetingId} ORDER BY p.display_name`,
          );
          const timezone = settings?.timezone ?? 'UTC';
          const appendix =
            settings?.contentRetention === 'keep_transcript' && !meeting.transcriptPurgedAt
              ? await readTranscriptSource(
                  tx,
                  {
                    workspaceId,
                    meetingId,
                    transcriptId: document.transcriptId,
                    maxBytes: this.deps.maxBytes,
                  },
                  AbortSignal.timeout(15_000),
                )
              : undefined;
          const blocks = assemblePdf({
            projectName: project!.name,
            title: meeting.title,
            date: meeting.occurredAt,
            timezone,
            durationMs: meeting.durationMs,
            participants: participants.rows.map((p) => p.display_name),
            document,
            ...(appendix ? { transcript: appendix } : {}),
          });
          if (Buffer.byteLength(JSON.stringify(blocks)) > this.deps.maxBytes)
            throw new Error('PDF too large');
          const bytes = await withTimeout(renderDocument(blocks, 'pdf'), 15_000, 'decision PDF');
          if (bytes.length > this.deps.maxBytes) throw new Error('PDF too large');
          const generatedAt = new Date();
          const [identity] = await tx
            .execute<{ id: string }>(sql`SELECT uuidv7() AS id`)
            .then((r) => r.rows);
          const key = decisionPdfKey(workspaceId, meetingId, identity!.id);
          const signal = AbortSignal.timeout(15_000);
          await storage.uploadBuffer(key, bytes, { contentType: 'application/pdf', signal });
          // GET and hash, rather than HEAD alone: never destroy a transcript before verifying bytes.
          const body = await storage.streamObject(key, signal);
          const hash = createHash('sha256');
          for await (const chunk of body) hash.update(chunk as Buffer);
          if (hash.digest('hex') !== createHash('sha256').update(bytes).digest('hex'))
            throw new Error('PDF verification failed');
          await tx.insert(documentFiles).values({
            id: identity!.id,
            workspaceId,
            meetingId,
            revisionId: document.id,
            storageKey: key,
            size: bytes.length,
            generatedAt,
            meetingDateTime: meetingDateTime(meeting.occurredAt, timezone),
          });
          await tx
            .update(meetings)
            .set({ pdfState: 'ready', pdfDirtyAt: null, status: 'ready' })
            .where(eq(meetings.id, meetingId));
          if (
            shouldPurgeTranscript({
              resultPolicy: meeting.resultPolicy,
              contentRetention: settings?.contentRetention ?? 'pdf_only',
              pdfVerified: true,
            })
          ) {
            await tx.execute(
              sql`UPDATE evidence e SET citation_start_ms = s.start_ms, citation_idx = s.idx, citation_speaker = coalesce(sp.display_name, sp.label), segment_id = NULL FROM transcript_segments s JOIN transcript_speakers sp ON sp.id = s.speaker_id WHERE e.segment_id = s.id AND e.workspace_id = ${workspaceId} AND e.document_id IN (SELECT id FROM meeting_documents WHERE workspace_id = ${workspaceId} AND meeting_id = ${meetingId})`,
            );
            const removed = await tx.execute(
              sql`DELETE FROM transcript_segments WHERE workspace_id = ${workspaceId} AND transcript_id IN (SELECT id FROM transcripts WHERE workspace_id = ${workspaceId} AND meeting_id = ${meetingId})`,
            );
            await tx.execute(
              sql`UPDATE action_items a SET owner_reference_id = sp.id, owner_person_id = coalesce(a.owner_person_id, sp.person_id), owner_label = coalesce(sp.display_name, sp.label) FROM transcript_speakers sp WHERE a.owner_speaker_id = sp.id AND a.workspace_id = ${workspaceId} AND sp.transcript_id IN (SELECT id FROM transcripts WHERE workspace_id = ${workspaceId} AND meeting_id = ${meetingId})`,
            );
            await tx.execute(
              sql`DELETE FROM transcripts WHERE workspace_id = ${workspaceId} AND meeting_id = ${meetingId}`,
            );
            await tx.execute(
              sql`DELETE FROM transcription_checkpoints WHERE workspace_id = ${workspaceId} AND meeting_id = ${meetingId}`,
            );
            await tx.execute(
              sql`UPDATE meeting_documents SET checkpoints = '[]'::jsonb WHERE workspace_id = ${workspaceId} AND meeting_id = ${meetingId}`,
            );
            await tx
              .update(meetings)
              .set({ transcriptPurgedAt: now })
              .where(eq(meetings.id, meetingId));
            await tx.execute(
              sql`INSERT INTO audit_logs (workspace_id, action, target_type, target_id, metadata) VALUES (${workspaceId}, 'transcript.purged', 'meeting', ${meetingId}, ${JSON.stringify({ count: removed.rowCount ?? 0 })}::jsonb)`,
            );
          }
        });
      } catch {
        // Never include renderer/SQL errors: they may contain private document content.
        await tx
          .update(meetings)
          .set({ pdfState: 'failed', pdfDirtyAt: now, status: 'partially_ready' })
          .where(eq(meetings.id, meetingId));
      }
    });
    await this.deps.changed?.(meetingId);
    return counts;
  }

  private async visible(workspaceId: string, meetingId: string) {
    const [meeting] = await this.deps.db
      .select()
      .from(meetings)
      .where(
        and(
          eq(meetings.workspaceId, workspaceId),
          eq(meetings.id, meetingId),
          isNull(meetings.deletedAt),
        ),
      );
    if (!meeting) throw new NotFoundError('Meeting not found');
    return meeting;
  }
}
