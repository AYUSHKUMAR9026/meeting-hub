import { describe, expect, it } from 'vitest';

import {
  completeUploadRequestSchema,
  contentTypeForFile,
  createMeetingRequestSchema,
  isAllowedUploadType,
  meetingsQuerySchema,
  presignPartsRequestSchema,
  startUploadRequestSchema,
  updateMeetingRequestSchema,
  uploadAcceptAttribute,
} from './meetings';

describe('upload types', () => {
  it('allows common audio and video types, case-insensitively', () => {
    for (const type of ['audio/mpeg', 'audio/x-m4a', 'audio/wav', 'audio/ogg', 'audio/opus']) {
      expect(isAllowedUploadType(type)).toBe(true);
    }
    expect(isAllowedUploadType('VIDEO/MP4')).toBe(true);
    expect(isAllowedUploadType('video/quicktime')).toBe(true);
  });

  it('rejects everything else', () => {
    for (const type of ['application/pdf', 'image/png', 'text/plain', '', 'audio/']) {
      expect(isAllowedUploadType(type)).toBe(false);
    }
  });

  it('uses the browser type when allowed, else infers it from the extension', () => {
    expect(contentTypeForFile({ name: 'a.bin', type: 'audio/mpeg' })).toBe('audio/mpeg');
    expect(contentTypeForFile({ name: 'Standup.M4A', type: '' })).toBe('audio/mp4');
    expect(contentTypeForFile({ name: 'call.mov', type: 'application/octet-stream' })).toBe(
      'video/quicktime',
    );
    expect(contentTypeForFile({ name: 'notes.pdf', type: 'application/pdf' })).toBeNull();
    expect(contentTypeForFile({ name: 'noextension', type: '' })).toBeNull();
  });

  it('builds an accept attribute with types and extensions', () => {
    expect(uploadAcceptAttribute).toContain('audio/mpeg');
    expect(uploadAcceptAttribute).toContain('.mov');
    expect(uploadAcceptAttribute.split(',').filter((x) => x === '.wav')).toHaveLength(1);
  });
});

describe('meeting requests', () => {
  const id = '0199a1b2-0000-7000-8000-000000000001';

  it('requires a title and an ISO date with offset', () => {
    expect(
      createMeetingRequestSchema.safeParse({ title: ' Sync ', occurredAt: '2026-10-03T09:00:00Z' })
        .data,
    ).toEqual({ title: 'Sync', occurredAt: '2026-10-03T09:00:00Z', participantIds: [] });
    expect(
      createMeetingRequestSchema.safeParse({ title: '', occurredAt: 'yesterday' }).success,
    ).toBe(false);
  });

  it('rejects repeated participants and empty updates', () => {
    expect(
      createMeetingRequestSchema.safeParse({
        title: 'x',
        occurredAt: '2026-10-03T09:00:00+02:00',
        participantIds: [id, id],
      }).success,
    ).toBe(false);
    expect(updateMeetingRequestSchema.safeParse({}).success).toBe(false);
    expect(updateMeetingRequestSchema.safeParse({ participantIds: [] }).success).toBe(true);
  });

  it('validates list filters', () => {
    expect(meetingsQuerySchema.parse({}).limit).toBe(25);
    expect(
      meetingsQuerySchema.safeParse({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(meetingsQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
  });
});

describe('upload requests', () => {
  const start = {
    fileName: 'a.mp3',
    contentType: 'audio/mpeg',
    sizeBytes: 10,
    consentConfirmed: true,
  };

  it('requires explicit consent', () => {
    expect(startUploadRequestSchema.safeParse(start).success).toBe(true);
    expect(startUploadRequestSchema.safeParse({ ...start, consentConfirmed: false }).success).toBe(
      false,
    );
    const { consentConfirmed: _, ...withoutConsent } = start;
    expect(startUploadRequestSchema.safeParse(withoutConsent).success).toBe(false);
  });

  it('requires a positive size', () => {
    expect(startUploadRequestSchema.safeParse({ ...start, sizeBytes: 0 }).success).toBe(false);
  });

  it('bounds part-number batches and rejects duplicates', () => {
    expect(presignPartsRequestSchema.safeParse({ partNumbers: [1, 2, 3] }).success).toBe(true);
    expect(presignPartsRequestSchema.safeParse({ partNumbers: [] }).success).toBe(false);
    expect(presignPartsRequestSchema.safeParse({ partNumbers: [2, 2] }).success).toBe(false);
    expect(presignPartsRequestSchema.safeParse({ partNumbers: [0] }).success).toBe(false);
  });

  it('requires at least one completed part', () => {
    expect(completeUploadRequestSchema.safeParse({ parts: [] }).success).toBe(false);
    expect(
      completeUploadRequestSchema.safeParse({ parts: [{ partNumber: 1, etag: '"abc"' }] }).success,
    ).toBe(true);
  });
});
