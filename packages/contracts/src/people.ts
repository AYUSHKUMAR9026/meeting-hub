import { z } from 'zod';

const aliasesSchema = z.array(z.string().trim().min(1).max(120)).max(20);

export const personSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string(),
    email: z.email().nullable(),
    userId: z.uuid().nullable().describe('Set when this person is a Meeting Hub user'),
    aliases: z.array(z.string()),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Person' });
export type Person = z.infer<typeof personSchema>;

export const personListSchema = z
  .object({ people: z.array(personSchema) })
  .meta({ id: 'PersonList' });

export const peopleQuerySchema = z.object({
  q: z.string().trim().max(120).optional().describe('Fuzzy search on name, email and aliases'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const createPersonRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    email: z.email().nullable().optional(),
    aliases: aliasesSchema.optional(),
  })
  .meta({ id: 'CreatePersonRequest' });

export const updatePersonRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(120).optional(),
    email: z.email().nullable().optional(),
    aliases: aliasesSchema.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'nothing to update')
  .meta({ id: 'UpdatePersonRequest' });

export const personParamsSchema = z.object({ id: z.uuid() });
