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
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
/** Part size for server-side multipart uploads of files we produce. */
const UPLOAD_PART_SIZE = 8 * 1024 * 1024;

/** A download exceeded the size it was allowed to have. */
export class ObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`object is larger than ${maxBytes} bytes`);
    this.name = 'ObjectTooLargeError';
  }
}

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

  /**
   * Streams an object to a local file, computing its SHA-256 on the way. Fails with
   * `ObjectTooLargeError` as soon as more than `maxBytes` arrive (the file is left for the caller's
   * temp-dir clean-up).
   */
  async downloadToFile(
    key: string,
    path: string,
    options: { maxBytes: number; signal?: AbortSignal; onBytes?: (total: number) => void },
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const res = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      options.signal ? { abortSignal: options.signal } : {},
    );
    if (!(res.Body instanceof Readable)) throw new Error('S3 returned no readable body');
    const hash = createHash('sha256');
    let total = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        total += chunk.length;
        if (total > options.maxBytes) {
          done(new ObjectTooLargeError(options.maxBytes));
          return;
        }
        hash.update(chunk);
        options.onBytes?.(total);
        done(null, chunk);
      },
    });
    await pipeline(
      res.Body,
      meter,
      createWriteStream(path),
      options.signal ? { signal: options.signal } : {},
    );
    return { sizeBytes: total, sha256: hash.digest('hex') };
  }

  /**
   * Uploads a local file with a streaming multipart upload (aborted on `signal`, and cleaned up by
   * lib-storage if a part fails). Returns its size and SHA-256.
   */
  async uploadFile(
    key: string,
    path: string,
    options: { contentType: string; signal?: AbortSignal },
  ): Promise<{ sizeBytes: number; sha256: string }> {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const body = createReadStream(path).pipe(
      new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          sizeBytes += chunk.length;
          done(null, chunk);
        },
      }),
    );
    await this.upload(key, body, options);
    return { sizeBytes, sha256: hash.digest('hex') };
  }

  /** Uploads an in-memory body (small objects such as peaks JSON). */
  async uploadBuffer(
    key: string,
    body: Buffer,
    options: { contentType: string; signal?: AbortSignal },
  ): Promise<void> {
    await this.upload(key, body, options);
  }

  private async upload(
    key: string,
    body: Readable | Buffer,
    options: { contentType: string; signal?: AbortSignal },
  ): Promise<void> {
    const upload = new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: options.contentType },
      queueSize: 4,
      partSize: UPLOAD_PART_SIZE,
      leavePartsOnError: false,
    });
    const abort = () => void upload.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      await upload.done();
    } finally {
      options.signal?.removeEventListener('abort', abort);
    }
  }

  /** Deletes the given keys (missing keys are fine), up to 1,000 per request. */
  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH).map((Key) => ({ Key }));
      const res = await this.s3.send(
        new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch, Quiet: true } }),
      );
      if (res.Errors?.length) {
        const first = res.Errors[0]!;
        throw new Error(
          `could not delete ${res.Errors.length} objects (${first.Code}: ${first.Key})`,
        );
      }
    }
  }

  /** Keys under a prefix (first 1,000), for tests and diagnostics. */
  async listKeys(prefix: string): Promise<string[]> {
    const page = await this.s3.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: DELETE_BATCH }),
    );
    return (page.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : []));
  }

  /**
   * A short-lived GET URL that the browser may render inline (an `<audio>` source). Only for files
   * we produced ourselves; user uploads are always attachments (ADR 0003).
   */
  presignInline(key: string, options: { contentType: string; expiresIn: number }): Promise<string> {
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: options.contentType,
        ResponseContentDisposition: 'inline',
        ResponseCacheControl: 'private, max-age=300',
      }),
      { expiresIn: options.expiresIn },
    );
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
