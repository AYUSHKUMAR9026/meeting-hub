# ADR 0004: Processing pipeline and media preparation

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

Phase 3 ends with a `recording.uploaded` row in the `domain_events` outbox. Phase 4 turns it into a
processing run: validate the file, produce audio every later step (speech-to-text, analysis,
indexing) can consume, and show the user live progress. Later phases append steps, so the machinery
has to be generic. Every step must be idempotent, retryable and recoverable after a worker crash, and
media handling must be safe against hostile files (ffmpeg parses untrusted input).

## Decision

### Postgres is the source of truth; BullMQ only delivers work

`processing_runs` and `processing_steps` hold the state of every run. A BullMQ job is a doorbell:
its payload is `{ runId, step }` and nothing else. If Redis were wiped, the sweeper rebuilds the
queued work from the database. Job IDs are deterministic, `{runId}.{stepName}`, so enqueueing the
same step twice is a no-op. (BullMQ rejects a single `:` in custom job IDs, hence `.`.)

### Pipeline driver, not BullMQ flows

Steps come from a **declarative registry** (`modules/processing/steps/registry.ts`). Each step
declares its name, queue, handler, `maxAttempts`, backoff, timeout, progress weight, the run status
shown while it runs, and `isAlreadyDone(run)` for check-before-do idempotency. A pipeline version is
an ordered list of step names; version 1 is `[prepare_media]`. Later phases append steps and bump
the version; a run keeps the version it started with.

The driver runs one step per job:

1. **Claim** (one transaction, run row locked): stop if the run is no longer active; if
   `isAlreadyDone(run)`, mark the step succeeded and advance; otherwise mark it `running`,
   `attempts + 1`, and set the run's status and `current_step`.
2. **Execute** the handler outside any transaction. It gets an `AbortSignal` (cancellation or
   timeout), a progress callback and a logger bound to `run_id` and `step`.
3. **Commit** (one transaction, run row locked): if the run is still active, the handler's output
   rows, the step's success, and, for the last step, the run's completion and the meeting's
   status, all commit together.
4. **Enqueue** the next step after the commit. A crash between 3 and 4 leaves a succeeded step with a
   pending successor; the sweeper enqueues it.

### Errors

- `RetryableError` (or any unexpected error): the step goes back to `pending` with the last error
  recorded; BullMQ retries with exponential backoff and 50 % jitter, up to the step's
  `maxAttempts`. The last failed attempt fails the step.
- `PermanentError`: the step fails at once (BullMQ `UnrecoverableError`). `error_message` is
  user-safe and shown to every member; `error_detail` (stderr tail, internal reason) is shown only
  to owners and admins and never contains media content or signed URLs.
