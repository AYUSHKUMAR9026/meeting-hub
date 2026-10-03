'use client';

import { createContext, type ReactNode, use } from 'react';

import type { User, Workspace, WorkspaceRole } from '@/lib/api/client';

const WorkspaceContext = createContext<{ workspace: Workspace; user: User } | null>(null);

export function WorkspaceProvider({
  workspace,
  user,
  children,
}: {
  workspace: Workspace;
  user: User;
  children: ReactNode;
}) {
  return <WorkspaceContext value={{ workspace, user }}>{children}</WorkspaceContext>;
}

function useWorkspaceContext() {
  const value = use(WorkspaceContext);
  if (!value) throw new Error('workspace hooks must be used inside /w/[slug]');
  return value;
}

export const useWorkspace = (): Workspace => useWorkspaceContext().workspace;
export const useCurrentUser = (): User => useWorkspaceContext().user;

/**
 * Whether the current role allows an action. For hiding controls only — the API enforces
 * every permission itself.
 */
export function useCan() {
  const { permissions } = useWorkspace();
  return (action: string) => permissions.includes(action);
}

export const roleRank: Record<WorkspaceRole, number> = { viewer: 1, member: 2, admin: 3, owner: 4 };
export const roles: WorkspaceRole[] = ['owner', 'admin', 'member', 'viewer'];

/** Roles the current user may grant (never above their own). */
export const grantableRoles = (myRole: WorkspaceRole) =>
  roles.filter((r) => roleRank[r] <= roleRank[myRole]);
