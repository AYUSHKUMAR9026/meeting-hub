/**
 * Upload rules shared by the API (enforces) and the browser (fails fast). No Zod here, so the web
 * app can import it cheaply via `@meeting-hub/contracts/upload-rules`.
 */

/**
 * Recording types we accept, with the file extensions that map to them. Browsers sometimes report
 * an empty or vendor type, so the web app falls back to the extension (`contentTypeForFile`).
 * Real media validation (ffprobe) happens in processing, not here.
 */
export const uploadContentTypes = {
  'audio/mpeg': ['mp3'],
  'audio/mp4': ['m4a'],
  'audio/x-m4a': ['m4a'],
  'audio/aac': ['aac'],
  'audio/wav': ['wav'],
  'audio/x-wav': ['wav'],
  'audio/wave': ['wav'],
  'audio/ogg': ['ogg', 'oga'],
  'audio/opus': ['opus'],
  'audio/webm': ['weba'],
  'video/webm': ['webm'],
  'video/mp4': ['mp4'],
  'video/quicktime': ['mov'],
} as const satisfies Record<string, readonly string[]>;
export type UploadContentType = keyof typeof uploadContentTypes;

export const isAllowedUploadType = (type: string): type is UploadContentType =>
  Object.hasOwn(uploadContentTypes, type.toLowerCase());

/** Accept attribute for a file input: every allowed type and extension. */
export const uploadAcceptAttribute = [
  ...Object.keys(uploadContentTypes),
  ...new Set(Object.values(uploadContentTypes).flatMap((exts) => exts.map((e) => `.${e}`))),
].join(',');

/** The type to declare for a file: its own if allowed, else one inferred from the extension. */
export function contentTypeForFile(file: { name: string; type: string }): UploadContentType | null {
  if (file.type && isAllowedUploadType(file.type))
    return file.type.toLowerCase() as UploadContentType;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  const match = Object.entries(uploadContentTypes).find(([, exts]) =>
    (exts as readonly string[]).includes(ext),
  );
  return (match?.[0] as UploadContentType | undefined) ?? null;
}

/** Default MAX_UPLOAD_BYTES (2 GiB). The API's configured limit is what's enforced. */
export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3;
