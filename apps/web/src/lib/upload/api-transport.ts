import { api, type Problem, problemMessage } from '@/lib/api/client';

import { ApiError, PartUploadError, type UploadTransport } from './multipart-uploader';

/** Throws ApiError for a problem+json response; anything else (network) is thrown as-is. */
function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.data !== undefined) return result.data;
  const problem = result.error as Partial<Problem> | undefined;
  throw new ApiError(
    problemMessage(result.error, 'The upload request failed'),
    result.response.status,
    problem?.code,
  );
}

/**
 * The real transport: JSON calls go to our API (same origin), part bytes go straight to storage
 * with XMLHttpRequest — fetch can't report upload progress. The ETag response header is readable
 * only because the bucket's CORS exposes it (ADR 0003).
 */
export function createApiTransport(meetingId: string): UploadTransport {
  const path = { id: meetingId };
  return {
    async start({ idempotencyKey, ...body }) {
      return unwrap(
        await api.POST('/v1/meetings/{id}/uploads', {
          params: { path, header: { 'idempotency-key': idempotencyKey } },
          body: { ...body, consentConfirmed: true },
        }),
      );
    },

    async presign(uploadId, partNumbers) {
      return unwrap(
        await api.POST('/v1/meetings/{id}/uploads/{uploadId}/parts', {
          params: { path: { ...path, uploadId } },
          body: { partNumbers },
        }),
      );
    },

    putPart(url, body, onProgress, signal) {
      return new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const onAbort = () => xhr.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        const settle = () => signal.removeEventListener('abort', onAbort);
        xhr.open('PUT', url);
        xhr.upload.onprogress = (e) => onProgress(e.loaded);
        xhr.onload = () => {
          settle();
          const etag = xhr.getResponseHeader('ETag');
          if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
          else if (xhr.status >= 200 && xhr.status < 300) {
            reject(
              new PartUploadError(
                xhr.status,
                'Storage did not expose the ETag header (check bucket CORS)',
              ),
            );
          } else reject(new PartUploadError(xhr.status));
        };
        xhr.onerror = () => {
          settle();
          reject(new Error('Network error while uploading a part'));
        };
        xhr.onabort = () => {
          settle();
          reject(new DOMException('Part upload aborted', 'AbortError'));
        };
        if (signal.aborted) xhr.abort();
        else xhr.send(body);
      });
    },

    async complete(uploadId, parts) {
      unwrap(
        await api.POST('/v1/meetings/{id}/uploads/{uploadId}/complete', {
          params: { path: { ...path, uploadId } },
          body: { parts },
        }),
      );
    },

    async abort(uploadId) {
      const { response } = await api.DELETE('/v1/meetings/{id}/uploads/{uploadId}', {
        params: { path: { ...path, uploadId } },
      });
      // 404: already gone. Anything else is best-effort; stale uploads are cleaned up server-side.
      if (!response.ok && response.status !== 404) {
        throw new ApiError('Could not cancel the upload', response.status);
      }
    },
  };
}
