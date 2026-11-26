# Meeting Hub

Hold project meetings in Meeting Hub or upload a recording, then open the automatically saved,
dated decision PDF. Review decisions and action items across meetings and track project progress.
Audio is temporary processing input. By default, only PDFs and extracted structured content remain.

**Status: Phases 8.5/8.6 product flow, building on Phases 1?10. Deployment remains on hold.**
See [ADR 0011](docs/adr/0011-pdf-and-flow.md) for the authoritative storage and retention rules.

## Prerequisites

- **Node.js 24 LTS** (see `.nvmrc`; `nvm use`)
- **pnpm 12** — `npm install -g pnpm@12`
- **Docker** with Compose v2 (Docker Desktop, OrbStack, or Docker Engine)
- **ffmpeg** (with ffprobe) on `PATH` for the worker. Any recent release (6+) works.
  - **Windows:** `winget install --id Gyan.FFmpeg -e`, then open a new terminal. If winget can't download it,
    get `ffmpeg-release-essentials.zip` from <https://www.gyan.dev/ffmpeg/builds/>, check it against the published
    `.sha256`, unzip it (e.g. to `%LOCALAPPDATA%Programsfmpeg`) and add its `bin` folder to your user `Path`
    (or set `FFMPEG_PATH`/`FFPROBE_PATH` in `.env` to the two `.exe` files).
  - **macOS:** `brew install ffmpeg` · **Debian/Ubuntu:** `sudo apt-get install ffmpeg`
  - Check: `ffmpeg -version && ffprobe -version`

## Run everything locally

1. Install the prerequisites above, start Docker, then run:

   ```bash
   pnpm install
   pnpm dev:full
   ```

   The launcher creates `.env.local` from [`.env.local.example`](.env.local.example) if needed.
   It starts Postgres, Redis, Garage, Mailpit, LiveKit and Egress, applies migrations, seeds a demo
   project, and starts web/API/worker. All product flags are enabled without manual flag editing.
   Local fake AI needs no keys and makes no external AI requests. LiveKit runs real browser rooms.
   Allow about a minute for the initial container health checks.

2. Open <http://localhost:3000/sign-in>. Demo accounts are `owner@meeting-hub.local`,
   `alex@meeting-hub.local` and `sam@meeting-hub.local`, all with local-only password
   `meeting-hub-demo-2026`. The seed is idempotent and refuses production execution. Open the demo
   project: its participant picker already has three members. Use separate browser profiles or
   an incognito window for the second participant.

3. Open **Settings ? System readiness** as owner/admin. It explains disabled flags, missing keys,
   external-AI consent, LiveKit and SMTP problems without showing secrets. Readiness links directly
   to settings for UI-fixable problems. Environment changes require a server restart.

4. In **Meetings ? New meeting**, choose **Start a meeting now** or **Schedule a meeting**. Select
   members and optionally enter invitation emails. Acknowledge the recording/AI notice. Start now
   opens the room immediately; scheduling keeps a dated meeting with a later Start action.
   The secondary **Upload a recording** path accepts existing audio/video as temporary input.

