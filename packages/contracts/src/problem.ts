import { z } from 'zod';

/**
 * RFC 9457 problem details, returned as `application/problem+json` for every error.
 * `code` is a stable, machine-readable identifier clients may switch on.
 */
export const problemSchema = z
  .object({
    type: z.string().describe('URI reference identifying the problem type'),
    title: z.string(),
    status: z.number().int(),
    code: z.string().describe('Stable machine-readable error code, e.g. VALIDATION_FAILED'),
    detail: z.string().optional(),
    instance: z.string().optional(),
    requestId: z.string().optional(),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .describe('Field-level validation errors'),
  })
  .meta({ id: 'Problem' });

export type Problem = z.infer<typeof problemSchema>;
