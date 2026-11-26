import { and, eq, isNull, recordings, sql } from '@meeting-hub/db';
import type { Database } from '../../lib/db';
import { ConflictError } from '../../lib/errors';
import { authorize, type WorkspaceActor } from '../auth';
import type { ObjectStorage } from '../media';

export async function purgeStoredContent(
  db: Database,
  storage: ObjectStorage,
  actor: WorkspaceActor,
  input: {
    kind: 'recordings' | 'transcripts';
    dryRun: boolean;
    confirmation?: string | undefined;
    expectedCount?: number | undefined;
    expectedBytes?: number | undefined;
  },
) {
  authorize(actor, 'workspace.purge_content');
  const workspaceId = actor.workspaceId;
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspaceId}, 1))`);
      const audio =
        input.kind === 'recordings'
          ? await tx
              .select()
              .from(recordings)
              .where(and(eq(recordings.workspaceId, workspaceId), isNull(recordings.purgedAt)))
          : [];
      const segments =
        input.kind === 'transcripts'
          ? await tx.execute<{ count: number; bytes: number }>(
              sql`SELECT count(DISTINCT transcript_id)::int AS count, coalesce(sum(octet_length(text)),0)::float8 AS bytes FROM transcript_segments WHERE workspace_id = ${workspaceId}`,
            )
          : null;
      const count = segments?.rows[0]?.count ?? audio.length;
      const bytes = segments?.rows[0]?.bytes ?? audio.reduce((n, r) => n + r.sizeBytes, 0);
      if (input.dryRun) return { count, bytes, purged: false };
      if (
        input.confirmation !== `PURGE ${input.kind.toUpperCase()}` ||
        input.expectedCount !== count ||
        input.expectedBytes !== bytes
      )
        throw new ConflictError(
          'PURGE_CONFIRMATION_REQUIRED',
          'Run the preview again and type the exact confirmation. The stored content may have changed.',
        );
      const active = await tx.execute(
        sql`SELECT 1 FROM processing_runs WHERE workspace_id = ${workspaceId} AND status IN ('queued','preparing_media','transcribing','analyzing','indexing') LIMIT 1`,
      );
      const live = await tx.execute(
        sql`SELECT 1 FROM meetings WHERE workspace_id = ${workspaceId} AND room_status = 'live' LIMIT 1`,
      );
      if (active.rowCount || live.rowCount)
        throw new ConflictError(
          'CONTENT_IN_USE',
          'Wait for live meetings and processing to finish before purging stored content.',
        );
      if (input.kind === 'recordings') {
        for (const r of audio)
          if (r.s3UploadId && r.storageKey)
            await storage.abortMultipartUpload(r.storageKey, r.s3UploadId);
        const exports = await tx.execute<{ storage_key: string }>(
          sql`SELECT storage_key FROM room_exports WHERE workspace_id = ${workspaceId}`,
        );
        await storage.deleteObjects([
          ...audio.flatMap((r) =>
            [r.storageKey, r.peaksStorageKey].filter((k): k is string => Boolean(k)),
          ),
          ...exports.rows.flatMap((r) => [r.storage_key, r.storage_key + '.ogg']),
        ]);
        await tx
          .update(recordings)
          .set({
            storageKey: '',
            peaksStorageKey: null,
            s3UploadId: null,
            status: 'deleted',
            purgedAt: new Date(),
            purgeReason: 'owner_requested',
          })
          .where(and(eq(recordings.workspaceId, workspaceId), isNull(recordings.purgedAt)));
        await tx.execute(sql`DELETE FROM room_exports WHERE workspace_id = ${workspaceId}`);
      } else {
        await tx.execute(
          sql`UPDATE meetings SET transcript_purged_at = now() WHERE workspace_id = ${workspaceId} AND id IN (SELECT meeting_id FROM transcripts WHERE workspace_id = ${workspaceId})`,
        );
        await tx.execute(
          sql`UPDATE evidence e SET citation_start_ms = s.start_ms, citation_idx = s.idx, citation_speaker = coalesce(sp.display_name, sp.label), segment_id = NULL FROM transcript_segments s JOIN transcript_speakers sp ON sp.id = s.speaker_id WHERE e.segment_id = s.id AND e.workspace_id = ${workspaceId}`,
        );
        await tx.execute(sql`DELETE FROM transcript_segments WHERE workspace_id = ${workspaceId}`);
        await tx.execute(
          sql`UPDATE action_items a SET owner_reference_id = sp.id, owner_person_id = coalesce(a.owner_person_id, sp.person_id), owner_label = coalesce(sp.display_name, sp.label) FROM transcript_speakers sp WHERE a.owner_speaker_id = sp.id AND a.workspace_id = ${workspaceId}`,
        );
        await tx.execute(sql`DELETE FROM transcripts WHERE workspace_id = ${workspaceId}`);
        await tx.execute(
          sql`DELETE FROM transcription_checkpoints WHERE workspace_id = ${workspaceId}`,
        );
        await tx.execute(
          sql`UPDATE meeting_documents SET checkpoints = '[]'::jsonb WHERE workspace_id = ${workspaceId}`,
        );
      }
      await tx.execute(
        sql`INSERT INTO audit_logs (workspace_id, actor_user_id, action, metadata) VALUES (${workspaceId}, ${actor.userId}, ${input.kind === 'recordings' ? 'recording.purged' : 'transcript.purged'}, ${JSON.stringify({ count, bytes, reason: 'owner_requested' })}::jsonb)`,
      );
      return { count, bytes, purged: true };
    },
    { isolationLevel: 'repeatable read' },
  );
}
