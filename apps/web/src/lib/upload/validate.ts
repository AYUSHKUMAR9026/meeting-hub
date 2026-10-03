import {
  contentTypeForFile,
  DEFAULT_MAX_UPLOAD_BYTES,
  type UploadContentType,
} from '@meeting-hub/contracts/upload-rules';

import { formatBytes } from './progress';

export type FileCheck = { ok: true; contentType: UploadContentType } | { ok: false; error: string };

/**
 * Fails fast in the browser on the same rules the API enforces (type allowlist, size limit), so a
 * wrong file never starts an upload. The API re-checks everything.
 */
export function checkRecordingFile(
  file: { name: string; type: string; size: number },
  maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
): FileCheck {
  const contentType = contentTypeForFile(file);
  if (!contentType) {
    return {
      ok: false,
      error: `“${file.name}” isn't a supported recording. Use an audio or video file: MP3, M4A, AAC, WAV, OGG, Opus, WebM, MP4 or MOV.`,
    };
  }
  if (file.size === 0) return { ok: false, error: `“${file.name}” is empty.` };
  if (file.size > maxBytes) {
    return {
      ok: false,
      error: `“${file.name}” is ${formatBytes(file.size)}, more than the ${formatBytes(maxBytes)} limit.`,
    };
  }
  return { ok: true, contentType };
}
