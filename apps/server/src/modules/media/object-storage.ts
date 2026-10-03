import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

/** S3's per-request limit for DeleteObjects. */
const DELETE_BATCH = 1_000;

const statusOf = (err: unknown) =>
  (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
const nameOf = (err: unknown) => (err as { name?: string } | null)?.name;

/** The multipart upload doesn't exist (any more): completed, aborted or expired. */
export const isNoSuchUpload = (err: unknown) =>
  nameOf(err) === 'NoSuchUpload' || statusOf(err) === 404;

/**
 * `attachment` with an ASCII fallback name plus the exact UTF-8 name (RFC 6266 / 5987), so a
 * download never renders inline and odd file names can't break the header.
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'recording';
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * The storage operations Meeting Hub needs, over any S3-compatible server. `signer` signs URLs that
 * browsers use (it may point at a different, public endpoint); `s3` makes the server's own calls.
 */
export class ObjectStorage {
  constructor(
    private readonly s3: S3Client,
    private readonly signer: S3Client,
    readonly bucket: string,
  ) {}

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const res = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }),
    );
    if (!res.UploadId) throw new Error('S3 returned no UploadId');
    return res.UploadId;
  }

  presignUploadParts(
    key: string,
    uploadId: string,
    partNumbers: readonly number[],
    expiresIn: number,
  ): Promise<PresignedPart[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.signer,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn },
        ),
      })),
    );
  }

  /** Completes the upload; 'missing' if S3 no longer knows it (already completed or aborted). */
  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly CompletedPart[],
  ): Promise<'completed' | 'missing'> {
    try {
      await this.s3.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
      return 'completed';
    } catch (err) {
      if (isNoSuchUpload(err)) return 'missing';
      throw err;
    }
  }

  /** Idempotent: aborting an upload that is already gone is fine. */
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.s3.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (err) {
      if (!isNoSuchUpload(err)) throw err;
    }
  }

  /** The object's size, or null if it doesn't exist. */
  async headObject(key: string): Promise<{ sizeBytes: number } | null> {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: res.ContentLength ?? 0 };
    } catch (err) {
      if (statusOf(err) === 404 || nameOf(err) === 'NotFound') return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  /** Deletes every object under `prefix`, up to 1,000 per request. Returns how many were deleted. */
  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    for (;;) {
      // Always list from the start: what we deleted is gone, so no continuation token is needed.
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: DELETE_BATCH }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length === 0) return deleted;
      const res = await this.s3.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
      );
      if (res.Errors?.length) {
        const first = res.Errors[0]!;
        throw new Error(
          `could not delete ${res.Errors.length} objects (${first.Code}: ${first.Key})`,
        );
      }
      deleted += keys.length;
    }
  }

  /** A short-lived GET URL that always downloads as an attachment, never renders inline. */
  presignDownload(
    key: string,
    options: { fileName: string; contentType: string; expiresIn: number },
  ): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: attachmentDisposition(options.fileName),
        ResponseContentType: options.contentType,
      }),
      { expiresIn: options.expiresIn },
    );
  }
}
