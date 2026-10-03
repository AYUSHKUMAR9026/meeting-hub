import { describe, expect, it } from 'vitest';

import { AppError } from '../src/lib/errors';
import {
  accessControlRoles,
  actions,
  assertNoViolation,
  authorize,
  canGrantRole,
  checkMembershipChange,
  permissionMatrix,
  permissionsFor,
  roleCan,
  type WorkspaceRole,
  workspaceRoles,
} from '../src/modules/auth';

const actor = (role: WorkspaceRole, userId = 'actor') => ({ userId, workspaceId: 'w1', role });

function errorOf(fn: () => void): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected an AppError');
}

describe('permission matrix', () => {
  // A readable snapshot of the matrix: changing a permission must change this test on purpose.
  it('grants exactly these actions per role', () => {
    expect(Object.fromEntries(workspaceRoles.map((r) => [r, permissionsFor(r)]))).toEqual({
      owner: actions,
      admin: actions.filter((a) => a !== 'workspace.delete'),
      member: ['workspace.read', 'member.read', 'people.read', 'people.create', 'people.update'],
      viewer: ['workspace.read', 'member.read', 'people.read'],
    });
  });

  it('is monotonic: a higher role can do everything a lower role can', () => {
    for (const action of actions) {
      const allowed = workspaceRoles.map((r) => roleCan(r, action)); // owner → viewer
      const firstDenied = allowed.indexOf(false);
      if (firstDenied >= 0) expect(allowed.slice(firstDenied)).not.toContain(true);
    }
  });

  it('only lets owners and admins read the audit log', () => {
    expect(permissionMatrix['audit.read']).toEqual(['owner', 'admin']);
  });
});

describe('authorize', () => {
  it('allows actions in the matrix', () => {
    expect(() => authorize(actor('viewer'), 'people.read')).not.toThrow();
    expect(() => authorize(actor('admin'), 'member.remove')).not.toThrow();
  });

  it('returns 403 FORBIDDEN for members whose role lacks the action', () => {
    const err = errorOf(() => authorize(actor('member'), 'member.remove'));
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('returns 404 for resources in another workspace, even for owners', () => {
    const err = errorOf(() => authorize(actor('owner'), 'people.read', { workspaceId: 'w2' }));
    expect(err).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});

describe('Better Auth access control is derived from the matrix', () => {
  it('defines a role for every workspace role, including viewer', () => {
    expect(Object.keys(accessControlRoles).sort()).toEqual([...workspaceRoles].sort());
  });

  it.each([
    ['owner', { organization: ['update', 'delete'] }, true],
    ['admin', { organization: ['update'] }, true],
    ['admin', { organization: ['delete'] }, false],
    ['admin', { member: ['update', 'delete'], invitation: ['create', 'cancel'] }, true],
    ['member', { invitation: ['create'] }, false],
    ['member', { people: ['create', 'update'] }, true],
    ['viewer', { people: ['create'] }, false],
    ['viewer', { people: ['read'], workspace: ['read'] }, true],
  ] as const)('%s can %j → %s', (role, request, expected) => {
    expect(accessControlRoles[role].authorize(request).success).toBe(expected);
  });
});

describe('role escalation', () => {
  it.each([
    ['owner', 'owner', true],
    ['admin', 'admin', true],
    ['admin', 'owner', false],
    ['member', 'admin', false],
    ['member', 'viewer', true],
  ] as const)('%s granting %s → %s', (actorRole, role, expected) => {
    expect(canGrantRole(actorRole, role)).toBe(expected);
  });

  it('blocks inviting above your own role', () => {
    expect(
      checkMembershipChange({
        actor: actor('admin'),
        change: { kind: 'invite', role: 'owner' },
        ownerCount: 1,
      }),
    ).toBe('ROLE_ESCALATION');
  });

  it('blocks promoting someone above your own role', () => {
    expect(
      checkMembershipChange({
        actor: actor('admin'),
        target: { userId: 't', role: 'member' },
        change: { kind: 'change_role', newRole: 'owner' },
        ownerCount: 1,
      }),
    ).toBe('ROLE_ESCALATION');
  });

  it('stops admins from changing or removing owners', () => {
    const target = { userId: 't', role: 'owner' } as const;
    for (const change of [{ kind: 'remove' }, { kind: 'change_role', newRole: 'admin' }] as const) {
      expect(checkMembershipChange({ actor: actor('admin'), target, change, ownerCount: 2 })).toBe(
        'CANNOT_MODIFY_OWNER',
      );
    }
  });

  it('lets admins manage other admins and below', () => {
    expect(
      checkMembershipChange({
        actor: actor('admin'),
        target: { userId: 't', role: 'admin' },
        change: { kind: 'change_role', newRole: 'viewer' },
        ownerCount: 1,
      }),
    ).toBeNull();
  });
});

describe('last owner', () => {
  const owner = actor('owner', 'o1');

  it('cannot leave', () => {
    expect(
      checkMembershipChange({
        actor: owner,
        target: owner,
        change: { kind: 'remove' },
        ownerCount: 1,
      }),
    ).toBe('LAST_OWNER');
  });

  it('cannot be demoted, even by themselves', () => {
    expect(
      checkMembershipChange({
        actor: owner,
        target: owner,
        change: { kind: 'change_role', newRole: 'admin' },
        ownerCount: 1,
      }),
    ).toBe('LAST_OWNER');
  });

  it('can leave or be demoted once there is another owner', () => {
    const other = { userId: 'o2', role: 'owner' } as const;
    expect(
      checkMembershipChange({
        actor: owner,
        target: owner,
        change: { kind: 'remove' },
        ownerCount: 2,
      }),
    ).toBeNull();
    expect(
      checkMembershipChange({
        actor: owner,
        target: other,
        change: { kind: 'change_role', newRole: 'member' },
        ownerCount: 2,
      }),
    ).toBeNull();
  });

  it('non-owners may always leave', () => {
    const viewer = actor('viewer', 'v1');
    expect(
      checkMembershipChange({
        actor: viewer,
        target: viewer,
        change: { kind: 'remove' },
        ownerCount: 1,
      }),
    ).toBeNull();
  });
});

describe('assertNoViolation', () => {
  it('maps LAST_OWNER to 409 and permission rules to 403 with their code', () => {
    expect(errorOf(() => assertNoViolation('LAST_OWNER'))).toMatchObject({
      status: 409,
      code: 'LAST_OWNER',
    });
    expect(errorOf(() => assertNoViolation('ROLE_ESCALATION'))).toMatchObject({
      status: 403,
      code: 'ROLE_ESCALATION',
    });
    expect(() => assertNoViolation(null)).not.toThrow();
  });
});