5. Open the Mailpit address printed by the launcher (usually <http://localhost:8025>). If another
   project owns its ports, the launcher chooses free ports and saves them in ignored `.env.local`.
   Invitees sign up/sign in, verify their email, then accept the project invitation. Acceptance adds
   them to the linked meetings. Members can also be invited from **Settings ? Members**, with an
   optional selection of scheduled/live meetings. Pending, accepted and declined states are shown.

6. Join from two browsers, acknowledge the notice, check devices in pre-join, and join the room.
   Mute, camera, screen share, chat, participants and leave controls are available. The host chooses
   **End for everyone**. The worker transcribes and analyzes, deletes temporary audio, then saves
   and verifies a PDF. The first PDF is finalized directly after analysis; maintenance repairs interrupted finalization.
   The dated meeting card becomes Ready and offers **View PDF**. The Document tab has the embedded
   PDF, download, print and prior versions; the Summary tab retains editable items.

7. Edit/confirm/reject an item. After a five-second quiet period, the maintenance worker stores a
   new PDF version. Previous versions remain available. PDF failures show Retry PDF and preserve
   structured content and transcript input until PDF storage succeeds.

Audio is deleted after successful transcription or permanent failure. Retry/quota waits keep input
for at most `RECORDING_TEMP_TTL_HOURS` (default/max 48). A sweep repairs missed purges and S3 has a
`temp/` lifecycle safety net. New meetings never expose an audio player, waveform, original download
or media URL. Re-transcription requires another upload. Workspace `contentRetention` defaults to
`pdf_only`: after verified PDF storage, transcript rows/text/checkpoints are deleted while structured
summary, decisions/actions and speaker/timestamp citations remain. `keep_transcript` also retains
transcript text, includes its PDF appendix and supports analysis-only regeneration without audio.

Existing meetings are preserved. Owners can use **Settings ? Purge stored recordings/transcripts**,
review counts and bytes, and type the requested confirmation. These actions and retention changes
are audited without content. Changing settings does not recover deleted content. See the
[privacy notice template](docs/privacy-template.md) before publishing an installation.

### Real-key mode (free quotas only)

Copy/edit ignored `.env.local`: select `TRANSCRIPTION_PROVIDER=groq`, `LLM_PROVIDER=gemini`, and set
`GROQ_API_KEY` and `GEMINI_API_KEY` for free-tier accounts with billing disabled. Restart
`pnpm dev:full`; as owner/admin review the named-provider disclosure and enable **Allow external AI
processing** in Settings. Never place keys in browser environment variables. Quota exhaustion defers
processing; it does not buy capacity or silently switch to a paid adapter. Provider-side retention
is outside Meeting Hub's control. Fake-provider checks do not establish real-model accuracy.

For the original minimal development setup, use `.env.example`, `pnpm infra:up`, `pnpm db:migrate`
and `pnpm dev`. It preserves safe default-off product flags. `.env.local`, when present, takes
precedence over `.env` for server/database commands. <http://localhost:3000/status> shows base
infrastructure health.

## Commands

| Command                                         | What it does                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev:full`                                 | Full enabled stack, migrations and demo seed                         |
| `pnpm db:seed`                                  | Idempotent local demo seed                                           |
| `pnpm dev`                                      | Web, API and worker with hot reload                                  |
| `pnpm build`                                    | Production builds (server bundle, Next.js standalone)                |
| `pnpm lint`                                     | ESLint (incl. module-boundary rules)                                 |
| `pnpm typecheck`                                | `tsc --noEmit` everywhere                                            |
| `pnpm test`                                     | Unit tests (Vitest)                                                  |
| `pnpm test:integration`                         | Integration tests with Testcontainers (needs Docker)                 |
| `pnpm test:e2e`                                 | Playwright smoke test (needs `infra:up` + `db:migrate`)              |
| `pnpm format`                                   | Prettier from any package; generated files are always skipped        |
| `pnpm infra:up` / `:down`                       | Start / stop local infrastructure (`infra:reset` also wipes volumes) |
| `pnpm db:generate`                              | Generate a SQL migration from the Drizzle schema                     |
| `pnpm db:migrate`                               | Apply migrations                                                     |
| `pnpm db:studio`                                | Drizzle Studio                                                       |
| `pnpm openapi:export`                           | Export OpenAPI → `packages/contracts` and regenerate the web client  |
| `pnpm --filter @meeting-hub/server auth:schema` | Better Auth CLI's view of its schema, for review                     |

For the Playwright smoke test, stop `pnpm dev` first. Playwright starts its own API and worker with
transcription enabled and the fake provider selected.

## Layout

```
apps/web/              Next.js App Router + Tailwind + shadcn/ui
apps/server/           Fastify API (src/api.ts) + BullMQ worker (src/worker.ts)
packages/db/           Drizzle schema + SQL migrations
packages/contracts/    Shared Zod schemas + exported openapi.json
packages/config/       Shared tsconfig, ESLint, Prettier
infra/                 docker-compose (local infra) and Dockerfiles
docs/adr/              Architecture decision records
```

## Local endpoints

| URL                                   | Notes                                        |
| ------------------------------------- | -------------------------------------------- |
| http://localhost:3000                 | The app (sign in / sign up)                  |
| http://localhost:3000/status          | Dependency status page                       |
| http://localhost:8025                 | Mailpit inbox (all outgoing email)           |
| http://localhost:4000/health          | Liveness                                     |
| http://localhost:4000/ready           | Readiness (Postgres, Redis, S3); 503 if down |
| http://localhost:4000/v1/system/flags | Evaluated feature flags (non-production)     |
| http://localhost:4000/openapi.json    | OpenAPI 3.1 document (non-production)        |
| localhost:5432 / 6379 / 3900 / 1025   | Postgres / Redis / Garage S3 API / SMTP      |

The browser only talks to `:3000`: Next.js proxies `/api/auth/*` (Better Auth) and `/v1/*` to the API, so
session cookies are first-party. See [ADR 0002](docs/adr/0002-auth-and-workspaces.md).

## Document review and sharing

Enable `exports.enabled=true,sharing.enabled=true,review.enabled=true` alongside the
transcription and analysis flags. In a meeting, download the current document as Markdown,
Word, or PDF, optionally with the cited transcript revision. TXT and SRT exports use the current
transcript. The Summary tab supports bulk decision review, clipboard copying, printing, and
read-only earlier versions. Workspace navigation opens the Decisions and Action items trackers.

Each public link has an expiration and a document or transcript scope. Copy the full URL
when creating a link. Revoke it in the meeting, or pause all sharing in workspace settings.
Set `PUBLIC_WEB_URL` to the public web origin when it differs from `WEB_ORIGIN`.
`EXPORT_MAX_BYTES` defaults to 8 MiB and `SHARE_MAX_DAYS` defaults to 90.
[ADR 0007](docs/adr/0007-document-review-export-and-sharing.md)

## Feature flags

| Flag                     | Default (dev / other) | What it gates                                                                  |
| ------------------------ | --------------------- | ------------------------------------------------------------------------------ |
| `workspaces.invitations` | on / off              | Inviting people and accepting invitations                                      |
| `people.directory`       | on / off              | People directory API and settings page                                         |
| `meetings.upload`        | on / off              | Recording upload endpoints and uploader UI                                     |
| `exports.enabled`        | off / off             | Markdown, Word, PDF, TXT, and SRT downloads                                    |
| `sharing.enabled`        | off / off             | Manage and open public meeting links                                           |
| `review.enabled`         | off / off             | Workspace trackers, bulk review, copy and print                                |
| `analysis.enabled`       | off / off             | Cited meeting summaries, decisions, and action items                           |
| `transcription.enabled`  | off / off             | Speaker-labelled transcripts, waveform UI, and transcription-only reprocessing |
| `pipeline.media`         | on / off              | Processing runs on upload (backlog kept while off) and reprocess               |
| `auth.google_signin`     | off / off             | "Continue with Google" (also needs `GOOGLE_CLIENT_*`)                          |

Turn one on with `FEATURE_FLAGS_OVERRIDE=flag.key=true` in `.env`, or a `feature_flags` row (global or per workspace).

## Recording uploads and object storage

Recordings go from the browser directly to S3-compatible storage with presigned multipart URLs (16 MiB parts,
URLs valid 15 minutes, up to 2 GiB; see the `UPLOAD_*` variables in `.env.example`). Any S3-compatible bucket works,
but it needs two settings that `infra/garage/init.sh` applies locally:

1. **CORS** allowing the web origin to `PUT`, `GET` and `HEAD`, and **exposing the `ETag` header**. Without the exposed
   ETag the browser can’t complete multipart uploads. For example (AWS CLI):

   ```json
   {
     "CORSRules": [
       {
         "AllowedOrigins": ["https://app.example.com"],
         "AllowedMethods": ["PUT", "GET", "HEAD"],
         "AllowedHeaders": ["*"],
         "ExposeHeaders": ["ETag"],
         "MaxAgeSeconds": 3600
       }
     ]
   }
   ```

   `aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://cors.json`

2. A **lifecycle rule** that aborts incomplete multipart uploads after 1 day (a backstop; the worker's hourly
   `media.abort-stale-uploads` job is the guarantee).

`S3_PUBLIC_ENDPOINT` is the endpoint baked into presigned URLs; set it when browsers reach storage at a different
address than the API does. Locally both are `http://localhost:3900`; `CORS_ALLOWED_ORIGINS` (comma-separated) changes
the origins `garage-init` allows.

## Processing pipeline

Completed uploads write a `recording.uploaded` event to the `domain_events` outbox. The worker's dispatcher turns it into
a **processing run** (Postgres holds all run and step state; BullMQ only delivers `{ runId, step }` jobs). Pipeline
version 1 has one step, `prepare_media`: download and hash the original, `ffprobe` it, decode it once into normalized
audio (AAC in M4A, mono, 16 kHz, 40 kbit/s) plus waveform peaks, upload both, and commit everything in one transaction.
Invalid files fail with a clear reason (`UNREADABLE_MEDIA`, `NO_AUDIO_STREAM`, `MEDIA_TOO_SHORT`, `MEDIA_TOO_LONG`).
A sweeper repairs anything lost between Postgres and Redis every minute, so killing the worker mid-run is safe: restart it
and the run completes. ffmpeg only ever reads local temp files, with protocol and container whitelists. See
[ADR 0004](docs/adr/0004-processing-pipeline.md).

Live progress is a Server-Sent Events stream (`GET /v1/meetings/{id}/events`) through the same-origin proxy; it streams
unbuffered in both `next dev` and a production build. If a proxy in front of the web app buffers responses, make it
pass `text/event-stream` through unbuffered (`X-Accel-Buffering: no` is set for nginx); the page falls back to
polling every 5 s either way.

## Transcription

Add `transcription.enabled=true` to the comma-separated `FEATURE_FLAGS_OVERRIDE` in the root
`.env` and restart the API and worker. Keep the `pipeline.media` flag enabled for automatic processing.

- Use `TRANSCRIPTION_PROVIDER=fake` for predictable fixture text without an API key.
- To transcribe a real recording, set `TRANSCRIPTION_PROVIDER=assemblyai` and `ASSEMBLYAI_API_KEY`.
  This sends normalized audio and glossary terms to AssemblyAI. Use audio you have permission to share.
- `TRANSCRIPTION_MAX_DURATION_SECONDS` defaults to 10,800. Set a workspace transcription language
  under **Settings → General**, or leave it blank for automatic detection.

Upload a recording, wait for **Ready**, and open the meeting's **Transcript** panel. Select a segment
to seek the audio. Owners and admins can use **Manage speakers** to rename a label or link a directory
entry, and **Retry transcription** to rerun the step using the existing normalized audio. The previous
transcript stays available until the new one is ready.

## Meeting analysis

Enable `analysis.enabled=true` alongside `transcription.enabled=true` in `FEATURE_FLAGS_OVERRIDE`.
The worker generates a summary, decisions and action items with transcript citations. The Summary
view includes version history, retained edits, and citation links that seek the meeting audio.
Use the default `LLM_PROVIDER=fake` for local fixtures. Set `LLM_PROVIDER=anthropic` and
`ANTHROPIC_API_KEY` for real analysis. `LLM_MODEL` selects the model, and `ANALYSIS_MAX_INPUT_TOKENS`
limits the aggregate input budget, including retry and reduction requests. [ADR 0006](docs/adr/0006-cited-meeting-documents.md)

## Docker images

```bash
docker build -f infra/docker/server.Dockerfile -t meeting-hub-server .
docker build -f infra/docker/web.Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t meeting-hub-web .

docker run meeting-hub-server migrate   # apply migrations
docker run meeting-hub-server api       # default
docker run meeting-hub-server worker
```

Both images run as the non-root `node` user. The server image includes Alpine's `ffmpeg` package for the worker. `API_INTERNAL_URL` (where the web server proxies `/api/auth/*` and
`/v1/*`) is baked into the web build because Next.js resolves rewrites at build time.

## Troubleshooting

- **Port already in use** — something else is on 5432/6379/3900/3000/4000. Stop it or change the port
  mapping in `infra/docker-compose.yml` and the matching URL in `.env`.
- **Config error on start** — the process prints every invalid/missing variable; compare with `.env.example`.
- **Mailpit ports taken** (another project's Mailpit on 1025/8025) — start with
  `MAILPIT_SMTP_PORT=1026 MAILPIT_UI_PORT=8026 pnpm infra:up`, set `SMTP_PORT=1026` in `.env`, and run E2E with
  `MAILPIT_URL=http://localhost:8026`.
- **No verification email** — check Mailpit; the API logs `email send failed` if SMTP is unreachable.
- **Signed in but bounced to sign-in** — the session cookie is first-party to `:3000`; always use the web origin,
  never the API port, in the browser.
- **S3 down on `/status`** — run `pnpm infra:up` again; it waits for the `garage-init` job that creates the bucket.
- **Upload stuck at 0 % / “CORS” errors in the browser console** — the bucket has no CORS for your web origin. Run
  `pnpm infra:up` again (garage-init re-applies CORS); for another origin set `CORS_ALLOWED_ORIGINS` first.
- **“Storage did not expose the ETag header”** — the bucket CORS lacks `ExposeHeaders: ETag`.
- **Deleted meeting’s files still in storage** — purges run in the worker; make sure it is running (`pnpm dev` starts it).
- **Meeting stuck on “Uploaded”** — the worker isn't running, or `pipeline.media` is off for the workspace (uploads
  wait and are processed once it is turned on).
- **Processing fails with `MEDIA_TOOLS_UNAVAILABLE`** — the worker can't start ffmpeg: install it (see Prerequisites),
  open a new terminal so `PATH` is updated, or set `FFMPEG_PATH`/`FFPROBE_PATH`.
- **Every page is a 404 in `pnpm dev`** after running a production build (`pnpm build`, E2E in CI mode): delete
  `apps/web/.next` and start `pnpm dev` again.

See [`CLAUDE.md`](CLAUDE.md) for conventions and [`docs/adr`](docs/adr) for design decisions.

# Live meeting rooms

Start the optional room infrastructure with `docker compose -f infra/docker-compose.yml --profile rooms up -d`.
Use the LiveKit configuration in .env.example and enable `rooms.enabled=true` in FEATURE_FLAGS_OVERRIDE.
Recording and document generation also require `pipeline.media=true,transcription.enabled=true,analysis.enabled=true`.
The fake transcription and analysis providers produce development fixtures.
The fake room provider supplies synthetic recordings for API tests. Select the livekit provider to hold browser calls.
See [ADR 0008](docs/adr/0008-live-meeting-rooms.md) for consent, storage and network requirements.

Run the optional real-media browser test with `E2E_ROOMS=1 pnpm --filter @meeting-hub/web exec playwright test e2e/rooms.spec.ts`.
The manually dispatched LiveKit room browser workflow runs it with Chromium fake devices against real LiveKit and Egress.

## Free hosted AI and named speakers (Phase 9)

Use free-tier Groq and Google AI Studio projects with billing disabled. Add server-side `GROQ_API_KEY` and `GEMINI_API_KEY` to local `.env`, select `TRANSCRIPTION_PROVIDER=groq` and `LLM_PROVIDER=gemini`, and optionally set `LLM_FALLBACK_PROVIDER=groq`. No browser environment variable contains a key. AssemblyAI and Anthropic require explicit selection; they are never automatic fallbacks. Keyless development and CI use fake providers.

As an owner/admin, open workspace **Settings**, review the provider disclosure, and enable **Allow external AI processing**. It defaults off. Audio remains temporary while processing is deferred, bounded by its 48-hour TTL. Fake local providers do not send data and are exempt from this external-processing gate.

Enable `pipeline.media=true,transcription.enabled=true,analysis.enabled=true,transcription.per_track_speakers=true` for live speaker attribution (and `rooms.enabled=true` for calls). Participant microphone tracks are transcribed independently and labelled from attendance, including display names and directory/user links. Uploaded recordings use one generic speaker label. No diarization is used. Quota pressure falls back to the mixed recording and shows a notice; exhausted free quota defers work with an estimated retry time. Repaired extraction has a low-confidence badge.

Groq's published Whisper free limits are 25 MB/upload, 20 requests/minute, 2,000/day, 7,200 audio seconds/hour and 28,800/day. Gemini quotas vary by account: set the application caps in `.env` no higher than the values in AI Studio. Current Groq Llama models are enterprise-only, so the alternative defaults to the listed free `openai/gpt-oss-20b`. See [ADR 0009](docs/adr/0009-free-ai-and-track-speakers.md) for verified sources, model limits, quota behavior and quality limitations.

With Redis and ffmpeg available, run `pnpm check:live "C:/path/to/recording.wav"` to send a real file through the configured free providers without database access. It prints duration, word/speaker/item counts, citation validity and runtime. `--show` explicitly displays transcript/document text. A single file has a generic speaker because it has no attendance provenance. The check is never run in CI; verify named speakers separately in a real opted-in two-person room. Physical microphone and model quality need real recordings, not fake-device fixtures.

# Workspace progress (Phase 10)

Enable `progress.enabled=true` in `FEATURE_FLAGS_OVERRIDE` (alongside `analysis.enabled=true` and
`review.enabled=true`) or a workspace feature-flag row. Open `/w/<slug>/progress` for current KPIs,
action history, weekly decision activity, owner counts, latest meetings and audited CSV download.
Meeting pages also show their items and open actions from earlier meetings sharing participants.

The worker observes each workspace after local midnight and coalesces edits through the outbox.
Today's totals are live; completed snapshot dates survive regenerated summaries. Dates use the
workspace's IANA zone and weeks start Monday. Each chart has a keyboard-accessible data table and
print output. Tracker links initialize status, owner/speaker, unassigned, meeting and item filters.

Run `pnpm db:migrate` to apply migration **0009** (0008 is occupied by Phase 9). Existing items and
the initial snapshot are marked as backfilled; legacy audits cannot reconstruct every completion
time. History has workspace granularity; historical owner/meeting filters are unavailable. Missing
observation dates are not fabricated. See [ADR 0010](docs/adr/0010-workspace-progress.md) for metrics,
purge rules, query limits and the free MIT Recharts library choice.
