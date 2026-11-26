import { z } from 'zod';

export const savedResultSchema = z
  .object({
    state: z.enum(['pending', 'ready', 'failed']),
    pending: z.boolean(),
    transcriptPurged: z.boolean(),
    temporaryAudio: z.boolean(),
    files: z.array(
      z.object({
        id: z.uuid(),
        revisionId: z.uuid(),
        size: z.int().nonnegative(),
        generatedAt: z.iso.datetime(),
        locale: z.string(),
        meetingDateTime: z.string(),
      }),
    ),
  })
  .meta({ id: 'SavedMeetingResult' });
export const pdfQuerySchema = z.object({
  fileId: z.uuid().optional(),
  download: z.enum(['true', 'false']).optional(),
});
export const readinessSchema = z
  .object({
    features: z.array(
      z.object({
        name: z.string(),
        state: z.enum(['ready', 'off', 'misconfigured']),
        reason: z.string(),
        fix: z.enum(['settings', 'environment']).nullable(),
      }),
    ),
  })
  .meta({ id: 'SystemReadiness' });

export const contentPurgeRequestSchema = z
  .object({
    kind: z.enum(['recordings', 'transcripts']),
    dryRun: z.boolean(),
    confirmation: z.string().max(40).optional(),
    expectedCount: z.int().nonnegative().optional(),
    expectedBytes: z.int().nonnegative().optional(),
  })
  .meta({ id: 'ContentPurgeRequest' });
export const contentPurgeResponseSchema = z
  .object({ count: z.int().nonnegative(), bytes: z.number().nonnegative(), purged: z.boolean() })
  .meta({ id: 'ContentPurgeResponse' });
