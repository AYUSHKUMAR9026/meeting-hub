/**
 * THE permission matrix: which workspace role may perform which action. Data only.
 *
 * Every `/v1` workspace route declares one of these actions; `authorize()` and Better Auth's
 * access-control roles are both derived from this table, and the authorization matrix test
 * (test/authorization-matrix.int.test.ts) checks every route against it. Changing a cell here changes
 * behaviour everywhere at once — review it like a schema change.
 */
export const workspaceRoles = ['owner', 'admin', 'member', 'viewer'] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

export const isWorkspaceRole = (value: string): value is WorkspaceRole =>
  (workspaceRoles as readonly string[]).includes(value);

/** Higher number = more privileged. Used for the "no granting above your own role" rule. */
export const roleRank: Record<WorkspaceRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };

const ALL: readonly WorkspaceRole[] = workspaceRoles;
const MANAGERS: readonly WorkspaceRole[] = ['owner', 'admin'];
const CONTRIBUTORS: readonly WorkspaceRole[] = ['owner', 'admin', 'member'];

export const permissionMatrix = {
  'workspace.read': ALL,
  'workspace.update': MANAGERS,
  'workspace.delete': ['owner'],
  'member.read': ALL,
  'member.update': MANAGERS,
  'member.remove': MANAGERS,
  'invitation.read': MANAGERS,
  'invitation.create': MANAGERS,
  'invitation.cancel': MANAGERS,
  'people.read': ALL,
  'people.create': CONTRIBUTORS,
  'people.update': CONTRIBUTORS,
  'people.delete': MANAGERS,
  'audit.read': MANAGERS,
  'meeting.read': ALL,
  'meeting.create': CONTRIBUTORS,
  // Members may only edit / upload to meetings they created (see meeting-rules.ts).
  'meeting.update': CONTRIBUTORS,
  'meeting.update_any': MANAGERS,
  'meeting.delete': MANAGERS,
  'recording.upload': CONTRIBUTORS,
  'recording.download': MANAGERS,
} as const satisfies Record<string, readonly WorkspaceRole[]>;

export type Action = keyof typeof permissionMatrix;
export const actions = Object.keys(permissionMatrix) as Action[];

export function roleCan(role: WorkspaceRole, action: Action): boolean {
  return (permissionMatrix[action] as readonly WorkspaceRole[]).includes(role);
}

/** Every action a role may perform; sent to the UI so it can hide controls (the server still enforces). */
export function permissionsFor(role: WorkspaceRole): Action[] {
  return actions.filter((action) => roleCan(role, action));
}
