import { S3Client } from '@aws-sdk/client-s3';

import type { Config } from './config';

/**
 * S3 client for storage calls the server makes itself, or — with `forPresigning` — a client that
 * only signs URLs for browsers, against `S3_PUBLIC_ENDPOINT` (the server's endpoint may not be
 * reachable from a browser, e.g. inside Docker).
 */
export function createS3Client(
  config: Config,
  options: { forPresigning?: boolean } = {},
): S3Client {
  const endpoint = options.forPresigning
    ? (config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT)
    : config.S3_ENDPOINT;
  return new S3Client({
    region: config.S3_REGION,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    },
    maxAttempts: 2,
    // The SDK's default flexible checksums add parameters to presigned part URLs that a browser
    // PUT can't satisfy, and aren't supported by every S3-compatible server.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
