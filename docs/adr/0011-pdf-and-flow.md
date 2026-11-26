# ADR 0011: Meeting flow and PDF-only saved results (Phases 8.5 and 8.6)

Status: Accepted

## Decision

The project Meetings section is the saved result of a call or upload. Its default view is an
immutable decision PDF, dated in the project time zone, alongside editable structured summaries,
decisions and action items. Deployment remains on hold; ADR 0012 is reserved for deployment.
There was no deployment ADR in this checkout to renumber.

The Phase 8.6 amendment supersedes recording retention and playback in ADRs 0003, 0005, 0007,
0008 and 0009. New uploads and live calls use temporary audio regardless of workspace settings.
The database migration marks existing meetings `legacy` without deleting any content. Only new
meetings default to `temporary`. Owners can explicitly purge existing content after a count/size
preview and typed confirmation; the preview must still match at execution. Active calls and runs
block bulk purge. Other workspaces cannot access previews or purge content.

## Processing and storage

- All new audio, including participant tracks, normalization outputs and temporary peaks, uses
  `temp/ws/{workspaceId}/meetings/{meetingId}/`. Saved PDFs use the permanent meeting prefix.
  Meeting deletion sweeps both prefixes. The bucket lifecycle expires `temp/` objects after two
  days and aborts unfinished multipart uploads after one day. The worker is the application-level
  guarantee; object-store lifecycle expiry is a backstop with store-dependent scheduling.
- Delete audio immediately after a committed successful transcription or permanent run failure.
  Transient retries and free-quota waits keep audio until success or the hard TTL. The maintenance
  sweep repairs missed deletions, records purge reasons and reports content-free counts.
  `RECORDING_TEMP_TTL_HOURS` defaults to 48 and cannot exceed 48. Expiry fails active runs with
  `RECORDING_EXPIRED`, asking for another upload. S3 multipart uploads are aborted before purge.
- Purged recording rows remain as processing provenance, with `purged_at`, `purge_reason`, an
  empty storage key, and no peaks/upload key. The unique storage-key index excludes empty keys.
  Purged room-export rows are removed. Audio download and signed-media routes return a stable
  RFC 7807 conflict for temporary-input meetings even before audio is purged.
- With per-track speakers enabled, capture microphone tracks and begin processing after the
  room ends and all track exports settle. Use a track as the pipeline input/provenance; normalize
  it for validation, and transcribe the participant tracks independently. A failed track capture
  starts the room mix fallback. Free-quota fallback constructs a bounded local mix from available
  PCM tracks using attendance offsets. Never keep an always-on mixed recording alongside healthy
  participant-track capture. Keep pipeline versions 1–3 unchanged.

## Durable PDF generation and regeneration

`results` owns stored files and retention. Reuse the Phase 7 PDF renderer. Database triggers on
document publication and item changes mark the meeting's `pdf_dirty_at` in the same transaction.
The same trigger coalesces an IDs-only `document.pdf_requested` transactional outbox event.
Repeated edits reset a five-second quiet period; the maintenance sweep renders due meetings.
The driver invokes retention after each successful step and permanent failure, and immediately
generates the first PDF after analysis commits. The minute sweep repairs missed work and renders
later PDF versions after the debounce period. No transcript or document text
enters Redis, job payloads or audit metadata.

A meeting row lock serializes result workers and dirty-marker updates. Render against the same
transaction's document data. Store a fresh UUIDv7 file for each successful render, GET it back and
verify its SHA-256 before committing `document_files` and the Ready state. Rows include meeting,
document revision, generation time, size, locale and formatted meeting date/time. Previous files
remain available through authorized version selection. A savepoint isolates renderer/storage
failure from the already completed audio purge. PDF failure remains visible and retryable;
structured content and transcript text survive until successful PDF storage.

The PDF contains project and meeting names, zoned date/time, duration, participant names, summary,
decisions and actions with status, owner/due date, and speaker/timestamp citations. A transcript
appendix is included only for `keep_transcript`. Rejected items remain labelled as rejected in
saved PDFs, so a rejection produces an understandable new version.

## Content retention

`workspace_settings.content_retention` is `pdf_only` by default, or `keep_transcript`. Audio is
always temporary. Under `pdf_only`, after verified PDF storage:

1. Snapshot citation speaker labels, indices and timestamps independently of transcript segments.
2. Preserve action owner labels, directory identities and opaque speaker references for trackers
   and progress charts.
3. Delete segment, transcript, speaker and transcription-checkpoint rows and clear analysis
   checkpoints. Retain structured summaries, decisions/actions, document revision metadata and PDFs.

Document revision metadata keeps its source transcript UUID as provenance, without an FK requiring
the deleted transcript to remain. Optional evidence segment references and action speaker references
use selective `SET NULL`; tenant and revision columns are never nulled. Purge audits contain counts
and reasons only. Existing legacy meetings are never swept into this policy automatically.

Transcript reading/search, exports, public transcript scopes and re-analysis return a clear
`TRANSCRIPT_NOT_RETAINED` error in PDF-only meetings. Item editing and review remain available and
regenerate from structured data. `keep_transcript` permits transcript operations and analysis-only
regeneration using retained text even after audio deletion. Re-transcription always requires new
audio. Changing retention cannot recover previously deleted text.

## Product flow and local enablement

`pnpm dev:full` loads or creates `.env.local`, enables the product flags through the example,
starts the existing Compose stack plus LiveKit/Egress, migrates, seeds an owner and two members,
and runs web/API/worker. It chooses free Mailpit ports without stopping another project's services.
Fake AI is the keyless mode; real mode uses explicitly configured provider keys and workspace
external-AI consent. Development can boot with missing Groq/Gemini/LiveKit credentials so the
owner/admin readiness page can explain them. Production/test configuration remains fail-fast.

Meetings offer Start now, Schedule, and secondary Upload paths. Email invitations can link multiple
meetings. Acceptance creates project membership and directory-linked meeting participation.
Meeting emails include project-zone date/time and join/accept links. The LiveKit pre-join/conference
components provide device check, media controls, screen sharing and chat. Only the authenticated
sender persists their own chat messages; a scoped unique client ID makes retries idempotent.

## Limitations

Local and CI fake-provider tests establish application behavior, not provider quality or physical
microphone quality. Third-party AI retention is outside our control and is disclosed before upload
and joining a recorded room. There are no new paid services or dependencies. Hosted CI results and
any deviations are recorded separately in the implementation report.

LiveKit sends signed webhooks to `http://host.docker.internal:4000/v1/rooms/webhook`.
Compose maps that hostname through `extra_hosts: host-gateway`; the host API listens on
`0.0.0.0:4000`. Container loopback cannot reach the host API. Redis uses `127.0.0.1`
from host processes. Accepted webhooks log only signature verification, never the body.

If Docker Desktop refuses the default gateway connection, set `LIVEKIT_HOST_GATEWAY`
to the host LAN IPv4 address in `.env.local` and recreate LiveKit. The hostname stays
`host.docker.internal`; never put container loopback in the webhook URL.
