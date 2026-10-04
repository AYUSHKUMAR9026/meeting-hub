/**
 * Better Auth access control, derived from our permission matrix so the two can never disagree.
 * Better Auth checks these statements inside its organization endpoints (a second line of defence;
 * our own `authorize()` runs first in every route).
 */
import { createAccessControl } from 'better-auth/plugins/access';

import { type Action, roleCan, type WorkspaceRole } from './permissions';

/**
 * Better Auth's statements (resource → actions) and which of our actions grants each.
 * `organization` is Better Auth's name for a workspace.
 */
const statementSources = {
  organization: { update: 'workspace.update', delete: 'workspace.delete' },
  member: { create: 'invitation.create', update: 'member.update', delete: 'member.remove' },
  invitation: { create: 'invitation.create', cancel: 'invitation.cancel' },
  // Not used by Better Auth itself; declared so the whole matrix is visible to its access control.
  workspace: { read: 'workspace.read' },
  people: {
    read: 'people.read',
    create: 'people.create',
    update: 'people.update',
    delete: 'people.delete',
  },
  audit: { read: 'audit.read' },
  meeting: {
    read: 'meeting.read',
    create: 'meeting.create',
    update: 'meeting.update',
    updateAny: 'meeting.update_any',
    delete: 'meeting.delete',
  },
  recording: { upload: 'recording.upload', download: 'recording.download' },
  processing: {
    reprocess: 'processing.reprocess',
    viewErrorDetail: 'processing.view_error_detail',
  },
} as const satisfies Record<string, Record<string, Action>>;

type Statements = { [R in keyof typeof statementSources]: (keyof (typeof statementSources)[R])[] };

const statements = Object.fromEntries(
  Object.entries(statementSources).map(([resource, acts]) => [resource, Object.keys(acts)]),
) as Statements;

export const accessControl = createAccessControl(statements);

function statementsFor(role: WorkspaceRole): Statements {
  return Object.fromEntries(
    Object.entries(statementSources).map(([resource, acts]) => [
      resource,
      Object.entries(acts)
        .filter(([, action]) => roleCan(role, action as Action))
        .map(([act]) => act),
    ]),
  ) as Statements;
}

const roleFor = (role: WorkspaceRole) => accessControl.newRole(statementsFor(role));

export const accessControlRoles = {
  owner: roleFor('owner'),
  admin: roleFor('admin'),
  member: roleFor('member'),
  viewer: roleFor('viewer'),
} satisfies Record<WorkspaceRole, unknown>;
