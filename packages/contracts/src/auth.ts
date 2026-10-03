import { z } from 'zod';

export const userSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable(),
  })
  .meta({ id: 'User' });
export type User = z.infer<typeof userSchema>;

export const meResponseSchema = z.object({ user: userSchema }).meta({ id: 'MeResponse' });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const authProvidersResponseSchema = z
  .object({
    emailPassword: z.literal(true),
    google: z.boolean().describe('Google sign-in is configured and enabled'),
  })
  .meta({ id: 'AuthProvidersResponse' });
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;
