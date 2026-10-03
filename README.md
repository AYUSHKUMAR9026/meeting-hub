# Meeting Hub

AI meeting-intelligence platform: upload recordings, get transcripts with speakers, and a persistent,
evidence-linked ledger of decisions and action items across meetings.

> **Status: Phase 3 — meetings & uploads.** Accounts and workspaces with roles, invitations, a people directory and
> an audit log (Phase 2), plus meetings with participants and recordings of up to 2 GB uploaded **straight from the
> browser to object storage** (resumable multipart, ADR 0003). Processing and transcription come in Phase 4.

## Prerequisites

- **Node.js 24 LTS** (see `.nvmrc`; `nvm use`)
- **pnpm 12** — `npm install -g pnpm@12`
- **Docker** with Compose v2 (Docker Desktop, OrbStack, or Docker Engine)

## Setup

```bash
git clone <repo-url> meeting-hub && cd meeting-hub
pnpm install
cp .env.example .env        # local-dev defaults; works as-is
pnpm infra:up               # Postgres+pgvector, Redis, Garage S3 (+ bucket), Mailpit
pnpm db:migrate
pnpm dev                    # web :3000, api :4000, worker
```

Open <http://localhost:3000>, create an account, and click the verification link in **Mailpit**
(<http://localhost:8025>) — every email the app sends lands there. After verifying you're asked to create a
workspace; invite a teammate from **Settings → Members** (their invitation is in Mailpit too). Under **Meetings → New
meeting**, add a title, participants and an audio/video file and upload it; the bytes go from the browser straight to
Garage, never through the API. Deleting a meeting hides it at once; the **worker** (part of `pnpm dev`) then purges its
files from storage.
<http://localhost:3000/status> shows PostgreSQL, Redis and S3 health.

## Commands

| Command                                         | What it does                                                         |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm dev`                                      | Web, API and worker with hot reload                                  |
| `pnpm build`                                    | Production builds (server bundle, Next.js standalone)                |
| `pnpm lint`                                     | ESLint (incl. module-boundary rules)                                 |
| `pnpm typecheck`                                | `tsc --noEmit` everywhere                                            |
| `pnpm test`                                     | Unit tests (Vitest)                                                  |
| `pnpm test:integration`                         | Integration tests with Testcontainers (needs Docker)                 |
| `pnpm test:e2e`                                 | Playwright smoke test (needs `infra:up` + `db:migrate`)              |
| `pnpm format`                                   | Prettier                                                             |
| `pnpm infra:up` / `:down`                       | Start / stop local infrastructure (`infra:reset` also wipes volumes) |
| `pnpm db:generate`                              | Generate a SQL migration from the Drizzle schema                     |
| `pnpm db:migrate`                               | Apply migrations                                                     |
| `pnpm db:studio`                                | Drizzle Studio                                                       |
| `pnpm openapi:export`                           | Export OpenAPI → `packages/contracts` and regenerate the web client  |
| `pnpm --filter @meeting-hub/server auth:schema` | Better Auth CLI's view of its schema, for review                     |

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

## Feature flags

| Flag                     | Default (dev / other) | What it gates                                         |
| ------------------------ | --------------------- | ----------------------------------------------------- |
| `workspaces.invitations` | on / off              | Inviting people and accepting invitations             |
| `people.directory`       | on / off              | People directory API and settings page                |
| `meetings.upload`        | on / off              | Recording upload endpoints and uploader UI            |
| `auth.google_signin`     | off / off             | "Continue with Google" (also needs `GOOGLE_CLIENT_*`) |

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

## Docker images

```bash
docker build -f infra/docker/server.Dockerfile -t meeting-hub-server .
docker build -f infra/docker/web.Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t meeting-hub-web .

docker run meeting-hub-server migrate   # apply migrations
docker run meeting-hub-server api       # default
docker run meeting-hub-server worker
```

Both images run as the non-root `node` user. `API_INTERNAL_URL` (where the web server proxies `/api/auth/*` and
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

See [`CLAUDE.md`](CLAUDE.md) for conventions and [`docs/adr`](docs/adr) for design decisions.
