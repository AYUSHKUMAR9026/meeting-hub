import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  and,
  eq,
  isNotNull,
  recordings,
  roomExports,
  roomAttendance,
  people,
  user,
  transcriptionCheckpoints,
  processingSteps,
  sql,
} from '@meeting-hub/db';
import type { Database } from '../../lib/db';
import type { QuotaLimiter } from '../../lib/ai-quota';
import { ProviderRetryError, speechBuckets } from '../../lib/ai-quota';
import { PermanentError } from '../../lib/errors';
import {
  mixSpeechAudio,
  prepareSpeechAudio,
  planSpeechChunks,
  windowRms,
  withJobDir,
  type ObjectStorage,
  type SpeechAudio,
  type SpeechTools,
} from '../media';
import { assertExternalAiEnabled } from '../workspaces';
import type { RunRef } from '../processing';
import type { CompletedTranscript, TranscriptionProvider, TranscriptionOptions } from './provider';
import { mergeSegments } from './provider';
import {
  mergeTrackSegments,
  estimateSpeechSeconds,
  shouldUseMixed,
  type TrackSegment,
} from './timeline';

export interface AttendanceSpeaker {
  label: string;
  displayName: string;
  personId: string | null;
  userId: string | null;
}
export interface TrackOptions {
  db: Database;
  storage: ObjectStorage;
  provider: TranscriptionProvider;
  tools: SpeechTools;
  tmpDir: string;
  maxBytes: number;
  perTrackEnabled(workspaceId: string): Promise<boolean>;
  limiter: QuotaLimiter;
  hourSeconds: number;
  daySeconds: number;
}
const completedSchema = z.object({
  status: z.literal('completed'),
  language: z.string().nullable(),
  segments: z.array(
    z.object({
      speaker: z.string(),
      startMs: z.number(),
      endMs: z.number(),
      text: z.string(),
      confidence: z.number().nullable(),
    }),
  ),
});