- A failed step fails the run (`failed`, with the step's code and user-safe message) and the
  meeting (`failed`).

### Runs

- Status: `queued → preparing_media → … → completed | failed | cancelled`; `transcribing`,
  `analyzing`, `indexing` and `partially_ready` are reserved for later phases.
- **At most one active run per meeting**: partial unique index on `processing_runs(meeting_id)`
  where the status is active. A second reprocess request gets 409 `RUN_ALREADY_ACTIVE`.
- **One upload-triggered run per recording**: partial unique index on
  `processing_runs(recording_id, trigger) WHERE trigger = 'upload'`, so the same outbox event
  handled twice creates one run.
- Step rows are one row per step (`PRIMARY KEY (run_id, name)`), not a jsonb array, so concurrent
  updates to different steps never race.
- Run and step rows carry `workspace_id` with composite foreign keys (as in ADR 0003), so the
  database guarantees a run belongs to its meeting's and recording's workspace.

### Outbox dispatcher

Runs in the worker and polls about every second. Each poll pages through unprocessed events whose
`available_at` has passed, claiming each page with `FOR UPDATE SKIP LOCKED` (several workers can
run it). Each event is handled in a savepoint and marked processed **in the same transaction as its
effect**. A failing handler rolls back its savepoint, increments `attempts`, records `last_error`
and pushes `available_at` out with exponential backoff (capped at an hour); other events in the
batch are unaffected.

A handler may name a feature flag. While that flag is off (for the event's workspace) the event is
**left unprocessed**, so turning the flag on later processes the backlog. Events with no handler
are left alone too. Handlers must be idempotent; event types are stable strings.

| Event                      | Handler                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `recording.uploaded`       | Create a run (`trigger = upload`) and its step rows; enqueue first step. Flag `pipeline.media`. |
| `media.objects_superseded` | Delete storage objects replaced by a reprocess (see below).                                     |

The first step is enqueued after the dispatcher's transaction commits; a lost enqueue is repaired
by the sweeper.

### Sweeper (every minute)

- Active runs whose next step is `pending` with no live BullMQ job: enqueue it (covers both a
  crash between commit and enqueue and a wiped Redis).
- Steps `running` whose BullMQ job no longer exists, or is finished, failed or gone: re-enqueue.
- Steps `running` for longer than their timeout plus a grace period: fail them (`STEP_TIMED_OUT`).

A BullMQ job that exists but is completed or failed while the database still expects work is
removed and re-added (BullMQ ignores `add` for an existing job ID).

### Step `prepare_media` (queue `media`)

Concurrency `MEDIA_CONCURRENCY` (default: CPU count), timeout 60 min, 3 attempts.

1. Stream the original from storage to a per-job temp file, computing SHA-256 while it streams; more
   than `MAX_UPLOAD_BYTES` aborts.
2. `ffprobe` it. Permanent failures: `UNREADABLE_MEDIA` (empty, corrupt, truncated, not media or a
   disallowed container), `NO_AUDIO_STREAM`, `MEDIA_TOO_SHORT` (< 1 s), `MEDIA_TOO_LONG`
   (> `MAX_DURATION_SECONDS`, default 10,800).
3. One `ffmpeg` pass decodes the chosen audio stream once and writes (a) the normalized file and (b)
   16 kHz mono PCM to stdout, from which waveform peaks are computed in-process.
4. Upload both with streaming multipart uploads (`@aws-sdk/lib-storage`).
5. Commit the original's `sha256`, `duration_ms`, codec, sample rate and channels; the normalized
   recording row; `meetings.duration_ms`; and step success in one transaction.

`isAlreadyDone(run)` is true when the meeting's normalized recording already points at this run's
storage key.

### Normalized audio format: AAC-LC in M4A, mono, 16 kHz, 40 kbit/s

- **Plays everywhere.** AAC in MP4 plays natively in current Chrome, Firefox and Safari on every
  platform. Opus plays in Chrome and Firefox, but Safari's support depends on the container and OS
  version (WebM/Opus only on recent macOS/iOS, Ogg/Opus later still), which is a risk for a file
  whose only job is to play.
- **Accepted by both STT candidates**: AssemblyAI and Deepgram both list M4A/AAC (and Opus) as
  supported input.
- **The file says what it is.** An AAC stream at 16 kHz reports 16 kHz. Opus always decodes at
  48 kHz, so ffprobe reports 48 kHz for an Opus file whatever its input rate, and we want to be able
  to assert "mono, 16 kHz" on the artifact.
- **Seekable and durable in browsers.** `-movflags +faststart` puts the `moov` atom first: the
  `<audio>` element knows the duration from the first range request and seeks with range requests.
- **Encoder availability.** ffmpeg's native `aac` encoder is in every build (Alpine's distro
  package included); no libfdk or libopus dependency.
- Cost: AAC-LC is less efficient than Opus at low bit rates. At 40 kbit/s mono 16 kHz speech is
  clear; three hours is about 54 MB.
- Verified in Chrome: the `<audio>` element loads the normalized file from its signed URL, reports
  the right duration (10:00 for a 230 MB screen recording, 3:00 for a phone memo), seeks to the
  middle through range requests and plays. The E2E test checks duration and playback in Chromium.

### Waveform peaks

JSON in the audiowaveform layout (`{ version: 2, channels: 1, sample_rate, samples_per_pixel,
bits: 8, length, data: [min, max, …] }`) so peaks.js/wavesurfer can read it later. Resolution is
10 points per second, capped at **4,000 points** whatever the duration (longer recordings get
more samples per point).

### Storage keys

`ws/{wid}/meetings/{mid}/normalized/{runId}` (audio) and `ws/{wid}/meetings/{mid}/peaks/{runId}`.
Keys are **derived from the run id**, not random, so a retried or re-delivered step overwrites
its own objects instead of leaving duplicates; each run still gets fresh keys. Both live under the
meeting prefix, so deleting the meeting sweeps them. Peaks get their own `peaks/` kind directory
(rather than sharing `normalized/`) to keep the `<kind>/{uuid}` key convention of ADR 0003.

### Reprocessing

`POST /v1/meetings/{id}/runs` (owners and admins, flag `pipeline.media`) creates a `reprocess` run.
Its commit **replaces the normalized row in place** (one normalized recording per meeting) and, in
the same transaction, writes a `media.objects_superseded` event with the old keys. The dispatcher
deletes them after the commit, so a failed delete is retried and the new row never points at a
deleted object.

### ffmpeg security

ffmpeg and ffprobe parse untrusted files. Every invocation (built in one place, unit-tested):

- reads a **local temp file**, passed as `file:<path>`, never a URL;
- passes `-protocol_whitelist file,pipe` (blocks http/tcp/… from playlists or crafted media: SSRF)
  **and** `-format_whitelist` with the containers we accept (mov/mp4/m4a, matroska/webm, ogg, wav,
  mp3, aac). The second matters: a playlist (`hls`, `concat`) whose entries are `file:` URLs would
  otherwise pass the protocol whitelist and read local files. Verified with ffmpeg 9.0: a real
  `.m3u8` playlist is refused with "Format not on whitelist"; without the whitelist only ffmpeg's own
  segment-extension heuristic stands in the way. (Our temp input has no extension, and ffmpeg 9
  also refuses HLS detection there, but we don't rely on that.)
- passes `-nostdin`, `-threads FFMPEG_THREADS` and `-t` capped just above the duration limit;
- runs with `spawn` and an argument array (no shell), a hard timeout and an `AbortSignal`, both of
  which `SIGKILL` the process;
- works in a per-job temp directory `meeting-hub-job-{host}-{pid}-…` under `MEDIA_TMP_DIR`, removed in
  `finally`. A killed worker never reaches `finally`, so at startup the worker removes this host's job
  directories whose pid is dead (or is its own: a restarted container reuses pids), plus any older
  than the longest step timeout;
- error details name the input `<input>` rather than the temp path;
- refuses inputs larger than `MAX_UPLOAD_BYTES`.

The worker image runs as the non-root `node` user and installs Alpine's `ffmpeg` package.
`FFMPEG_PATH` / `FFPROBE_PATH` choose the binaries (default: on `PATH`).

### Cancellation

Deleting a meeting cancels its active run (meeting service, and again in the purge job); the stale
upload job does the same for its meeting. Steps check for cancellation before starting, between
sub-phases, and every 2 s while running: a cancelled run, a deleted meeting or a purged run aborts
the signal, which kills ffmpeg and aborts uploads in flight. Objects the step already wrote are
deleted before it returns, and the commit refuses to run for an inactive run.

### Progress and live updates

- Overall progress = sum of the weights of finished steps + the running step's weight × its own
  estimate, divided by the total weight. `prepare_media` reports coarse sub-phases (download, then
  transcode measured by PCM samples received against the probed duration, then upload), throttled
  to one write per 2 s or 5 %.
- After every run or step change the worker publishes on the Redis channel
  `meeting-hub:processing:meeting:{meetingId}` (payload: ids only).
- `GET /v1/meetings/{id}/events` is a Server-Sent Events stream. Access is checked on connect like
  any route (`meeting.read`, so viewers can subscribe). On each message the API re-reads the run
  from Postgres and sends `event: run.updated` with the same body as `GET …/processing`. One Redis
  subscriber connection per API process is shared by all streams. A `: heartbeat` comment goes out
  every 15 s; streams close after 15 minutes so access is re-checked when the browser reconnects.
  Headers: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
- The web app falls back to polling `GET …/processing` every 5 s when the stream errors.
- **Through the Next.js rewrite proxy (verified 2026-10-04, Next.js 16.3.8):** the same stream read
  via `:3000` and directly from `:4000` at the same time delivered every chunk within ~5 ms of each
  other, in `next dev` and in a production build: no buffering and no compression
  (`no-transform` is respected, no `Content-Encoding`), heartbeat at 15.0 s. No workaround is
  needed. A buffering proxy in front of the web app in production must pass `text/event-stream`
  through unbuffered; the polling fallback covers it if not.

### API

| Route                              | Access                                     | Notes                                                            |
| ---------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `GET /v1/meetings/{id}/processing` | `meeting.read`                             | Current run, steps, progress; `errorDetail` only for owner/admin |
| `GET /v1/meetings/{id}/events`     | `meeting.read`                             | SSE `run.updated`                                                |
| `POST /v1/meetings/{id}/runs`      | `processing.reprocess` (owner/admin), flag | `{ fromStep? }` → 202; 409 if a run is active                    |
| `GET /v1/meetings/{id}/media`      | `meeting.read`                             | Short-lived signed URLs: normalized audio (inline) and peaks     |

The normalized audio is served inline (it is our own output, `audio/mp4`); originals stay
attachment-only (ADR 0003). Signed media URLs live `MEDIA_URL_TTL_SECONDS` (default 15 min) and
the player refreshes them before they expire.

### Module layout

`modules/processing` owns runs, steps, the registry, driver, sweeper, run service and progress
publisher. Because a step's output and its success must commit in one transaction, its repository
also writes the `recordings` rows and `meetings.status/duration_ms` that processing produces. The
meetings module learns about runs only through an injected `ProcessingCanceller` interface (no
import cycle). The generic outbox dispatcher lives in `modules/platform/outbox`; handlers are
registered by the modules that own the effects.

## Consequences

- **+** Any crash point (before claim, mid-step, between commit and enqueue, Redis loss) heals from
  Postgres: the sweeper and deterministic job IDs and storage keys make re-delivery safe.
- **+** New steps are a registry entry plus a handler; the driver, sweeper, progress and UI are
  shared.
- **+** Hostile media can't make ffmpeg reach the network or other local files.
- **−** Two writes per step transition (Postgres, then Redis), so the queue can briefly lag the
  database; the sweeper bounds the lag at a minute.
- **−** The processing repository writes tables the meetings module also writes (`recordings`,
  `meetings`). Accepted for transactional integrity; both go through the same column contracts.
- **−** One SSE connection per open meeting page holds an API socket; fine at our scale.

## Alternatives considered

- **BullMQ flows** for the step graph: state would live in Redis, not Postgres, and a wiped Redis
  would lose it.
- **Opus in WebM/Ogg** for the normalized file: smaller, but Safari support and the 48 kHz decode
  rate (see above).
- **Random UUID storage keys per attempt**: retries after a crash would leave orphaned objects.
- **LISTEN/NOTIFY for the dispatcher**: optional; a 1 s poll on a partial index is cheap and
  simpler to operate.
- **WebSockets** for progress: one-way updates fit SSE, which works through the same-origin proxy.
