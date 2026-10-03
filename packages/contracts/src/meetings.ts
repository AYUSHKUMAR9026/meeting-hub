import { z } from 'zod';

// --- upload rules shared by the API (enforces) and the browser (fails fast) ----------------------

/**
 * Recording types we accept, with the file extensions that map to them. Browsers sometimes report
 * an empty or vendor type, so the web app falls back to the extension (`contentTypeForFile`).
 * Real media validation (ffprobe) happens in processing, not here.
 */
export const uploadContentTypes = {
  'audio/mpeg': ['mp3'],
  'audio/mp4': ['m4a'],
  'audio/x-m4a': ['m4a'],
  'audio/aac': ['aac'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/wave': ['wav'],
  'audio/ogg': ['ogg', 'oga'],
  'audio/opus': ['opus'],
  'audio/webm': ['weba'],
  'video/webm': ['webm'],
  'video/mp4': ['mp4'],
  'video/quicktime': ['mov'],
} as const satisfies Record<string, readonly string[]>;
export type UploadContentType = keyof typeof uploadContentTypes;

export const isAllowedUploadType = (type: string): type is UploadContentType =>
  Object.hasOwn(uploadContentTypes, type.toLowerCase());

/** Accept attribute for a file input: every allowed type and extension. */
export const uploadAcceptAttribute = [
  ...Object.keys(uploadContentTypes),
  ...new Set(Object.values(uploadContentTypes).flatMap((exts) => exts.map((e) => `.${e}`))),
].join(',');

/** The type to declare for a file: its own if allowed, else one inferred from the extension. */
export function contentTypeForFile(file: { name: string; type: string }): UploadContentType | null {
  if (file.type && isAllowedUploadType(file.type))
    return file.type.toLowerCase() as UploadContentType;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  const match = Object.entries(uploadContentTypes).find(([, exts]) =>
    (exts as readonly string[]).includes(ext),
  );
  return (match?.[0] as UploadContentType | undefined) ?? null;
}

/** Default MAX_UPLOAD_BYTES (2 GiB). The API's configured limit is what's enforced. */
export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

// --- meetings -------------------------------------------------------------------------------------

export const meetingStatusSchema = z
  .enum([
    'awaiting_upload',
    'uploading',
    'uploaded',
    'processing',
    'ready',
    'partially_ready',
    'failed',
  ])
  .meta({ id: 'MeetingStatus' });
export type MeetingStatus = z.infer<typeof meetingStatusSchema>;

export const recordingStatusSchema = z
  .enum(['pending', 'uploading', 'uploaded', 'failed', 'deleted'])
  .meta({ id: 'RecordingStatus' });
export type RecordingStatus = z.infer<typeof recordingStatusSchema>;

export const meetingParticipantSchema = z
  .object({ id: z.uuid(), displayName: z.string() })
  .meta({ id: 'MeetingParticipant' });

export const recordingSummarySchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(['original', 'normalized']),
    fileName: z.string().describe('Original file name (display only; never used as a storage key)'),
    contentType: z.string(),
    sizeBytes: z.int(),
    durationMs: z.int().nullable(),
    status: recordingStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'RecordingSummary' });
export type RecordingSummary = z.infer<typeof recordingSummarySchema>;

export const meetingSchema = z
  .object({
    id: z.uuid(),
    workspaceId: z.uuid(),
    title: z.string(),
    occurredAt: z.iso.datetime(),
    durationMs: z.int().nullable(),
    language: z.string().nullable(),
    status: meetingStatusSchema,
    source: z.string(),
    createdBy: z.uuid().nullable().describe('User who created the meeting (null if deleted)'),
    participants: z.array(meetingParticipantSchema),
    recording: recordingSummarySchema.nullable().describe('The original recording, if any'),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Meeting' });
export type Meeting = z.infer<typeof meetingSchema>;

export const meetingListSchema = z
  .object({
    meetings: z.array(meetingSchema),
    nextCursor: z.string().nullable().describe('Pass as `cursor` to get the next (older) page'),
  })
  .meta({ id: 'MeetingList' });

export const meetingsQuerySchema = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    status: meetingStatusSchema.optional(),
    from: z.iso.datetime({ offset: true }).optional().describe('occurredAt ≥ from'),
    to: z.iso.datetime({ offset: true }).optional().describe('occurredAt < to'),
  })
  .refine((q) => !q.from || !q.to || new Date(q.from) < new Date(q.to), {
    message: '`from` must be before `to`',
    path: ['to'],
  });

