// Public API of the media module: storage keys, multipart planning and object-storage operations.
// No domain rules here; the meetings module decides who may upload what.
export {
  attachmentDisposition,
  type CompletedPart,
  isNoSuchUpload,
  ObjectStorage,
  type PresignedPart,
} from './object-storage';
export { meetingPrefix, originalRecordingKey } from './storage-keys';
export {
  firstBatch,
  MAX_PARTS,
  MIN_PART_SIZE,
  planUpload,
  type UploadPlan,
  validateCompletedParts,
} from './upload-plan';
