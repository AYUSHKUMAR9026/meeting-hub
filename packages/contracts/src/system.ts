import { z } from 'zod';

export const healthResponseSchema = z
  .object({
    status: z.literal('ok'),
    uptimeSeconds: z.number(),
  })
  .meta({ id: 'HealthResponse' });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const dependencyNames = ['postgres', 'redis', 's3'] as const;
export const dependencyNameSchema = z.enum(dependencyNames);
export type DependencyName = z.infer<typeof dependencyNameSchema>;

export const dependencyCheckSchema = z
  .object({
    status: z.enum(['up', 'down']),
    latencyMs: z.number(),
    error: z.string().optional(),
  })
  .meta({ id: 'DependencyCheck' });
export type DependencyCheck = z.infer<typeof dependencyCheckSchema>;

export const readyResponseSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.object({
      postgres: dependencyCheckSchema,
      redis: dependencyCheckSchema,
      s3: dependencyCheckSchema,
    }),
  })
  .meta({ id: 'ReadyResponse' });
export type ReadyResponse = z.infer<typeof readyResponseSchema>;

export const flagSourceSchema = z.enum(['override', 'database', 'default']);

export const evaluatedFlagSchema = z
  .object({
    key: z.string(),
    enabled: z.boolean(),
    source: flagSourceSchema,
  })
  .meta({ id: 'EvaluatedFlag' });
export type EvaluatedFlag = z.infer<typeof evaluatedFlagSchema>;

export const flagsResponseSchema = z
  .object({ flags: z.array(evaluatedFlagSchema) })
  .meta({ id: 'FlagsResponse' });
export type FlagsResponse = z.infer<typeof flagsResponseSchema>;
