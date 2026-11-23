import { z } from 'zod';

export const exportQuerySchema = z.object({
  format: z.enum(['md', 'docx', 'pdf']),
  include: z.literal('transcript').optional(),
});
export const transcriptExportQuerySchema = z.object({ format: z.enum(['txt', 'srt']) });
export const shareScopeSchema = z.enum(['document', 'document_and_transcript']);
export const createShareSchema = z
  .object({ scope: shareScopeSchema, expiresInDays: z.int().min(1).max(90) })
  .meta({ id: 'CreateShare' });
export const shareParamsSchema = z.object({ id: z.uuid(), shareId: z.uuid() });
export const shareTokenParamsSchema = z.object({ token: z.string() });
export const shareLinkSchema = z
  .object({
    id: z.uuid(),
    scope: shareScopeSchema,
    expiresAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    lastAccessedAt: z.iso.datetime().nullable(),
    accessCount: z.int().nonnegative(),
  })
  .meta({ id: 'ShareLink' });
export const shareListSchema = z
  .object({ links: z.array(shareLinkSchema) })
  .meta({ id: 'ShareList' });
export const createdShareSchema = shareLinkSchema
  .extend({ url: z.url() })
  .meta({ id: 'CreatedShare' });
export const publicShareSchema = z
  .object({
    title: z.string(),
    occurredAt: z.iso.datetime(),
    summary: z.object({ paragraph: z.string(), bullets: z.array(z.string()) }),
    decisions: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        rationale: z.string().nullable(),
        status: z.enum(['proposed', 'confirmed']),
        timestampsMs: z.array(z.int().nonnegative()),
      }),
    ),
    actionItems: z.array(
      z.object({
        title: z.string(),
        description: z.string(),
        owner: z.string().nullable(),
        dueDate: z.iso.date().nullable(),
        status: z.enum(['open', 'done']),
        timestampsMs: z.array(z.int().nonnegative()),
      }),
    ),
    transcript: z
      .array(
        z.object({
          startMs: z.int().nonnegative(),
          endMs: z.int().positive(),
          speaker: z.string(),
          text: z.string(),
        }),
      )
      .nullable(),
  })
  .meta({ id: 'PublicShare' });

export const bulkDecisionSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(100),
    status: z.enum(['confirmed', 'rejected']),
  })
  .meta({ id: 'BulkDecisions' });

const trackerFields = {
  meetingId: z.uuid().optional(),
  q: z.string().trim().min(1).max(160).optional(),
  cursor: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(30),
};
export const trackedDecisionQuerySchema = z.object({
  ...trackerFields,
  status: z.enum(['proposed', 'confirmed', 'rejected']).optional(),
  sort: z.enum(['newest', 'oldest', 'title']).default('newest'),
});
export const trackedActionQuerySchema = z
  .object({
    ...trackerFields,
    status: z.enum(['open', 'done', 'rejected']).optional(),
    sort: z.enum(['newest', 'oldest', 'title', 'due']).default('due'),
    ownerPersonId: z.uuid().optional(),
    mine: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    dueFrom: z.iso.date().optional(),
    dueTo: z.iso.date().optional(),
  })
  .refine(
    (query) => !query.dueFrom || !query.dueTo || query.dueFrom <= query.dueTo,
    'The due date range is reversed.',
  );
const trackedItem = {
  id: z.uuid(),
  meetingId: z.uuid(),
  meetingTitle: z.string(),
  meetingOccurredAt: z.iso.datetime(),
  createdBy: z.uuid().nullable(),
  transcriptId: z.uuid(),
  title: z.string(),
  description: z.string(),
  citation: z.object({ segmentId: z.uuid(), startMs: z.int().nonnegative() }).nullable(),
};
export const trackedDecisionPageSchema = z
  .object({
    items: z.array(
      z.object({ ...trackedItem, status: z.enum(['proposed', 'confirmed', 'rejected']) }),
    ),
    nextCursor: z.int().nonnegative().nullable(),
  })
  .meta({ id: 'TrackedDecisionPage' });
export const trackedActionPageSchema = z
  .object({
    items: z.array(
      z.object({
        ...trackedItem,
        status: z.enum(['open', 'done', 'rejected']),
        ownerPersonId: z.uuid().nullable(),
        ownerName: z.string().nullable(),
        dueDate: z.iso.date().nullable(),
      }),
    ),
    nextCursor: z.int().nonnegative().nullable(),
  })
  .meta({ id: 'TrackedActionPage' });
export type PublicShare = z.infer<typeof publicShareSchema>;
export type ShareLink = z.infer<typeof shareLinkSchema>;
export type TrackedDecisionQuery = z.infer<typeof trackedDecisionQuerySchema>;
export type TrackedActionQuery = z.infer<typeof trackedActionQuerySchema>;
