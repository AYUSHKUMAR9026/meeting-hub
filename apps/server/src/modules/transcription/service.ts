import type { TranscriptPage } from '@meeting-hub/contracts';
import {
  and,
  asc,
  eq,
  gt,
  gte,
  ilike,
  isNull,
  meetings,
  people,
  transcriptSegments,
  transcriptSpeakers,
  transcripts,
} from '@meeting-hub/db';

import type { Database, Transaction } from '../../lib/db';
import { ConflictError, NotFoundError } from '../../lib/errors';
import type { AuditService, RequestOrigin } from '../audit';
import { authorize, type WorkspaceActor } from '../auth';

const PAGE_SIZE = 100;
const speakerFields = {
  id: transcriptSpeakers.id,
  label: transcriptSpeakers.label,
  displayName: transcriptSpeakers.displayName,
  personId: transcriptSpeakers.personId,
  personName: people.displayName,
};

export class TranscriptionService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async read(
    actor: WorkspaceActor,
    meetingId: string,
    query: {
      cursor?: string | undefined;
      q?: string | undefined;
      transcriptId?: string | undefined;
      segmentId?: string | undefined;
    },
  ): Promise<TranscriptPage> {
    authorize(actor, 'meeting.read');
    const [transcript] = await this.current(
      this.db,
      actor.workspaceId,
      meetingId,
      query.transcriptId,
    );
    if (!transcript && query.transcriptId) throw new NotFoundError('Transcript not found');
    if (!transcript) return { transcript: null, speakers: [], segments: [], nextCursor: null };
    const [cursorId, idx] = query.cursor?.split('.') ?? [];
    if (cursorId && cursorId !== transcript.id)
      throw new ConflictError(
        'TRANSCRIPT_CHANGED',
        'The transcript changed. Reload the first page.',
      );
    const [focus] = query.segmentId
      ? await this.db
          .select({ idx: transcriptSegments.idx })
          .from(transcriptSegments)
          .where(
            and(
              eq(transcriptSegments.id, query.segmentId),
              eq(transcriptSegments.workspaceId, actor.workspaceId),
              eq(transcriptSegments.transcriptId, transcript.id),
            ),
          )
      : [];
    if (query.segmentId && !focus) throw new NotFoundError('Transcript segment not found');
    try {
      const [speakers, rows] = await Promise.all([
        this.speakers(this.db, actor.workspaceId, transcript.id).orderBy(
          asc(transcriptSpeakers.label),
        ),
        this.db
          .select({
            id: transcriptSegments.id,
            idx: transcriptSegments.idx,
            startMs: transcriptSegments.startMs,
            endMs: transcriptSegments.endMs,
            speakerId: transcriptSegments.speakerId,
            text: transcriptSegments.text,
            confidence: transcriptSegments.confidence,
          })
          .from(transcriptSegments)
          .where(
            and(
              eq(transcriptSegments.workspaceId, actor.workspaceId),
              eq(transcriptSegments.transcriptId, transcript.id),
              focus
                ? gte(transcriptSegments.idx, focus.idx)
                : idx === undefined
                  ? undefined
                  : gt(transcriptSegments.idx, Number(idx)),
              query.q
                ? ilike(transcriptSegments.text, '%' + query.q.replace(/[\\%_]/g, '\\$&') + '%')
                : undefined,
            ),
          )
          .orderBy(asc(transcriptSegments.idx))
          .limit(PAGE_SIZE + 1),
      ]);
      const segments = rows.slice(0, PAGE_SIZE);
      const nextCursor =
        rows.length > PAGE_SIZE ? `${transcript.id}.${segments.at(-1)!.idx}` : null;
      return { transcript, speakers, segments, nextCursor };
    } catch {
      throw new Error('Could not read the transcript.');
    }
  }

  async patchSpeaker(
    actor: WorkspaceActor,
    meetingId: string,
    speakerId: string,
    patch: { displayName?: string | null | undefined; personId?: string | null | undefined },
    origin: RequestOrigin,
  ) {
    authorize(actor, 'transcript.speaker.update');
    const speaker = await this.db.transaction(async (tx) => {
      const [current] = await this.current(tx, actor.workspaceId, meetingId).for('update', {
        of: transcripts,
      });
      if (!current) throw new NotFoundError('Transcript not found');
      if (patch.personId) {
        const [person] = await tx
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.id, patch.personId), eq(people.workspaceId, actor.workspaceId)))
          .for('key share');
        if (!person) throw new NotFoundError('Person not found');
      }
      const scope = and(
        eq(transcriptSpeakers.id, speakerId),
        eq(transcriptSpeakers.transcriptId, current.id),
        eq(transcriptSpeakers.workspaceId, actor.workspaceId),
      );
      try {
        await tx.update(transcriptSpeakers).set(patch).where(scope);
      } catch {
        throw new Error('Could not update the speaker.');
      }
      const [updated] = await this.speakers(tx, actor.workspaceId, current.id, speakerId);
      if (!updated) throw new NotFoundError('Speaker not found');
      return updated;
    });
    await this.audit.record({
      action: 'transcript.speaker_updated',
      workspaceId: actor.workspaceId,
      actorUserId: actor.userId,
      target: { type: 'meeting', id: meetingId },
      metadata: { speakerId, fields: Object.keys(patch) },
      origin,
    });
    return speaker;
  }

  private current(
    db: Database | Transaction,
    workspaceId: string,
    meetingId: string,
    transcriptId?: string,
  ) {
    return db
      .select({
        id: transcripts.id,
        language: transcripts.language,
        durationMs: transcripts.durationMs,
      })
      .from(transcripts)
      .innerJoin(
        meetings,
        and(
          eq(meetings.id, transcripts.meetingId),
          eq(meetings.workspaceId, transcripts.workspaceId),
        ),
      )
      .where(
        and(
          eq(transcripts.workspaceId, workspaceId),
          eq(transcripts.meetingId, meetingId),
          transcriptId ? eq(transcripts.id, transcriptId) : eq(transcripts.isCurrent, true),
          eq(transcripts.status, 'completed'),
          isNull(meetings.deletedAt),
        ),
      )
      .limit(1);
  }

  private speakers(
    db: Database | Transaction,
    workspaceId: string,
    transcriptId: string,
    speakerId?: string,
  ) {
    return db
      .select(speakerFields)
      .from(transcriptSpeakers)
      .leftJoin(
        people,
        and(
          eq(people.id, transcriptSpeakers.personId),
          eq(people.workspaceId, transcriptSpeakers.workspaceId),
        ),
      )
      .where(
        and(
          eq(transcriptSpeakers.workspaceId, workspaceId),
          eq(transcriptSpeakers.transcriptId, transcriptId),
          speakerId ? eq(transcriptSpeakers.id, speakerId) : undefined,
        ),
      );
  }
}
