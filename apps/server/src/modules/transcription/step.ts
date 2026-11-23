import {
  and,
  eq,
  recordings,
  transcriptSegments,
  transcriptSpeakers,
  transcripts,
  workspaceSettings,
} from '@meeting-hub/db';

import type { Database, Transaction } from '../../lib/db';
import { PermanentError } from '../../lib/errors';
import type { ObjectStorage } from '../media';
import type { RunRef, StepDefinition } from '../processing';
import { RetryableProviderJobError } from './assemblyai';
import type { TranscriptionProvider, TranscriptionResult } from './provider';

type CompletedResult = Extract<TranscriptionResult, { status: 'completed' }>;
type Transcript = typeof transcripts.$inferSelect;

const MAX_ATTEMPTS = 5;
const MAX_PROVIDER_DURATION_MS = 36_000_000;
const timeoutFor = (durationMs: number) => 120_000 + 2 * durationMs;

async function completeTranscript(
  tx: Transaction,
  transcript: Transcript,
  result: CompletedResult,
) {
  const segments = result.segments
    .map((segment) => ({ ...segment, endMs: Math.min(transcript.durationMs, segment.endMs) }))
    .filter((segment) => segment.startMs < segment.endMs);
  const labels = [...new Set(segments.map((segment) => segment.speaker))];
  try {
    const speakers = labels.length
      ? await tx
          .insert(transcriptSpeakers)
          .values(
            labels.map((label) => ({
              label,
              transcriptId: transcript.id,
              workspaceId: transcript.workspaceId,
            })),
          )
          .returning({ id: transcriptSpeakers.id, label: transcriptSpeakers.label })
      : [];
    const speakerIds = new Map(speakers.map(({ id, label }) => [label, id]));
    // Chunk the insert to stay below Postgres's parameter limit on long recordings.
    for (let offset = 0; offset < segments.length; offset += 1000) {
      await tx.insert(transcriptSegments).values(
        segments.slice(offset, offset + 1000).map(({ speaker, ...segment }, index) => ({
          ...segment,
          idx: offset + index,
          transcriptId: transcript.id,
          workspaceId: transcript.workspaceId,
          speakerId: speakerIds.get(speaker)!,
        })),
      );
    }
    await tx
      .update(transcripts)
      .set({ isCurrent: false })
      .where(
        and(
          eq(transcripts.meetingId, transcript.meetingId),
          eq(transcripts.workspaceId, transcript.workspaceId),
          eq(transcripts.isCurrent, true),
        ),
      );
    await tx
      .update(transcripts)
      .set({
        status: 'completed',
        isCurrent: true,
        language: result.language ?? transcript.language,
      })
      .where(eq(transcripts.id, transcript.id));
  } catch {
    // Drizzle errors include SQL parameters, which may include transcript text.
    throw new Error('Could not persist the transcript.');
  }
}

export function transcribeStep(options: {
  db: Database;
  storage: ObjectStorage;
  provider: TranscriptionProvider;
  maxDurationSeconds: number;
  queue: string;
  pollMs?: number;
}): StepDefinition {
  const { db, storage, provider } = options;
  const findTranscript = async (run: RunRef) => {
    const [row] = await db
      .select()
      .from(transcripts)
      .where(
        and(eq(transcripts.processingRunId, run.id), eq(transcripts.workspaceId, run.workspaceId)),
      );
    return row;
  };

  return {
    name: 'transcribe',
    queue: options.queue,
    runStatus: 'transcribing',
    maxAttempts: MAX_ATTEMPTS,
    backoffMs: 1000,
    timeoutMs: timeoutFor(MAX_PROVIDER_DURATION_MS),
    external: true,
    weight: 2,
    isAlreadyDone: async (run) => (await findTranscript(run))?.status === 'completed',
    async execute(ctx) {
      const existing = await findTranscript(ctx.run);
      const [audio] = await db
        .select()
        .from(recordings)
        .where(
          and(
            eq(recordings.meetingId, ctx.run.meetingId),
            eq(recordings.workspaceId, ctx.run.workspaceId),
            eq(recordings.kind, 'normalized'),
            eq(recordings.status, 'uploaded'),
          ),
        );
      const durationMs = existing?.durationMs ?? audio?.durationMs;
      if (!audio || !durationMs)
        throw new PermanentError(
          'TRANSCRIPTION_AUDIO_MISSING',
          'There is no normalized audio to transcribe.',
        );
      if (durationMs > options.maxDurationSeconds * 1000 && !existing)
        throw new PermanentError(
          'TRANSCRIPTION_TOO_LONG',
          'The recording exceeds the transcription duration limit.',
        );
      if (existing && existing.provider !== provider.name)
        throw new PermanentError(
          'TRANSCRIPTION_PROVIDER_CHANGED',
          'The transcription provider changed during this run. Start a new run.',
        );

      const deadlineAt = new Date(ctx.startedAt.getTime() + timeoutFor(durationMs));
      const timeout = new PermanentError(
        'STEP_TIMED_OUT',
        'Transcription took too long and was stopped.',
      );
      const remaining = deadlineAt.getTime() - Date.now();
      if (remaining <= 0) throw timeout;
      const deadline = AbortSignal.timeout(remaining);
      const signal = AbortSignal.any([ctx.signal, deadline]);
      const wait = {
        deadlineAt,
        delayMs: Math.min(options.pollMs ?? (provider.name === 'fake' ? 250 : 5000), remaining),
      };
      const discard = async () => {};
      try {
        if (existing) {
          const result = await provider.getResult(existing.providerJobId, signal);
          if (result.status === 'pending') return { wait, commit: async () => {}, discard };
          return {
            commit: ({ tx }) => completeTranscript(tx, existing, result),
            discard,
          };
        }

        const [settings] = await db
          .select({
            language: workspaceSettings.transcriptLanguage,
            glossary: workspaceSettings.glossary,
          })
          .from(workspaceSettings)
          .where(eq(workspaceSettings.workspaceId, ctx.run.workspaceId));
        ctx.progress(0.15, 'submitting audio');
        const stream = await storage.streamObject(audio.storageKey, signal);
        const language = settings?.language ?? null;
        try {
          const providerJobId = await provider.submit(stream, {
            durationMs,
            language,
            glossary: settings?.glossary ?? [],
            signal,
          });
          return {
            wait,
            discard,
            commit: async ({ tx }) => {
              await tx.insert(transcripts).values({
                workspaceId: ctx.run.workspaceId,
                meetingId: ctx.run.meetingId,
                processingRunId: ctx.run.id,
                provider: provider.name,
                providerJobId,
                language,
                durationMs,
              });
            },
          };
        } finally {
          stream.destroy();
        }
      } catch (err) {
        if (deadline.aborted) throw timeout;
        if (existing && err instanceof RetryableProviderJobError && ctx.attempt < MAX_ATTEMPTS) {
          await ctx.checkpoint();
          await db
            .delete(transcripts)
            .where(
              and(
                eq(transcripts.id, existing.id),
                eq(transcripts.workspaceId, ctx.run.workspaceId),
                eq(transcripts.status, 'pending'),
              ),
            );
        }
        throw err;
      }
    },
  };
}
