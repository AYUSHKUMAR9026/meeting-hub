import { describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  MultipartUploader,
  PartUploadError,
  retryDelay,
  UploadCancelledError,
  type UploadProgress,
  type UploadTransport,
} from './multipart-uploader';

const KB = 1024;

/** A fake storage + API: records calls, and fails parts as scripted. */
function fakeTransport(options: {
  size: number;
  partSize: number;
  firstBatch?: number;
  ttlMs?: number;
  now?: () => number;
  failures?: Record<number, (Error | number)[]>;
}) {
  const partCount = Math.ceil(options.size / options.partSize);
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 15 * 60_000;
  const failures = options.failures ?? {};
  const putCalls: { partNumber: number; url: string; bytes: number }[] = [];
  const presignCalls: number[][] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let urlVersion = 0;

  const urls = (numbers: number[]) =>
    numbers.map((n) => ({ partNumber: n, url: `https://s3.test/part-${n}?v=${++urlVersion}` }));

  const mocks = {
    start: vi.fn<UploadTransport['start']>(() =>
      Promise.resolve({
        uploadId: 'up-1',
        partSize: options.partSize,
        partCount,
        urlsExpireAt: new Date(now() + ttl).toISOString(),
        parts: urls(
          Array.from({ length: Math.min(partCount, options.firstBatch ?? 10) }, (_, i) => i + 1),
        ),
      }),
    ),
    presign: vi.fn<UploadTransport['presign']>((_id, numbers) => {
      presignCalls.push(numbers);
      return Promise.resolve({
        urlsExpireAt: new Date(now() + ttl).toISOString(),
        parts: urls(numbers),
      });
    }),
    putPart: vi.fn<UploadTransport['putPart']>(
      async (url: string, body: Blob, onProgress: (n: number) => void, signal: AbortSignal) => {
        const partNumber = Number(/part-(\d+)/.exec(url)![1]);
        putCalls.push({ partNumber, url, bytes: body.size });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          await new Promise((r) => setTimeout(r, 1));
          if (signal.aborted) throw new DOMException('aborted', 'AbortError');
          const failure = failures[partNumber]?.shift();
          if (typeof failure === 'number') throw new PartUploadError(failure);
          if (failure) throw failure;
          onProgress(body.size);
          return `"etag-${partNumber}"`;
        } finally {
          inFlight -= 1;
        }
      },
    ),
    complete: vi.fn<UploadTransport['complete']>(() => Promise.resolve()),
    abort: vi.fn<UploadTransport['abort']>(() => Promise.resolve()),
  };
  const transport: UploadTransport = mocks;
  return { transport, mocks, putCalls, presignCalls, partCount, maxInFlight: () => maxInFlight };
}

const file = (size: number) => Object.assign(new Blob([new Uint8Array(size)]), { name: 'a.wav' });
const instant = { sleep: () => Promise.resolve(), waitForOnline: () => Promise.resolve() };