export async function transcribeTracks(
  options: TrackOptions,
  run: RunRef,
  normalized: typeof recordings.$inferSelect,
  request: TranscriptionOptions,
): Promise<{
  result: CompletedTranscript;
  speakers: AttendanceSpeaker[];
  fallbackReason: string | null;
} | null> {
  const { db, storage, provider } = options;
  const perTrack = await options.perTrackEnabled(run.workspaceId);
  if (!provider.transcribe && !(perTrack && provider.name === 'fake')) return null;
  const [source] = await db
    .select({ kind: recordings.kind })
    .from(recordings)
    .where(and(eq(recordings.id, run.recordingId), eq(recordings.workspaceId, run.workspaceId)));
  let fallbackReason: string | null = null;
  const exports =
    perTrack && (source?.kind === 'mixed_audio' || source?.kind === 'participant_track')
      ? await db
          .select()
          .from(roomExports)
          .where(
            and(
              eq(roomExports.meetingId, run.meetingId),
              eq(roomExports.workspaceId, run.workspaceId),
              isNotNull(roomExports.attendanceId),
            ),
          )
      : [];
  if (exports.some((item) => ['pending', 'active'].includes(item.state)))
    throw new ProviderRetryError(65000, true, true);
  const tracks =
    perTrack && (source?.kind === 'mixed_audio' || source?.kind === 'participant_track')
      ? await db
          .select({
            recording: recordings,
            personId: roomAttendance.personId,
            userId: roomAttendance.userId,
            name: user.name,
            personName: people.displayName,
          })
          .from(recordings)
          .innerJoin(
            roomAttendance,
            and(
              eq(roomAttendance.id, recordings.attendanceId),
              eq(roomAttendance.workspaceId, run.workspaceId),
            ),
          )
          .leftJoin(user, eq(user.id, roomAttendance.userId))
          .leftJoin(
            people,
            and(eq(people.id, roomAttendance.personId), eq(people.workspaceId, run.workspaceId)),
          )
          .where(
            and(
              eq(recordings.workspaceId, run.workspaceId),
              eq(recordings.meetingId, run.meetingId),
              eq(recordings.kind, 'participant_track'),
              eq(recordings.status, 'uploaded'),
            ),
          )
      : [];
  if (
    perTrack &&
    (source?.kind === 'mixed_audio' || source?.kind === 'participant_track') &&
    (!tracks.length || exports.some((item) => item.state === 'failed'))
  )
    fallbackReason = 'participant_audio_unavailable';
  const beforeRequest = async () => {
    request.signal.throwIfAborted();
    if (provider.name !== 'fake') await assertExternalAiEnabled(db, run.workspaceId);
  };
  const cacheFor = (sourceId: string) => ({
    loadReceipt: async (key: string) => {
      const [row] = await db
        .select({ content: transcriptionCheckpoints.content })
        .from(transcriptionCheckpoints)
        .where(
          and(
            eq(transcriptionCheckpoints.workspaceId, run.workspaceId),
            eq(transcriptionCheckpoints.runId, run.id),
            eq(transcriptionCheckpoints.key, `${sourceId}:receipt:${key}`),
          ),
        );
      const receipt = z.object({ jobId: z.string() }).safeParse(row?.content);
      return receipt.success ? receipt.data.jobId : undefined;
    },
    saveReceipt: async (key: string, jobId: string) => {
      try {
        await db
          .insert(transcriptionCheckpoints)
          .values({
            workspaceId: run.workspaceId,
            meetingId: run.meetingId,
            runId: run.id,
            key: `${sourceId}:receipt:${key}`,
            content: { jobId },
          })
          .onConflictDoNothing();
      } catch {
        throw new Error('Could not persist provider receipt.');
      }
    },
    clearReceipt: async (key: string) => {
      await db
        .delete(transcriptionCheckpoints)
        .where(
          and(
            eq(transcriptionCheckpoints.workspaceId, run.workspaceId),
            eq(transcriptionCheckpoints.runId, run.id),
            eq(transcriptionCheckpoints.key, `${sourceId}:receipt:${key}`),
          ),
        );
    },
    load: async (key: string) => {
      const [row] = await db
        .select({ content: transcriptionCheckpoints.content })
        .from(transcriptionCheckpoints)
        .where(
          and(
            eq(transcriptionCheckpoints.workspaceId, run.workspaceId),
            eq(transcriptionCheckpoints.runId, run.id),
            eq(transcriptionCheckpoints.key, `${sourceId}:${key}`),
          ),
        );
      const parsed = completedSchema.safeParse(row?.content);
      return parsed.success ? parsed.data : undefined;
    },
    save: async (key: string, value: CompletedTranscript) => {
      try {
        await db
          .insert(transcriptionCheckpoints)
          .values({
            workspaceId: run.workspaceId,
            meetingId: run.meetingId,
            runId: run.id,
            key: `${sourceId}:${key}`,
            content: value,
          })
          .onConflictDoNothing();
      } catch {
        throw new Error('Could not persist transcription checkpoint.');
      }
    },
  });
  const download = async (record: typeof recordings.$inferSelect, dir: string) => {
    if (record.sizeBytes > options.maxBytes)
      throw new PermanentError(
        'TRANSCRIPTION_AUDIO_TOO_LARGE',
        'The recording exceeds the transcription media limit.',
      );
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'input');
    let size = 0;
    const stream = await storage.streamObject(record.storageKey, request.signal);
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) stream.destroy(new Error('Recording media limit exceeded.'));
    });
    await pipeline(stream, createWriteStream(path), { signal: request.signal });
    return prepareSpeechAudio(path, dir, options.tools, request.signal);
  };
  const call = async (
    record: typeof recordings.$inferSelect,
    audio: SpeechAudio,
  ): Promise<CompletedTranscript> => {
    if (provider.transcribe)
      return provider.transcribe(audio, { ...request, beforeRequest, cache: cacheFor(record.id) });
    await beforeRequest();
    const cached = await cacheFor(record.id).load('fake');
    if (cached) return cached;
    const stream = await storage.streamObject(record.storageKey, request.signal);
    try {
      const job = await provider.submit(stream, { ...request, durationMs: audio.durationMs });
      const result = await provider.getResult(job, request.signal);
      if (result.status !== 'completed') throw new ProviderRetryError(5000, false);
      await cacheFor(record.id).save('fake', result);
      return result;
    } finally {
      stream.destroy();
    }
  };
  return withJobDir(options.tmpDir, async (dir) => {
    const prepared: {
      record: typeof recordings.$inferSelect;
      audio: SpeechAudio;
      speaker: AttendanceSpeaker;
    }[] = [];
    for (const track of tracks) {
      request.signal.throwIfAborted();
      const audio = await download(track.recording, join(dir, track.recording.id));
      if (provider.name === 'fake' || audio.ranges.length)
        prepared.push({
          record: track.recording,
          audio,
          speaker: {
            label: `Attendance ${track.recording.attendanceId}`,
            displayName: track.name ?? track.personName ?? 'Participant',
            personId: track.personId,
            userId: track.userId,
          },
        });
    }
    const seconds = estimateSpeechSeconds(
      prepared.map((p) => p.audio.ranges.reduce((sum, r) => sum + r.endMs - r.startMs, 0)),
      prepared.reduce((sum, p) => sum + planSpeechChunks(p.audio.ranges).length, 0),
    );
    if (
      provider.name !== 'fake' &&
      prepared.length &&
      shouldUseMixed(
        seconds,
        options.hourSeconds,
        options.daySeconds,
        await options.limiter.available(
          speechBuckets(seconds, options.hourSeconds, options.daySeconds),
        ),
      )
    )
      fallbackReason = 'free_quota_speaker_fallback';
    // Persist the chosen plan so quota changes or a restart cannot switch sources mid-run.
    const planKey = 'speaker-plan';
    const [savedPlan] = await db
      .select({ content: transcriptionCheckpoints.content })
      .from(transcriptionCheckpoints)
      .where(
        and(
          eq(transcriptionCheckpoints.workspaceId, run.workspaceId),
          eq(transcriptionCheckpoints.runId, run.id),
          eq(transcriptionCheckpoints.key, planKey),
        ),
      );
    const parsedPlan = z
      .object({ fallbackReason: z.string().nullable() })
      .safeParse(savedPlan?.content);
    if (parsedPlan.success) fallbackReason = parsedPlan.data.fallbackReason;
    else
      await db
        .insert(transcriptionCheckpoints)
        .values({
          workspaceId: run.workspaceId,
          meetingId: run.meetingId,
          runId: run.id,
          key: planKey,
          content: { fallbackReason },
        })
        .onConflictDoNothing();
    if (fallbackReason)
      await db
        .update(processingSteps)
        .set({
          metadata: sql`${processingSteps.metadata} || ${JSON.stringify({ fallbackReason })}::jsonb`,
        })
        .where(
          and(
            eq(processingSteps.runId, run.id),
            eq(processingSteps.workspaceId, run.workspaceId),
            eq(processingSteps.name, 'transcribe'),
          ),
        );
    if (tracks.length && !fallbackReason) {
      const merged: TrackSegment[] = [];
      for (const { record, audio, speaker } of prepared) {
        const result = await call(record, audio);
        const offset = record.startOffsetMs ?? 0;
        for (const segment of result.segments)
          merged.push({
            ...segment,
            speaker: speaker.label,
            startMs: segment.startMs + offset,
            endMs: segment.endMs + offset,
            trackId: record.id,
            rms: windowRms(audio.frames, segment.startMs, segment.endMs),
          });
      }
      const segments =
        provider.name === 'fake'
          ? merged
              .sort((a, b) => a.startMs - b.startMs)
              .map(({ trackId, rms, ...segment }) => {
                void trackId;
                void rms;
                return segment;
              })
          : mergeTrackSegments(merged);
      return {
        result: {
          status: 'completed',
          language: request.language,
          segments: mergeSegments(segments),
        },
        speakers: prepared.map((p) => p.speaker),
        fallbackReason: null,
      };
    }
    if (!provider.transcribe) return null;
    const audio =
      source?.kind === 'participant_track' && prepared.length
        ? await mixSpeechAudio(
            prepared.map((p) => ({ path: p.audio.path, offsetMs: p.record.startOffsetMs ?? 0 })),
            dir,
            options.tools,
            request.signal,
          )
        : await download(normalized, join(dir, 'mixed'));
    const result = await call(normalized, audio);
    return {
      result: {
        ...result,
        segments: mergeSegments(result.segments.map((s) => ({ ...s, speaker: 'Speaker' }))),
      },
      speakers: [],
      fallbackReason,
    };
  });
}
