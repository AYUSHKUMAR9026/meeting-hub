import { z } from 'zod';

export const workspaceRoleSchema = z
  .enum(['owner', 'admin', 'member', 'viewer'])
  .meta({ id: 'WorkspaceRole' });
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

const timeZones = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);

export const timezoneSchema = z
  .string()
  .refine((tz) => timeZones.has(tz), 'must be an IANA time zone, e.g. Europe/Berlin')
  .describe('IANA time zone');

export const slugSchema = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and single dashes only');

const nameSchema = z.string().trim().min(1).max(80);

export const workspaceParamsSchema = z.object({ wid: z.uuid() });

export const workspaceSummarySchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    role: workspaceRoleSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'WorkspaceSummary' });
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const workspaceListSchema = z
  .object({ workspaces: z.array(workspaceSummarySchema) })
  .meta({ id: 'WorkspaceList' });

export const workspaceSettingsSchema = z
  .object({
    timezone: timezoneSchema,
    retentionDays: z.int().min(1).max(3650),
    glossary: z.array(z.string().trim().min(1).max(100)).max(500),
  })
  .meta({ id: 'WorkspaceSettings' });
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const workspaceSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    createdAt: z.iso.datetime(),
    role: workspaceRoleSchema.describe("The caller's role"),
    permissions: z
      .array(z.string())
      .describe("Actions the caller's role allows; use to hide UI, never to enforce"),
    features: z
      .array(z.string())
      .describe(
        'Client-visible feature flags that are on for this workspace, e.g. meetings.upload',
      ),
    settings: workspaceSettingsSchema,
  })
  .meta({ id: 'Workspace' });
export type Workspace = z.infer<typeof workspaceSchema>;

export const createWorkspaceRequestSchema = z
  .object({
    name: nameSchema,
    slug: slugSchema.optional().describe('URL slug; generated from the name when omitted'),
    timezone: timezoneSchema.optional(),
  })
  .meta({ id: 'CreateWorkspaceRequest' });

export const updateWorkspaceRequestSchema = z
  .object({
    name: nameSchema.optional(),
    settings: workspaceSettingsSchema.partial().optional(),
  })
  .refine((v) => v.name !== undefined || v.settings !== undefined, 'nothing to update')
  .meta({ id: 'UpdateWorkspaceRequest' });

export const memberSchema = z
  .object({
    userId: z.uuid(),
    name: z.string(),
    email: z.email(),
    image: z.string().nullable(),
    role: workspaceRoleSchema,
    joinedAt: z.iso.datetime(),
  })
  .meta({ id: 'Member' });
export type Member = z.infer<typeof memberSchema>;

export const memberListSchema = z
  .object({ members: z.array(memberSchema) })
  .meta({ id: 'MemberList' });

export const memberParamsSchema = z.object({ wid: z.uuid(), userId: z.uuid() });

export const updateMemberRequestSchema = z
  .object({ role: workspaceRoleSchema })
  .meta({ id: 'UpdateMemberRequest' });

export const invitationSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    role: workspaceRoleSchema,
    status: z.string(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    inviterId: z.uuid(),
  })
  .meta({ id: 'Invitation' });
export type Invitation = z.infer<typeof invitationSchema>;

export const invitationListSchema = z
  .object({ invitations: z.array(invitationSchema) })
  .meta({ id: 'InvitationList' });

export const createInvitationRequestSchema = z
  .object({ email: z.email(), role: workspaceRoleSchema.default('member') })
  .meta({ id: 'CreateInvitationRequest' });

export const invitationParamsSchema = z.object({ wid: z.uuid(), id: z.uuid() });

export const invitationIdParamsSchema = z.object({ id: z.uuid() });

export const invitationDetailsSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    role: workspaceRoleSchema,
    status: z.string(),
    expiresAt: z.iso.datetime(),
    workspaceName: z.string(),
    inviterEmail: z.email(),
  })
  .meta({ id: 'InvitationDetails' });
export type InvitationDetails = z.infer<typeof invitationDetailsSchema>;

export const acceptInvitationResponseSchema = z
  .object({ workspace: workspaceSummarySchema })
  .meta({ id: 'AcceptInvitationResponse' });
