import { and, eq, isNull, meetings, workspaceSettings } from '@meeting-hub/db';
import type { Database } from '../../lib/db';
import { ConflictError, NotFoundError } from '../../lib/errors';

export async function assertAudioAllowed(db: Database, workspaceId: string, meetingId: string) {
  const [meeting] = await db
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
  if (meeting.resultPolicy === 'temporary')
    throw new ConflictError(
      'AUDIO_TEMPORARY',
      'Audio is temporary processing input and is not available for playback, download or re-transcription. Upload a new recording to process again.',
    );
}

export async function assertTranscriptAllowed(
  db: Database,
  workspaceId: string,
  meetingId: string,
) {
  const [row] = await db
    .select({
      policy: meetings.resultPolicy,
      purged: meetings.transcriptPurgedAt,
      retention: workspaceSettings.contentRetention,
    })
    .from(meetings)
    .leftJoin(workspaceSettings, eq(workspaceSettings.workspaceId, meetings.workspaceId))
    .where(
      and(
        eq(meetings.workspaceId, workspaceId),
        eq(meetings.id, meetingId),
        isNull(meetings.deletedAt),
      ),
    );
  if (!row) throw new NotFoundError('Meeting not found');
  if (row.purged || (row.policy === 'temporary' && row.retention !== 'keep_transcript'))
    throw new ConflictError(
      'TRANSCRIPT_NOT_RETAINED',
      'This workspace saves PDFs and extracted items only. Transcript access, search, export, sharing and re-analysis are disabled. Editing decisions and action items still regenerates the PDF.',
    );
}
