import { describe, expect, it } from 'vitest';

import {
  attachmentDisposition,
  firstBatch,
  MAX_PARTS,
  meetingPrefix,
  MIN_PART_SIZE,
  originalRecordingKey,
  planUpload,
  validateCompletedParts,
} from '../src/modules/media';

const MiB = 1024 * 1024;
const WS = '0199a1b2-0000-7000-8000-000000000001';
const MEETING = '0199a1b2-0000-7000-8000-000000000002';

describe('storage keys', () => {
  it('builds ws/{wid}/meetings/{mid}/original/{uuid} with a fresh uuid each time', () => {
    const a = originalRecordingKey(WS, MEETING);
    const b = originalRecordingKey(WS, MEETING);
    expect(a).toMatch(new RegExp(`^ws/${WS}/meetings/${MEETING}/original/[0-9a-f-]{36}$`));
    expect(a).not.toBe(b);
    expect(a.startsWith(meetingPrefix(WS, MEETING))).toBe(true);
  });

  it('refuses anything but UUIDs, so user input can never reach a key', () => {
    expect(() => originalRecordingKey('../etc', MEETING)).toThrow(/UUID/);
    expect(() => meetingPrefix(WS, 'my meeting.mp3')).toThrow(/UUID/);
  });
});

describe('planUpload', () => {
  it('splits into parts of the configured size with a smaller last part', () => {
    expect(planUpload(11 * MiB, 5 * MiB)).toEqual({ partSize: 5 * MiB, partCount: 3 });
    expect(planUpload(10 * MiB, 5 * MiB)).toEqual({ partSize: 5 * MiB, partCount: 2 });
    expect(planUpload(1, 16 * MiB)).toEqual({ partSize: 16 * MiB, partCount: 1 });
  });

  it('never goes below the S3 minimum part size', () => {
    expect(planUpload(20 * MiB, 1024).partSize).toBe(MIN_PART_SIZE);
  });

  it('grows the part size to stay within 10,000 parts', () => {
    const plan = planUpload(100 * 1024 ** 3, 5 * MiB);
    expect(plan.partCount).toBeLessThanOrEqual(MAX_PARTS);
    expect(plan.partSize * plan.partCount).toBeGreaterThanOrEqual(100 * 1024 ** 3);
  });

  it('plans a 2 GiB upload at the default 16 MiB in 128 parts', () => {
    expect(planUpload(2 * 1024 ** 3, 16 * MiB)).toEqual({ partSize: 16 * MiB, partCount: 128 });
  });

  it('rejects non-positive sizes', () => {
    expect(() => planUpload(0, 5 * MiB)).toThrow(RangeError);
  });
});

describe('firstBatch', () => {
  it('returns at most the batch size of part numbers, starting at 1', () => {
    expect(firstBatch(3, 10)).toEqual([1, 2, 3]);
    expect(firstBatch(128, 10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('validateCompletedParts', () => {
  const p = (...numbers: number[]) =>
    numbers.map((partNumber) => ({ partNumber, etag: `"${partNumber}"` }));

  it('accepts every part exactly once, in any order, and sorts them', () => {
    expect(validateCompletedParts(p(3, 1, 2), 3)).toEqual({ ok: true, parts: p(1, 2, 3) });
  });

  it('rejects missing, extra, duplicate or out-of-range parts', () => {
    expect(validateCompletedParts(p(1, 2), 3).ok).toBe(false);
    expect(validateCompletedParts(p(1, 2, 3, 4), 3).ok).toBe(false);
    expect(validateCompletedParts(p(1, 1, 3), 3).ok).toBe(false);
    expect(validateCompletedParts(p(2, 3, 4), 3).ok).toBe(false);
  });
});

describe('attachmentDisposition', () => {
  it('always says attachment and encodes the exact name per RFC 5987', () => {
    expect(attachmentDisposition('Sync “Q4” é.mp3')).toBe(
      `attachment; filename="Sync _Q4_ _.mp3"; filename*=UTF-8''Sync%20%E2%80%9CQ4%E2%80%9D%20%C3%A9.mp3`,
    );
  });

  it('cannot be broken out of with quotes or newlines', () => {
    const header = attachmentDisposition('a"; filename="evil.html\r\nX: y');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.startsWith('attachment; filename="a_; filename=_evil.html__X: y"')).toBe(true);
  });
});
