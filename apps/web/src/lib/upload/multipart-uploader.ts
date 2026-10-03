/**
 * Browser-side multipart upload straight to object storage (ADR 0003). Transport-agnostic so the
 * scheduling, retry and URL-refresh logic is unit-testable; `api-transport.ts` is the real one.
 *
 * - 3–4 parts in flight; each part retried with exponential backoff and jitter
 * - presigned URLs fetched in batches, re-fetched before they expire or when storage rejects one
 * - waits for the network to come back instead of burning retries while offline
 * - `run()` can be called again after a failure: finished parts are kept (resumable in-session)
 */

export interface PresignedPart {
  partNumber: number;
  url: string;
}

export interface StartedUpload {
  uploadId: string;
  partSize: number;
  partCount: number;
  urlsExpireAt: string;
  parts: PresignedPart[];
}

export interface UploadTransport {
  start(input: {
    fileName: string;
    contentType: string;
    sizeBytes: number;
    idempotencyKey: string;
  }): Promise<StartedUpload>;
  presign(
    uploadId: string,
    partNumbers: number[],
  ): Promise<{ urlsExpireAt: string; parts: PresignedPart[] }>;
  /** PUTs a part; resolves with its ETag. Rejects with PartUploadError on HTTP errors. */
  putPart(
    url: string,
    body: Blob,
    onProgress: (loadedBytes: number) => void,
    signal: AbortSignal,
  ): Promise<string>;
  complete(uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abort(uploadId: string): Promise<void>;
}

/** Storage answered a part PUT with an HTTP error. */
export class PartUploadError extends Error {
  constructor(
    readonly status: number,
    message = `Part upload failed with HTTP ${status}`,
  ) {
    super(message);
    this.name = 'PartUploadError';
  }
}

/** A JSON API call failed with a problem+json response; never retried. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelledError';
  }
}

export interface UploadProgress {
  uploadedBytes: number;
  totalBytes: number;
  partsDone: number;
  partCount: number;
}

export interface UploaderOptions {
  concurrency?: number;
  /** Attempts per part before the whole upload fails (it can then be resumed with run()). */
  maxAttempts?: number;
  /** Re-fetch a URL when it expires within this margin. */
  refreshMarginMs?: number;
  /** URLs requested per /parts call. */
  batchSize?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Resolves when the browser is online (immediately if it already is). */
  waitForOnline?: () => Promise<void>;
  random?: () => number;
  idempotencyKey?: string;
}

const defaultWaitForOnline = () =>
  typeof navigator === 'undefined' || navigator.onLine
    ? Promise.resolve()
    : new Promise<void>((resolve) =>
        window.addEventListener('online', () => resolve(), { once: true }),
      );

