// Public API of the media module: storage keys, multipart planning, object-storage operations, and
// ffmpeg-based probing/normalization. No domain rules here; meetings and processing decide who may
// do what with which file.
export {
  FORMAT_WHITELIST,
  ffprobeArgs,
  NORMALIZED_AUDIO,
  normalizeArgs,
  PEAKS_PCM,
  PROTOCOL_WHITELIST,
} from './ffmpeg/args';
export { ProcessTimeoutError, runProcess } from './ffmpeg/process';
export {
  assertDuration,
  assertProcessable,
  type AudioStreamInfo,
  MEDIA_ERRORS,
  type MediaInfo,
  MIN_DURATION_MS,
  parseProbe,
} from './ffmpeg/probe';
export {
  MediaToolkit,
  MediaToolMissingError,
  type MediaToolkitOptions,
  type NormalizeResult,
} from './ffmpeg/toolkit';
export {
  attachmentDisposition,
  type CompletedPart,
  isNoSuchUpload,
  ObjectStorage,
  ObjectTooLargeError,
  type PresignedPart,
} from './object-storage';
export {
  downsamplePeaks,
  MAX_PEAK_POINTS,
  PEAKS_POINTS_PER_SECOND,
  PeaksAccumulator,
  type PeaksJson,
  toInt8,
} from './peaks';
export { meetingPrefix, normalizedAudioKey, originalRecordingKey, peaksKey } from './storage-keys';
export { JOB_DIR_PREFIX, listJobDirs, sweepStaleJobDirs, withJobDir } from './temp-dirs';
export {
  firstBatch,
  MAX_PARTS,
  MIN_PART_SIZE,
  planUpload,
  type UploadPlan,
  validateCompletedParts,
} from './upload-plan';
