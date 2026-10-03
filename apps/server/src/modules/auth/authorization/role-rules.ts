/**
 * Relationship rules the permission matrix can't express. Pure functions; the workspaces module
 * calls them before asking Better Auth to change a membership.
 */
import { ConflictError, ForbiddenError } from '../../../lib/errors';
import { roleRank, type WorkspaceRole } from './permissions';

export interface MemberRef {
  userId: string;
  role: WorkspaceRole;
}

export type MembershipChange =
  | { kind: 'change_role'; newRole: WorkspaceRole }
  | { kind: 'remove' }
  | { kind: 'invite'; role: WorkspaceRole };

export type RoleRuleViolation = 'ROLE_ESCALATION' | 'CANNOT_MODIFY_OWNER' | 'LAST_OWNER';

/** Nobody can grant a role higher than their own. */
export const canGrantRole = (actorRole: WorkspaceRole, role: WorkspaceRole): boolean =>
  roleRank[role] <= roleRank[actorRole];

/**
 * Returns the rule a membership change would break, or null if it is allowed.
 * `ownerCount` is the number of owners in the workspace before the change.
 * Assumes the matrix check already passed (except for leaving, which anyone may do).
 */
export function checkMembershipChange(input: {
  actor: MemberRef;
  target?: MemberRef;
  change: MembershipChange;
  ownerCount: number;
}): RoleRuleViolation | null {
  const { actor, target, change, ownerCount } = input;

  if (change.kind === 'invite') {
    return canGrantRole(actor.role, change.role) ? null : 'ROLE_ESCALATION';
  }
  if (!target) throw new Error('target is required for change_role and remove');

  const isSelf = actor.userId === target.userId;
  const targetIsLastOwner = target.role === 'owner' && ownerCount <= 1;

  if (!isSelf && actor.role === 'admin' && target.role === 'owner') return 'CANNOT_MODIFY_OWNER';

  if (change.kind === 'change_role') {
    if (!canGrantRole(actor.role, change.newRole)) return 'ROLE_ESCALATION';
    if (targetIsLastOwner && change.newRole !== 'owner') return 'LAST_OWNER';
    return null;
  }

  // remove (or leave, when isSelf)
  return targetIsLastOwner ? 'LAST_OWNER' : null;
}

const messages: Record<RoleRuleViolation, string> = {
  ROLE_ESCALATION: 'You cannot grant a role higher than your own',
  CANNOT_MODIFY_OWNER: 'Admins cannot change or remove an owner',
  LAST_OWNER: 'A workspace must keep at least one owner',
};

/** Throws the API error for a violation (403 for permission rules, 409 for the last-owner rule). */
export function assertNoViolation(violation: RoleRuleViolation | null): void {
  if (!violation) return;
  if (violation === 'LAST_OWNER') throw new ConflictError(violation, messages[violation]);
  throw new ForbiddenError(messages[violation], { code: violation });
}
