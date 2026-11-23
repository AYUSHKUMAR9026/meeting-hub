import { z } from 'zod';

const summary = z
  .object({ paragraph: z.string(), bullets: z.array(z.string()) })
  .meta({ id: 'MeetingSummary' });
const citation = z
  .object({ segmentId: z.uuid(), idx: z.int().nonnegative(), startMs: z.int().nonnegative() })
  .meta({ id: 'DocumentCitation' });
const title = z.string().trim().min(1).max(180);
const description = z.string().trim().min(1).max(2000);
const rationale = z.string().trim().max(1000).nullable();
const decisionStatus = z.enum(['proposed', 'confirmed', 'rejected']);
const actionStatus = z.enum(['open', 'done', 'rejected']);
const dueDate = z.iso.date().nullable();
const segmentIds = z.array(z.uuid()).min(1).max(50);
const fields = { title, description };
const itemDetails = {
  id: z.uuid(),
  idx: z.int().nonnegative(),
  ...fields,
  editedByUser: z.boolean(),
  source: z.enum(['ai', 'manual']),
  citations: z.array(citation),
};
const owner = { ownerSpeakerId: z.uuid().nullable(), ownerPersonId: z.uuid().nullable(), dueDate };
export const decisionSchema = z
  .object({ ...itemDetails, rationale, status: decisionStatus })
  .meta({ id: 'MeetingDecision' });
export const actionItemSchema = z
  .object({
    ...itemDetails,
    ...owner,
    ownerName: z.string().nullable(),
    status: actionStatus,
  })
  .meta({ id: 'MeetingActionItem' });

export const meetingDocumentSchema = z
  .object({
    id: z.uuid(),
    transcriptId: z.uuid(),
    processingRunId: z.uuid(),
    model: z.string(),
    promptVersion: z.string(),
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    createdAt: z.iso.datetime(),
    isCurrent: z.boolean(),
    summary,
    decisions: z.array(decisionSchema),
    actionItems: z.array(actionItemSchema),
  })
  .meta({ id: 'MeetingDocument' });

export const meetingDocumentQuerySchema = z.object({ documentId: z.uuid().optional() });
export const meetingDocumentResponseSchema = z
  .object({
    document: meetingDocumentSchema.nullable(),
    revisions: z.array(
      z.object({
        id: z.uuid(),
        createdAt: z.iso.datetime(),
        isCurrent: z.boolean(),
        hasHumanEdits: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'MeetingDocumentResponse' });

export const documentItemMutationSchema = z
  .object({ id: z.uuid() })
  .meta({ id: 'DocumentItemMutation' });
export const documentItemParamsSchema = z.object({ id: z.uuid(), itemId: z.uuid() });
export const addDecisionSchema = z
  .object({ ...fields, rationale: rationale.optional(), segmentIds })
  .meta({ id: 'AddMeetingDecision' });
export const addActionItemSchema = z
  .object({
    ...fields,
    dueDate: dueDate.optional(),
    segmentIds,
  })
  .meta({ id: 'AddMeetingActionItem' });
export const patchDecisionSchema = z
  .object({
    ...fields,
    status: decisionStatus,
    rationale,
    segmentIds,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Supply a field to update.')
  .meta({ id: 'PatchMeetingDecision' });
export const patchActionItemSchema = z
  .object({
    ...fields,
    status: actionStatus,
    dueDate,
    segmentIds,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Supply a field to update.')
  .meta({ id: 'PatchMeetingActionItem' });
export type Decision = z.infer<typeof decisionSchema>;
export type ActionItem = z.infer<typeof actionItemSchema>;
export type MeetingDocumentResponse = z.infer<typeof meetingDocumentResponseSchema>;
export type AddDecision = z.infer<typeof addDecisionSchema>;
export type AddActionItem = z.infer<typeof addActionItemSchema>;
export type PatchDecision = z.infer<typeof patchDecisionSchema>;
export type PatchActionItem = z.infer<typeof patchActionItemSchema>;
