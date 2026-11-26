import {
  and,
  asc,
  eq,
  gt,
  sql,
  transcripts,
  transcriptSegments,
  transcriptSpeakers,
  people,
} from '@meeting-hub/db';

import type { Database } from '../../lib/db';
import { AppError, NotFoundError } from '../../lib/errors';

export type TranscriptCue = {
  startMs: number;
  endMs: number;
  speaker: string;
  label: string;
  text: string;
};

export const contentTooLarge = () =>
  new AppError('EXPORT_TOO_LARGE', 'The selected content exceeds the byte limit.', {
    status: 413,
    expose: true,
  });

export async function readTranscriptSource(
  db: Pick<Database, 'select'>,
  scope: {
    workspaceId: string;
    meetingId: string;
    transcriptId?: string;
    maxBytes: number;
  },
  signal: AbortSignal,
): Promise<TranscriptCue[]> {
  const { workspaceId, meetingId, transcriptId, maxBytes } = scope;
  const [transcript] = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.workspaceId, workspaceId),
        eq(transcripts.meetingId, meetingId),
        eq(transcripts.status, 'completed'),
        transcriptId ? eq(transcripts.id, transcriptId) : eq(transcripts.isCurrent, true),
      ),
    );
  if (!transcript) throw new NotFoundError('Transcript not found');
  const cues: TranscriptCue[] = [];
  let cursor = -1;
  let bytes = 0;
  const fetchLimit = 200;
  for (;;) {
    signal.throwIfAborted();
    const rows = await db
      .select({
        idx: transcriptSegments.idx,
        startMs: transcriptSegments.startMs,
        endMs: transcriptSegments.endMs,
        text: sql<string>`left(${transcriptSegments.text}, ${maxBytes + 1})`,
        label: transcriptSpeakers.label,
        speaker: sql<string>`coalesce(${transcriptSpeakers.displayName}, ${people.displayName}, ${transcriptSpeakers.label})`,
      })
      .from(transcriptSegments)
      .innerJoin(
        transcriptSpeakers,
        and(
          eq(transcriptSegments.speakerId, transcriptSpeakers.id),
          eq(transcriptSegments.workspaceId, transcriptSpeakers.workspaceId),
        ),
      )
      .leftJoin(
        people,
        and(eq(people.id, transcriptSpeakers.personId), eq(people.workspaceId, workspaceId)),
      )
      .where(
        and(
          eq(transcriptSegments.workspaceId, workspaceId),
          eq(transcriptSegments.transcriptId, transcript.id),
          gt(transcriptSegments.idx, cursor),
        ),
      )
      .orderBy(asc(transcriptSegments.idx))
      .limit(fetchLimit);
    for (const { idx, ...cue } of rows) {
      bytes += Buffer.byteLength(cue.text) + Buffer.byteLength(cue.speaker) + 64;
      if (bytes > maxBytes) throw contentTooLarge();
      cues.push(cue);
      cursor = idx;
    }
    if (rows.length < fetchLimit) return cues;
  }
}