const titleSchema = z.string().trim().min(1).max(200);
const participantIdsSchema = z
  .array(z.uuid())
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, 'participants must not repeat')
  .describe('People directory ids');

export const createMeetingRequestSchema = z
  .object({
    title: titleSchema,
    occurredAt: z.iso.datetime({ offset: true }),
    participantIds: participantIdsSchema.default([]),
  })
  .meta({ id: 'CreateMeetingRequest' });

export const updateMeetingRequestSchema = z
  .object({
    title: titleSchema.optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    participantIds: participantIdsSchema.optional().describe('Replaces the participant list'),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update')
  .meta({ id: 'UpdateMeetingRequest' });

export const meetingParamsSchema = z.object({ id: z.uuid() });

// --- uploads --------------------------------------------------------------------------------------

export const uploadParamsSchema = z.object({ id: z.uuid(), uploadId: z.uuid() });

export const idempotencyHeadersSchema = z.object({
  'idempotency-key': z
    .string()
    .trim()
    .min(8)
    .max(200)
    .describe('Client-generated key; retrying with the same key returns the same upload'),
});

export const startUploadRequestSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(100).describe('One of the allowed audio/video types'),
    sizeBytes: z.int().positive(),
    consentConfirmed: z
      .literal(true, { error: 'confirm that participants consented to being recorded' })
      .describe('The uploader confirms that participants consented to being recorded'),
  })
  .meta({ id: 'StartUploadRequest' });

export const presignedPartSchema = z
  .object({ partNumber: z.int().min(1), url: z.url() })
  .meta({ id: 'PresignedPart' });

export const startUploadResponseSchema = z
  .object({
    uploadId: z.uuid(),
    meetingId: z.uuid(),
    partSize: z.int().describe('Bytes per part; the last part may be smaller'),
    partCount: z.int(),
    urlsExpireAt: z.iso.datetime(),
    parts: z.array(presignedPartSchema).describe('URLs for the first batch of parts'),
  })
  .meta({ id: 'StartUploadResponse' });

export const presignPartsRequestSchema = z
  .object({
    partNumbers: z
      .array(z.int().min(1).max(10_000))
      .min(1)
      .max(100)
      .refine((n) => new Set(n).size === n.length, 'part numbers must not repeat'),
  })
  .meta({ id: 'PresignPartsRequest' });

export const presignPartsResponseSchema = z
  .object({ urlsExpireAt: z.iso.datetime(), parts: z.array(presignedPartSchema) })
  .meta({ id: 'PresignPartsResponse' });

export const completeUploadRequestSchema = z
  .object({
    parts: z
      .array(z.object({ partNumber: z.int().min(1).max(10_000), etag: z.string().min(1).max(200) }))
      .min(1)
      .max(10_000),
  })
  .meta({ id: 'CompleteUploadRequest' });

export const completeUploadResponseSchema = z
  .object({
    uploadId: z.uuid(),
    meetingId: z.uuid(),
    status: z.literal('uploaded'),
    sizeBytes: z.int(),
  })
  .meta({ id: 'CompleteUploadResponse' });

export const recordingDownloadSchema = z
  .object({
    recording: recordingSummarySchema,
    downloadUrl: z.url().describe('Short-lived signed URL; downloads as an attachment'),
    downloadUrlExpiresAt: z.iso.datetime(),
  })
  .meta({ id: 'RecordingDownload' });
