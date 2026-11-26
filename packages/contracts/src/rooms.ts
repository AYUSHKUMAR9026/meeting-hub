import { z } from 'zod';

export const roomStartSchema = z.object({ recordingEnabled: z.boolean().default(true) });
export const roomJoinSchema = z.object({ consentAcknowledged: z.boolean() });
export const roomTokenSchema = z.object({ url: z.string(), token: z.string() });
export const roomViewSchema = z.object({
  status: z.enum(['none', 'scheduled', 'live', 'ended']),
  recordingEnabled: z.boolean(),
  canHost: z.boolean(),
  canJoin: z.boolean(),
  recordingStatus: z.enum(['off', 'pending', 'active', 'done', 'failed']),
  present: z.array(z.object({ userId: z.uuid(), name: z.string() })),
});

export type RoomView = z.infer<typeof roomViewSchema>;

export const roomMessageRequestSchema = z
  .object({ clientId: z.string().min(1).max(200), text: z.string().trim().min(1).max(4000) })
  .meta({ id: 'RoomMessageRequest' });
export const roomMessageListSchema = z
  .object({
    messages: z.array(
      z.object({
        id: z.uuid(),
        userId: z.uuid(),
        name: z.string(),
        text: z.string(),
        createdAt: z.iso.datetime(),
      }),
    ),
  })
  .meta({ id: 'RoomMessageList' });
