/** S3 multipart limits. */
export const MIN_PART_SIZE = 5 * 1024 * 1024;
export const MAX_PARTS = 10_000;

export interface UploadPlan {
  partSize: number;
  partCount: number;
}

/**
 * How to split `sizeBytes` into parts: the configured part size, grown if the file would otherwise
 * need more than S3's 10,000 parts. Every part but the last is exactly `partSize`.
 */
export function planUpload(sizeBytes: number, configuredPartSize: number): UploadPlan {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new RangeError('sizeBytes must be a positive integer');
  }
  const minForCount = Math.ceil(sizeBytes / MAX_PARTS);
  const partSize = Math.max(configuredPartSize, MIN_PART_SIZE, minForCount);
  return { partSize, partCount: Math.max(1, Math.ceil(sizeBytes / partSize)) };
}

/** The part numbers of the first batch of URLs handed out with a new upload. */
export const firstBatch = (partCount: number, batchSize: number): number[] =>
  Array.from({ length: Math.min(partCount, batchSize) }, (_, i) => i + 1);

/**
 * Checks the parts a client sent to complete an upload: every part 1..partCount exactly once.
 * Returns them sorted by part number (S3 requires ascending order), or an error message.
 */
export function validateCompletedParts<P extends { partNumber: number }>(
  parts: readonly P[],
  partCount: number,
): { ok: true; parts: P[] } | { ok: false; message: string } {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  if (sorted.length !== partCount) {
    return { ok: false, message: `Expected ${partCount} parts, got ${sorted.length}` };
  }
  for (const [i, part] of sorted.entries()) {
    if (part.partNumber !== i + 1) {
      return { ok: false, message: `Parts must be numbered 1 to ${partCount}, each exactly once` };
    }
  }
  return { ok: true, parts: sorted };
}