/** Exponential backoff with full jitter: attempt 1 → up to 1 s, 2 → 2 s, … capped at 30 s. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (random() * ceiling) / 2);
}

export class MultipartUploader {
  private readonly opts: Required<Omit<UploaderOptions, 'idempotencyKey'>>;
  private readonly idempotencyKey: string;
  private upload: StartedUpload | undefined;
  private readonly urls = new Map<number, { url: string; expiresAt: number }>();
  private readonly etags = new Map<number, string>();
  private readonly inFlightBytes = new Map<number, number>();
  private presigning: Promise<void> | undefined;
  private controller = new AbortController();
  private cancelled = false;

  constructor(
    private readonly file: Blob & { name: string },
    private readonly contentType: string,
    private readonly transport: UploadTransport,
    private readonly onProgress: (progress: UploadProgress) => void = () => {},
    options: UploaderOptions = {},
  ) {
    this.opts = {
      concurrency: options.concurrency ?? 4,
      maxAttempts: options.maxAttempts ?? 6,
      refreshMarginMs: options.refreshMarginMs ?? 60_000,
      batchSize: options.batchSize ?? 10,
      now: options.now ?? Date.now,
      sleep: options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      waitForOnline: options.waitForOnline ?? defaultWaitForOnline,
      random: options.random ?? Math.random,
    };
    this.idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
  }

  get uploadId(): string | undefined {
    return this.upload?.uploadId;
  }

  /** Starts (or resumes) the upload and resolves once the API has completed it. */
  async run(): Promise<void> {
    if (this.cancelled) throw new UploadCancelledError();
    this.controller = new AbortController();
    if (!this.upload) {
      this.upload = await this.withRetries(() =>
        this.transport.start({
          fileName: this.file.name,
          contentType: this.contentType,
          sizeBytes: this.file.size,
          // Same key on every retry: the API returns the same upload instead of a second one.
          idempotencyKey: this.idempotencyKey,
        }),
      );
      this.remember(this.upload.parts, this.upload.urlsExpireAt);
    }
    const { partCount } = this.upload;
    const pending = Array.from({ length: partCount }, (_, i) => i + 1).filter(
      (n) => !this.etags.has(n),
    );
    this.report();

    const queue = [...pending];
    const worker = async () => {
      for (let n = queue.shift(); n !== undefined; n = queue.shift())
        await this.uploadPart(n, queue);
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.opts.concurrency, pending.length) }, worker),
      );
    } catch (err) {
      this.controller.abort(); // stop sibling parts; their progress is kept for a resume
      throw this.cancelled ? new UploadCancelledError() : err;
    }

    const parts = [...this.etags.entries()]
      .sort(([a], [b]) => a - b)
      .map(([partNumber, etag]) => ({ partNumber, etag }));
    await this.withRetries(() => this.transport.complete(this.upload!.uploadId, parts));
  }

  /** Stops every part in flight and aborts the upload on the server. */
  async cancel(): Promise<void> {
    this.cancelled = true;
    this.controller.abort();
    if (this.upload) await this.transport.abort(this.upload.uploadId);
  }

  // --- internals ----------------------------------------------------------------------------------

  private async uploadPart(partNumber: number, queue: readonly number[]): Promise<void> {
    const { partSize } = this.upload!;
    const body = this.file.slice((partNumber - 1) * partSize, partNumber * partSize);
    for (let attempt = 1; ; attempt++) {
      this.throwIfCancelled();
      try {
        const url = await this.urlFor(partNumber, queue);
        const etag = await this.transport.putPart(
          url,
          body,
          (loaded) => {
            this.inFlightBytes.set(partNumber, loaded);
            this.report();
          },
          this.controller.signal,
        );
        this.etags.set(partNumber, etag);
        this.inFlightBytes.delete(partNumber);
        this.report();
        return;
      } catch (err) {
        this.inFlightBytes.delete(partNumber);
        this.report();
        this.throwIfCancelled();
        if (err instanceof ApiError) throw err;
        // Storage rejected the signature (expired or clock skew): sign again on the next attempt.
        if (err instanceof PartUploadError && (err.status === 403 || err.status === 400)) {
          this.urls.delete(partNumber);
        }
        if (attempt >= this.opts.maxAttempts) throw err;
        await this.opts.waitForOnline(); // offline time doesn't count against the retries' backoff
        await this.opts.sleep(retryDelay(attempt, this.opts.random));
      }
    }
  }

  /** A URL valid for at least the refresh margin, fetching a batch (this part + upcoming) if not. */
  private async urlFor(partNumber: number, queue: readonly number[]): Promise<string> {
    let signedJustNow = false;
    for (;;) {
      const cached = this.urls.get(partNumber);
      if (cached && this.urlIsFresh(partNumber)) return cached.url;
      // A URL signed for us a moment ago is used as long as it hasn't expired, even if its lifetime
      // is shorter than the refresh margin (otherwise we'd re-sign forever).
      if (cached && signedJustNow && cached.expiresAt > this.opts.now()) return cached.url;
      signedJustNow = true;
      if (this.presigning) {
        await this.presigning; // another part is already fetching a batch; it may include ours
        continue;
      }
      const wanted = [partNumber, ...queue.filter((n) => !this.urlIsFresh(n))].slice(
        0,
        this.opts.batchSize,
      );
      this.presigning = this.withRetries(async () => {
        const res = await this.transport.presign(this.upload!.uploadId, wanted);
        this.remember(res.parts, res.urlsExpireAt);
      }).finally(() => {
        this.presigning = undefined;
      });
      await this.presigning;
    }
  }

  private urlIsFresh(partNumber: number): boolean {
    const cached = this.urls.get(partNumber);
    return Boolean(cached && cached.expiresAt - this.opts.now() > this.opts.refreshMarginMs);
  }

  private remember(parts: PresignedPart[], urlsExpireAt: string) {
    const expiresAt = new Date(urlsExpireAt).getTime();
    for (const p of parts) this.urls.set(p.partNumber, { url: p.url, expiresAt });
  }

  /** JSON API calls: retried on network failures, never on API errors (problem+json). */
  private async withRetries<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      this.throwIfCancelled();
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ApiError || attempt >= this.opts.maxAttempts) throw err;
        await this.opts.waitForOnline();
        await this.opts.sleep(retryDelay(attempt, this.opts.random));
      }
    }
  }

  private throwIfCancelled() {
    if (this.cancelled) throw new UploadCancelledError();
  }

  private report() {
    if (!this.upload) return;
    const { partSize, partCount } = this.upload;
    const total = this.file.size;
    let uploaded = 0;
    for (const n of this.etags.keys()) uploaded += Math.min(partSize, total - (n - 1) * partSize);
    for (const loaded of this.inFlightBytes.values()) uploaded += loaded;
    this.onProgress({
      uploadedBytes: Math.min(uploaded, total),
      totalBytes: total,
      partsDone: this.etags.size,
      partCount,
    });
  }
}
