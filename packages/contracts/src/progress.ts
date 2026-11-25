import { z } from 'zod';

export const progressQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    bucket: z.enum(['day', 'week']).default('day'),
    ownerPersonId: z.uuid().optional(),
    meetingId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine(
    (q) =>
      !q.from ||
      !q.to ||
      (q.from <= q.to && (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < 366),
    'Date range must be ordered and at most 366 days.',
  );

export const progressTotalsSchema = z
  .object({
    open: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    overdue: z.number().int().nonnegative(),
    proposed: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    decisionsProposed: z.number().int().nonnegative(),
    decisionsConfirmed: z.number().int().nonnegative(),
    meetings: z.number().int().nonnegative(),
    completionRate: z.number(),
  })
  .meta({ id: 'ProgressTotals' });
export const progressSummarySchema = z
  .object({
    timezone: z.string(),
    today: z.iso.date(),
    totals: progressTotalsSchema,
    change: z
      .object({
        open: z.number(),
        done: z.number(),
        overdue: z.number(),
        completionRate: z.number(),
      })
      .nullable(),
    comparisonDate: z.iso.date().nullable(),
  })
  .meta({ id: 'ProgressSummary' });
export const progressSeriesSchema = z
  .object({
    timezone: z.string(),
    points: z.array(
      z.object({
        date: z.iso.date(),
        open: z.number(),
        done: z.number(),
        overdue: z.number(),
        decisionsProposed: z.number(),
        decisionsConfirmed: z.number(),
        meetings: z.number(),
        backfilled: z.boolean(),
      }),
    ),
  })
  .meta({ id: 'ProgressSeries' });
export const progressOwnersSchema = z
  .object({
    truncated: z.boolean(),
    owners: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        ownerPersonId: z.uuid().nullable(),
        ownerSpeakerId: z.uuid().nullable(),
        open: z.number(),
        done: z.number(),
        overdue: z.number(),
      }),
    ),
  })
  .meta({ id: 'ProgressOwners' });
export const progressMeetingsSchema = z
  .object({
    meetings: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        occurredAt: z.iso.datetime(),
        open: z.number(),
        done: z.number(),
        overdue: z.number(),
        decisions: z.number(),
        items: z.number(),
        completionRate: z.number(),
      }),
    ),
  })
  .meta({ id: 'ProgressMeetings' });
export const progressRecapSchema = z
  .object({
    recap: progressMeetingsSchema.shape.meetings.element,
    items: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        meetingId: z.uuid(),
        status: z.string(),
        dueDate: z.iso.date().nullable(),
      }),
    ),
    carriedOver: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        meetingId: z.uuid(),
        status: z.string(),
        dueDate: z.iso.date().nullable(),
      }),
    ),
    truncated: z.boolean(),
  })
  .meta({ id: 'ProgressRecap' });
export type ProgressQuery = z.infer<typeof progressQuerySchema>;
export type ProgressTotals = z.infer<typeof progressTotalsSchema>;
