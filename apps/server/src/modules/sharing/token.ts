import { createHash, randomBytes } from 'node:crypto';

import { BadRequestError } from '../../lib/errors';

export const isShareToken = (token: string) => /^[A-Za-z0-9_-]{43}$/.test(token);
export const createShareToken = () => randomBytes(32).toString('base64url');
export const hashShareToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export function shareExpiry(now: Date, days: number, maxDays: number): Date {
  const limit = Math.min(90, maxDays);
  if (!Number.isInteger(days) || days < 1 || days > limit) {
    throw new BadRequestError(`A share link must expire in 1 to ${limit} days.`);
  }
  return new Date(now.getTime() + days * 86_400_000);
}

/** Surface only public meeting content, including removing addresses embedded in content. */
export function publicText(content: string): string {
  return content.replace(
    /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
    '[email removed]',
  );
}
