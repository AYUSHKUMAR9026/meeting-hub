import type { TestApp } from './harness';

/** Explicit v8 columns: migration tests must not insert with a future Drizzle schema. */
export async function legacyReviewFixture(t: TestApp, workspaceId: string, creatorId: string) {
  const pool = t.deps.db.pool;
  const insert = async (query: string, values: unknown[]) =>
    (await pool.query<{ id: string }>(query + ' RETURNING id', values)).rows[0]!.id;
  const meetingId = await insert(
    "INSERT INTO meetings (workspace_id, created_by, title, occurred_at, status) VALUES ($1,$2,'Legacy review','2026-11-22T15:00:00Z','ready')",
    [workspaceId, creatorId],
  );
  const recordingId = await insert(
    "INSERT INTO recordings (workspace_id, meeting_id, kind, storage_key, original_filename, content_type, size_bytes, status) VALUES ($1,$2,'original',$3,'input.wav','audio/wav',16,'uploaded')",
    [workspaceId, meetingId, meetingId],
  );
  const runId = await insert(
    "INSERT INTO processing_runs (workspace_id, meeting_id, recording_id, trigger, pipeline_version, status) VALUES ($1,$2,$3,'upload',3,'completed')",
    [workspaceId, meetingId, recordingId],
  );
  const transcriptId = await insert(
    "INSERT INTO transcripts (workspace_id, meeting_id, processing_run_id, provider, provider_job_id, duration_ms, status, is_current) VALUES ($1,$2,$3,'fake',$4,5000,'completed',true)",
    [workspaceId, meetingId, runId, runId],
  );
  const speakerId = await insert(
    "INSERT INTO transcript_speakers (workspace_id, transcript_id, label) VALUES ($1,$2,'Speaker')",
    [workspaceId, transcriptId],
  );
  const segmentId = await insert(
    "INSERT INTO transcript_segments (workspace_id, transcript_id, speaker_id, idx, start_ms, end_ms, text) VALUES ($1,$2,$3,0,0,5000,'Legacy cue')",
    [workspaceId, transcriptId, speakerId],
  );
  const documentId = await insert(
    "INSERT INTO meeting_documents (workspace_id, meeting_id, transcript_id, processing_run_id, status, is_current, summary, model, prompt_version) VALUES ($1,$2,$3,$4,'completed',true,'{\"paragraph\":\"Legacy summary\",\"bullets\":[]}'::jsonb,'fake','v1')",
    [workspaceId, meetingId, transcriptId, runId],
  );
  const decisionId = await insert(
    "INSERT INTO decisions (workspace_id, document_id, transcript_id, idx, title, description) VALUES ($1,$2,$3,0,'Legacy decision','Proceed')",
    [workspaceId, documentId, transcriptId],
  );
  const actionId = await insert(
    "INSERT INTO action_items (workspace_id, document_id, transcript_id, idx, title, description) VALUES ($1,$2,$3,0,'Legacy action','Follow up')",
    [workspaceId, documentId, transcriptId],
  );
  return { workspaceId, meetingId, documentId, transcriptId, segmentId, decisionId, actionId };
}
