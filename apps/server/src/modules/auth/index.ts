// Public API of the auth module: Better Auth instance, sessions, and authorization.
export { callAuth, fromAuthError } from './auth-errors';
export { accessControlRoles } from './authorization/access-control';
export {
  authorize,
  type AuthorizationResource,
  type WorkspaceActor,
} from './authorization/authorize';
export {
  assertCanModifyMeeting,
  canModifyMeeting,
  type MeetingRef,
} from './authorization/meeting-rules';
export {
  type Action,
  actions,
  isWorkspaceRole,
  permissionMatrix,
  permissionsFor,
  roleCan,
  roleRank,
  type WorkspaceRole,
  workspaceRoles,
} from './authorization/permissions';
export {
  assertNoViolation,
  canGrantRole,
  checkMembershipChange,
  type MemberRef,
  type MembershipChange,
  type RoleRuleViolation,
} from './authorization/role-rules';
export { type Auth, AUTH_BASE_PATH, type AuthDeps, createAuth } from './better-auth';
export {
  bindLogContext,
  type CurrentUser,
  currentUserOf,
  requireSession,
  resolveSession,
  toFetchHeaders,
  workspaceActorOf,
} from './session';
