import { z } from 'zod';

export const transcriptQuerySchema = z.object({
  transcriptId: z.uuid().optional(),
  segmentId: z.uuid().optional(),
  cursor: z
    .string()
    .regex(/^[0-9a-f-]{36}\.[0-9]{1,9}$/i)
    .optional(),
});

export const transcriptSearchSchema = transcriptQuerySchema
  .extend({ q: z.string().trim().min(1).max(200) })
  .meta({ id: 'TranscriptSearch' });

export const transcriptSpeakerSchema = z
  .object({
    id: z.uuid(),
    label: z.string(),
    displayName: z.string().nullable(),
    personId: z.uuid().nullable(),
    personName: z.string().nullable(),
  })
  .meta({ id: 'TranscriptSpeaker' });

export const transcriptSegmentSchema = z
  .object({
    id: z.uuid(),
    idx: z.int().nonnegative(),
    startMs: z.int().nonnegative(),
    endMs: z.int().positive(),
    speakerId: z.uuid(),
    text: z.string(),
    confidence: z.number().min(0).max(1).nullable(),
  })
  .meta({ id: 'TranscriptSegment' });

export const transcriptPageSchema = z
  .object({
    transcript: z
      .object({
        id: z.uuid(),
        language: z.string().nullable(),
        durationMs: z.int().positive(),
        speakerSource: z.enum(['generic', 'attendance']),
        fallbackReason: z.string().nullable(),
      })
      .nullable(),
    speakers: z.array(transcriptSpeakerSchema),
    segments: z.array(transcriptSegmentSchema),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'TranscriptPage' });

export const transcriptSpeakerParamsSchema = z.object({ id: z.uuid(), speakerId: z.uuid() });
export const patchTranscriptSpeakerSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).nullable().optional(),
    personId: z.uuid().nullable().optional(),
  })
  .refine((patch) => patch.displayName !== undefined || patch.personId !== undefined, {
    message: 'Supply a display name or person.',
  })
  .meta({ id: 'PatchTranscriptSpeaker' });

export type TranscriptPage = z.infer<typeof transcriptPageSchema>;
