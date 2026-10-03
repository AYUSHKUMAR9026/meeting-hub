import { isAPIError } from 'better-auth/api';

import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../lib/errors';

/** Better Auth error codes we translate to our own stable codes (our codes are the API contract). */
const translated: Record<string, () => AppError> = {
  ORGANIZATION_ALREADY_EXISTS: () => new ConflictError('SLUG_TAKEN', 'That workspace URL is taken'),
  ORGANIZATION_SLUG_ALREADY_TAKEN: () =>
    new ConflictError('SLUG_TAKEN', 'That workspace URL is taken'),
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: () =>
    new ConflictError('ALREADY_MEMBER', 'That person is already a member of this workspace'),
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: () =>
    new ConflictError('ALREADY_INVITED', 'That person already has a pending invitation'),
  // Never confirm an invitation exists to anyone but its recipient.
  INVITATION_NOT_FOUND: () => new NotFoundError('Invitation not found'),
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: () => new NotFoundError('Invitation not found'),
  FAILED_TO_RETRIEVE_INVITATION: () => new NotFoundError('Invitation not found'),
  ORGANIZATION_NOT_FOUND: () => new NotFoundError(),
  MEMBER_NOT_FOUND: () => new NotFoundError('Member not found'),
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION: () =>
    new ForbiddenError('Verify your email address first', { code: 'EMAIL_NOT_VERIFIED' }),
  EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: () =>
    new ForbiddenError('Verify your email address first', { code: 'EMAIL_NOT_VERIFIED' }),
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: () =>
    new ConflictError('LAST_OWNER', 'A workspace must keep at least one owner'),
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER: () =>
    new ConflictError('LAST_OWNER', 'A workspace must keep at least one owner'),
  ORGANIZATION_MEMBERSHIP_LIMIT_REACHED: () =>
    new ConflictError('MEMBERSHIP_LIMIT_REACHED', 'This workspace has reached its member limit'),
  INVITATION_LIMIT_REACHED: () =>
    new ConflictError(
      'INVITATION_LIMIT_REACHED',
      'This workspace has too many pending invitations',
    ),
};

/**
 * Converts an error thrown by `auth.api.*` into an AppError. Our own checks run first, so these
 * mostly surface Better Auth's second line of defence or races; non-Better-Auth errors pass through.
 */
export function fromAuthError(err: unknown): unknown {
  if (!isAPIError(err)) return err;
  const code = (err.body as { code?: string } | undefined)?.code;
  const known = code ? translated[code] : undefined;
  if (known) return known();
  switch (err.statusCode) {
    case 401:
      return new UnauthorizedError();
    case 403:
      return new ForbiddenError();
    case 404:
      return new NotFoundError();
    default:
      return err.statusCode < 500
        ? new BadRequestError(err.message || 'Request rejected', { cause: err })
        : new AppError('AUTH_PROVIDER_ERROR', 'Authentication service error', { cause: err });
  }
}

/** Runs a Better Auth call and rethrows its errors as AppErrors. */
export async function callAuth<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw fromAuthError(err);
  }
}
