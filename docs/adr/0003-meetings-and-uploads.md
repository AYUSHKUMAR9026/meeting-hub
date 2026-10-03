# ADR 0003: Meetings and direct-to-storage uploads

- **Status:** Accepted
- **Date:** 2026-10-03

## Context

Phase 3 lets a workspace member create a meeting, attach participants from the people directory and
upload its recording: up to 2 GiB / about 3 hours of audio or video, from a browser on an ordinary
connection. Uploads of that size must not tie up API workers or memory, must survive network blips,
and must leave the system in a consistent state whether they complete, fail, are cancelled or are
abandoned. When an upload completes, the processing pipeline (Phase 4) has to learn about it reliably,
even though nothing consumes that signal yet.

## Decision

### Bytes never pass through the API

The browser uploads **directly to S3-compatible storage** with presigned **multipart** URLs. The API
only creates, signs, completes and aborts multipart uploads and keeps the metadata in Postgres.

```
browser ──POST /v1/meetings/{id}/uploads──────────▶ API ──CreateMultipartUpload──▶ S3
browser ◀── uploadId, partSize, partCount, first batch of presigned part URLs ── API
browser ──PUT part 1..n (3–4 in parallel, retried)───────────────────────────────▶ S3
browser ──POST …/uploads/{uploadId}/parts (more URLs, as needed)──▶ API
browser ──POST …/uploads/{uploadId}/complete [{partNumber, etag}]─▶ API ──Complete + HeadObject──▶ S3
                                                                   API ──tx: recording+meeting uploaded,
                                                                            domain_events 'recording.uploaded'
```

- **Part size** defaults to 16 MiB (`UPLOAD_PART_SIZE_BYTES`, at least 5 MiB, which S3 requires for
  every part but the last). Tests use 5 MiB. If a file would need more than 10,000 parts the part
  size grows to fit.
- **Presigned URLs live 15 minutes** (`UPLOAD_URL_TTL_SECONDS`). The start response carries the first
  batch (`UPLOAD_URL_BATCH_SIZE`, default 10); the client asks for more in batches as it goes and
  re-requests any URL that is about to expire or was rejected.
- Presigned URLs are signed against `S3_PUBLIC_ENDPOINT` (defaults to `S3_ENDPOINT`), because the
  address the API uses for storage may not be reachable from a browser (e.g. inside Docker).
- **`uploadId` in our API is the recording's id**, not S3's UploadId. S3's id stays server-side.
- The AWS SDK client is configured with `requestChecksumCalculation: 'WHEN_REQUIRED'`. Otherwise the
  SDK adds checksum parameters to presigned part URLs that a browser `PUT` cannot satisfy.

### Storage keys

`ws/{workspaceId}/meetings/{meetingId}/original/{randomUuid}`. Keys never contain file names or other
user input. The original file name is stored only in `recordings.original_filename`. Everything a
meeting owns lives under its `ws/{wid}/meetings/{mid}/` prefix, so deletion can sweep the prefix.

### What may be uploaded

- An allowlist of audio/video content types (MP3, M4A/AAC, WAV, OGG/Opus, WebM, MP4, MOV), shared in
  `@meeting-hub/contracts` so the browser can reject a wrong file before uploading.
- Declared size at most `MAX_UPLOAD_BYTES` (default 2 GiB).
- After `CompleteMultipartUpload`, `HeadObject` must report exactly the declared size; otherwise the
  object is deleted and the upload fails (`UPLOAD_SIZE_MISMATCH`).
- Real media validation (container, codecs, the 3-hour limit) needs ffprobe and is Phase 4.

### Consent

Starting an upload requires `consentConfirmed: true`: the uploader confirms that the participants
consented to being recorded. `recordings.consent_confirmed_by/at` store who and when.

### Bucket CORS and lifecycle

Browser multipart uploads need bucket CORS that allows the web origin for `PUT`/`GET`/`HEAD` and
**exposes `ETag`**; without it the browser can't read part ETags and can't complete. Locally,
`infra/garage/init.sh` sets both CORS and a lifecycle rule that aborts incomplete multipart uploads
after 1 day. Production buckets need the same two settings (see README). The lifecycle rule is a
backstop; the `media.abort-stale-uploads` job is the guarantee.

### Idempotency and consistency

- **Start** requires an `Idempotency-Key` header, unique per workspace
  (`recordings(workspace_id, idempotency_key)`). Replaying the same key for the same meeting and file
  returns the same upload with fresh URLs. Reusing it for anything else is `IDEMPOTENCY_KEY_REUSED`.
