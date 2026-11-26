import {
  and,
  eq,
  actionItems,
  decisions,
  evidence,
  meetingDocuments,
  meetings,
  people,
  processingRuns,
  recordings,
  transcripts,
  transcriptSegments,
  transcriptSpeakers,
} from '@meeting-hub/db';

import type { TestApp } from './harness';

export async function reviewFixture(t: TestApp, workspaceId: string, creatorId: string) {
  const db = t.deps.db.db;
  const [meeting] = await db
    .insert(meetings)
    .values({
      workspaceId,
      createdBy: creatorId,
      occurredAt: new Date('2026-11-22T15:00:00Z'),
      resultPolicy: 'legacy',
      title: 'Roadmap <review> & café',
      status: 'ready',
    })
    .returning();
  const meetingId = meeting!.id;
  const [recording] = await db
    .insert(recordings)
    .values({
      meetingId,
      workspaceId,
      kind: 'original',
      storageKey: 'test/' + meetingId,
      originalFilename: 'roadmap.wav',
      contentType: 'audio/wav',
      sizeBytes: 16,
      status: 'uploaded',
    })
    .returning();
  const [run] = await db
    .insert(processingRuns)
    .values({
      workspaceId,
      meetingId,
      recordingId: recording!.id,
      trigger: 'upload',
      pipelineVersion: 3,
      status: 'completed',
    })
    .returning();
  const processingRunId = run!.id;
  const [transcript] = await db
    .insert(transcripts)
    .values({
      workspaceId,
      meetingId,
      processingRunId,
      provider: 'fake',
      providerJobId: 'review-fixture-' + meetingId,
      durationMs: 5000,
      status: 'completed',
      isCurrent: true,
    })
    .returning();
  const transcriptId = transcript!.id;
  const [speaker] = await db
    .insert(transcriptSpeakers)
    .values({
      workspaceId,
      transcriptId,
      label: 'Speaker A',
      displayName: 'Alex & Co.',
    })
    .returning();
  const [segment] = await db
    .insert(transcriptSegments)
    .values({
      workspaceId,
      transcriptId,
      speakerId: speaker!.id,
      idx: 0,
      startMs: 1234,
      endMs: 5000,
      text: 'Private cue <i> & cue@example.test',
    })
    .returning();
  const [document] = await db
    .insert(meetingDocuments)
    .values({
      workspaceId,
      transcriptId,
      meetingId,
      processingRunId,
      status: 'completed',
      isCurrent: true,
      model: 'fake',
      promptVersion: 'review-fixture',
      summary: {
        paragraph: 'Planning summary <script> & notes@example.test',
        bullets: ['First point'],
      },
    })
    .returning();
  const scope = { documentId: document!.id, transcriptId, workspaceId };
  const [decision] = await db
    .insert(decisions)
    .values({
      ...scope,
      idx: 0,
      title: 'Choose 100% coverage',
      description: 'Agreed during review',
    })
    .returning();
  const [action] = await db
    .insert(actionItems)
    .values({
      ...scope,
      idx: 0,
      title: 'Send follow-up',
      description: 'Share it with the team',
      dueDate: '2026-11-24',
      ownerSpeakerId: speaker!.id,
    })
    .returning();
  const segmentId = segment!.id;
  const decisionId = decision!.id;
  const actionId = action!.id;
  await db.insert(evidence).values([
    { ...scope, itemType: 'decision', itemId: decisionId, segmentId },
    { ...scope, itemType: 'action_item', itemId: actionId, segmentId },
  ]);
  return { ...scope, meetingId, segmentId, decisionId, actionId };
}

export async function linkReviewOwner(
  t: TestApp,
  fixture: Awaited<ReturnType<typeof reviewFixture>>,
  userId: string,
) {
  const db = t.deps.db.db;
  const [existing] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.workspaceId, fixture.workspaceId), eq(people.userId, userId)));
  if (existing) return existing.id;
  const [person] = await db
    .insert(people)
    .values({ workspaceId: fixture.workspaceId, userId, displayName: 'Alex & Co.' })
    .returning();
  return person!.id;
}