describe('MultipartUploader', () => {
  it('uploads every part with bounded concurrency and completes with sorted ETags', async () => {
    const fake = fakeTransport({ size: 50 * KB + 7, partSize: 5 * KB });
    const progress: UploadProgress[] = [];
    const uploader = new MultipartUploader(
      file(50 * KB + 7),
      'audio/wav',
      fake.transport,
      (p) => progress.push(p),
      { ...instant, concurrency: 3, idempotencyKey: 'key-1' },
    );

    await uploader.run();

    expect(fake.mocks.start).toHaveBeenCalledWith({
      fileName: 'a.wav',
      contentType: 'audio/wav',
      sizeBytes: 50 * KB + 7,
      idempotencyKey: 'key-1',
    });
    expect(fake.partCount).toBe(11);
    expect(fake.maxInFlight()).toBeLessThanOrEqual(3);
    expect(fake.putCalls.find((c) => c.partNumber === 11)?.bytes).toBe(7);
    expect(fake.mocks.complete).toHaveBeenCalledWith(
      'up-1',
      Array.from({ length: 11 }, (_, i) => ({ partNumber: i + 1, etag: `"etag-${i + 1}"` })),
    );
    expect(progress.at(-1)).toMatchObject({ uploadedBytes: 50 * KB + 7, partsDone: 11 });
  });

  it('fetches URLs beyond the first batch in batches', async () => {
    const fake = fakeTransport({ size: 25 * KB, partSize: KB, firstBatch: 10 });
    await new MultipartUploader(file(25 * KB), 'audio/wav', fake.transport, undefined, {
      ...instant,
      batchSize: 10,
    }).run();
    expect(fake.presignCalls.flat().sort((a, b) => a - b)).toEqual(
      Array.from({ length: 15 }, (_, i) => i + 11),
    );
    expect(fake.presignCalls.length).toBeLessThanOrEqual(4);
  });

  it('retries a failing part with backoff, then succeeds', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fake = fakeTransport({
      size: 3 * KB,
      partSize: KB,
      failures: { 2: [new TypeError('network'), 500] },
    });
    await new MultipartUploader(file(3 * KB), 'audio/wav', fake.transport, undefined, {
      ...instant,
      sleep,
    }).run();
    expect(fake.putCalls.filter((c) => c.partNumber === 2)).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(fake.mocks.complete).toHaveBeenCalledOnce();
  });

  it('re-signs a part whose URL was rejected (403) instead of reusing it', async () => {
    const fake = fakeTransport({ size: 2 * KB, partSize: KB, failures: { 1: [403] } });
    await new MultipartUploader(
      file(2 * KB),
      'audio/wav',
      fake.transport,
      undefined,
      instant,
    ).run();
    const part1 = fake.putCalls.filter((c) => c.partNumber === 1);
    expect(part1).toHaveLength(2);
    expect(part1[0]!.url).not.toBe(part1[1]!.url);
    expect(fake.presignCalls[0]).toContain(1);
  });

  it('refreshes URLs that are about to expire before using them', async () => {
    let now = 1_000_000;
    const fake = fakeTransport({ size: 2 * KB, partSize: KB, ttlMs: 30_000, now: () => now });
    const uploader = new MultipartUploader(file(2 * KB), 'audio/wav', fake.transport, undefined, {
      ...instant,
      now: () => now,
      refreshMarginMs: 60_000,
    });
    now += 1;
    await uploader.run();
    // Every URL from start expires within the margin, so all were re-signed before use.
    expect(fake.presignCalls.flat().sort()).toEqual([1, 2]);
  });

  it('waits for the network to come back between retries', async () => {
    const waitForOnline = vi.fn(() => Promise.resolve());
    const fake = fakeTransport({
      size: KB,
      partSize: KB,
      failures: { 1: [new TypeError('offline')] },
    });
    await new MultipartUploader(file(KB), 'audio/wav', fake.transport, undefined, {
      sleep: () => Promise.resolve(),
      waitForOnline,
    }).run();
    expect(waitForOnline).toHaveBeenCalled();
  });

  it('fails after maxAttempts, then resumes with only the unfinished parts', async () => {
    const fake = fakeTransport({
      size: 4 * KB,
      partSize: KB,
      failures: { 3: [500, 500, 500] },
    });
    const uploader = new MultipartUploader(file(4 * KB), 'audio/wav', fake.transport, undefined, {
      ...instant,
      maxAttempts: 3,
      concurrency: 1,
    });
    await expect(uploader.run()).rejects.toBeInstanceOf(PartUploadError);
    expect(fake.mocks.complete).not.toHaveBeenCalled();

    const before = fake.putCalls.length;
    await uploader.run();
    const resumed = fake.putCalls.slice(before).map((c) => c.partNumber);
    expect(resumed).toEqual([3, 4]);
    expect(fake.mocks.start).toHaveBeenCalledOnce(); // same upload, no second start
    expect(fake.mocks.complete).toHaveBeenCalledOnce();
  });

  it('does not retry API errors (problem+json)', async () => {
    const fake = fakeTransport({ size: KB, partSize: KB });
    fake.mocks.start.mockRejectedValueOnce(
      new ApiError('Files of type "x" can\'t be uploaded', 415, 'UNSUPPORTED_MEDIA_TYPE'),
    );
    const uploader = new MultipartUploader(
      file(KB),
      'audio/wav',
      fake.transport,
      undefined,
      instant,
    );
    await expect(uploader.run()).rejects.toMatchObject({ status: 415 });
    expect(fake.mocks.start).toHaveBeenCalledOnce();
  });

  it('retries start on network errors with the same idempotency key', async () => {
    const fake = fakeTransport({ size: KB, partSize: KB });
    fake.mocks.start.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await new MultipartUploader(file(KB), 'audio/wav', fake.transport, undefined, {
      ...instant,
      idempotencyKey: 'stable',
    }).run();
    const keys = fake.mocks.start.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys).toEqual(['stable', 'stable']);
  });

  it('cancel stops the upload and aborts it on the server', async () => {
    const fake = fakeTransport({ size: 20 * KB, partSize: KB });
    const uploader = new MultipartUploader(
      file(20 * KB),
      'audio/wav',
      fake.transport,
      () => {
        if (fake.putCalls.length === 2) void uploader.cancel();
      },
      { ...instant, concurrency: 1 },
    );
    await expect(uploader.run()).rejects.toBeInstanceOf(UploadCancelledError);
    expect(fake.mocks.abort).toHaveBeenCalledWith('up-1');
    expect(fake.mocks.complete).not.toHaveBeenCalled();
    expect(fake.putCalls.length).toBeLessThan(20);
  });
});

describe('retryDelay', () => {
  it('grows exponentially with jitter and is capped at 30 s', () => {
    expect(retryDelay(1, () => 0)).toBe(500);
    expect(retryDelay(1, () => 1)).toBe(1000);
    expect(retryDelay(3, () => 1)).toBe(4000);
    expect(retryDelay(20, () => 1)).toBe(30_000);
  });
});