- **One original recording per meeting** (`recordings(meeting_id, kind)` unique). A failed upload's
  row is reused by the next attempt. A cancelled upload's row is deleted.
- **Complete** locks the recording row (`SELECT … FOR UPDATE`) for the whole S3 complete + head + DB
  update. A second or concurrent call waits, then sees `uploaded` and returns the same 202 with no side
  effects. If S3 already completed the upload but our transaction didn't commit, a retry finds no
  multipart upload, `HeadObject`s the key, and finishes the job.
- The status change (recording and meeting → `uploaded`) and the **`recording.uploaded` row in the
  `domain_events` outbox** are written in **one transaction**, so the event is written exactly once
  and only if the state change commits. Phase 4 consumes it.

### Deleting a meeting

`DELETE /v1/meetings/{id}` sets `deleted_at` (every query filters it out immediately), records
`meeting.deleted` and enqueues `meeting.delete` on the maintenance queue, then answers **202**. The job
aborts any in-flight multipart upload, deletes every object under the meeting's prefix in batches of
up to 1,000, deletes the rows (participants and recordings cascade), and records `meeting.purged`. It
is idempotent. An hourly `meeting.purge-deleted` sweep re-enqueues any soft-deleted meeting that is
still present after 15 minutes, so a lost enqueue (Redis down at the wrong moment) can't leave data
behind.

### Abandoned uploads

`media.abort-stale-uploads` runs hourly. It aborts multipart uploads that started more than 24 hours
ago (`UPLOAD_STALE_AFTER_HOURS`), marks their recordings `failed`, and puts the meeting back to
`awaiting_upload` so the user can try again.

### Data model

- `meetings`: status `awaiting_upload → uploading → uploaded` in this phase (`processing`, `ready`,
  `partially_ready`, `failed` are reserved for Phase 4). `source` defaults to `upload`, and
  `(workspace_id, source, external_id)` is unique for future imports.
- `meeting_participants(meeting_id, person_id)` **also stores `workspace_id`**, with composite foreign
  keys to `meetings(id, workspace_id)` and `people(id, workspace_id)`. That way **the database**
  guarantees that a participant belongs to the meeting's workspace, not just the service.
  `recordings` uses the same composite key to its meeting.
- Deleting a person removes them from meetings (cascade). Deleting a user keeps their meetings
  (`created_by` → NULL).

### Authorization

New actions in the permission matrix (ADR 0002): `meeting.read` (everyone), `meeting.create`,
`meeting.update`, `recording.upload` (owner/admin/member), `meeting.update_any`, `meeting.delete`,
`recording.download` (owner/admin). The rule "members may only edit and upload to meetings they
created" is a relationship rule next to the matrix (`authorization/meeting-rules.ts`): a member
acting on someone else's meeting gets 403 (they can see it, so 404 would be wrong). Routes under
`/v1/meetings/{id}` resolve the workspace through the caller's membership. Unknown, deleted and
other-workspace meetings are all 404.

Originals are only downloadable by owners/admins, via a 5-minute presigned URL with
`Content-Disposition: attachment`. They are never served inline. Each download URL issued is audited.

### Feature flag

`meetings.upload` (off by default, on in development) gates the upload endpoints. Workspace responses
list the client-visible flags that are on (`features`) so the UI can hide the uploader. Creating,
listing, editing and deleting meetings is not behind a flag.

## Consequences

- **+** API memory and bandwidth are independent of recording size. A 2 GiB upload costs the API a
  handful of small JSON requests.
- **+** Uploads survive network drops: only the failed part is retried, and expired URLs are
  re-signed.
- **+** The outbox guarantees Phase 4 sees every completed upload exactly once.
- **−** The storage endpoint must be reachable from the browser and its CORS configured per
  environment. Misconfigured CORS fails only in browsers, not in API tests (the E2E test covers it).
- **−** `complete` holds a row lock and a pooled connection during the S3 complete call (typically
  well under a second, longer for very large objects on slow storage).
- **−** Resumability is per browser session: reloading the tab mid-upload starts again (the abandoned
  multipart upload is cleaned up by the stale-upload job or the lifecycle rule).

## Alternatives considered

- **Streaming through the API** — simple, but ties API memory, connections and timeouts to file size.
- **tus / resumable-upload server** — another service to run. S3 multipart already gives resumable
  parts.
- **Single presigned PUT** — 5 GiB limit and no partial retry. One dropped connection restarts 2 GiB.
- **Hard delete in the request** — slow, and fails halfway on large prefixes. The job can retry.
- **POST-policy browser uploads** — no multipart, same drawbacks as a single PUT.
