// Public API of the workspaces module. A workspace is a Better Auth "organization" (ADR 0002).
import type { Database } from '../../lib/db';
import type { AuditService } from '../audit';
import type { Auth } from '../auth';
import type { PeopleService } from '../people';
import type { FeatureFlagService } from '../platform';
import { WorkspaceRepository } from './workspace-repository';
import { WorkspaceService } from './workspace-service';

export { requireWorkspace, workspaceFromParam, type WorkspaceResolver } from './require-workspace';
export {
  DEFAULT_SETTINGS,
  type InvitationView,
  type MemberView,
  type WorkspaceSettings,
  type WorkspaceSummary,
} from './workspace-repository';
export {
  type CallerContext,
  type InvitationDetails,
  isValidSlug,
  slugify,
  type WorkspaceView,
  WorkspaceService,
} from './workspace-service';

export function createWorkspaceService(deps: {
  db: Database;
  auth: Auth;
  people: PeopleService;
  audit: AuditService;
  flags: FeatureFlagService;
}): WorkspaceService {
  return new WorkspaceService({ ...deps, repo: new WorkspaceRepository(deps.db) });
}
