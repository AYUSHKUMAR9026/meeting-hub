import { z } from 'zod';

export const auditLogEntrySchema = z
  .object({
    id: z.uuid(),
    action: z.string().describe('e.g. member.role_changed'),
    actorUserId: z.uuid().nullable(),
    targetType: z.string().nullable(),
    targetId: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AuditLogEntry' });
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogPageSchema = z
  .object({
    items: z.array(auditLogEntrySchema),
    nextCursor: z.string().nullable().describe('Pass as `cursor` to get the next (older) page'),
  })
  .meta({ id: 'AuditLogPage' });

export const auditLogQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
