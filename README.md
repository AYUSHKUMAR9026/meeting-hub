# Meeting Hub

AI meeting-intelligence platform: upload recordings, get transcripts with speakers, and a persistent,
evidence-linked ledger of decisions and action items across meetings.

> **Status: Phase 1 — foundation.** Infrastructure, API/worker skeleton, feature flags, CI. No product
> features yet.

## Prerequisites

- **Node.js 24 LTS** (see `.nvmrc`; `nvm use`)
- **pnpm 12** — `npm install -g pnpm@12`
- **Docker** with Compose v2 (Docker Desktop, OrbStack, or Docker Engine)

## Setup

```bash
git clone <repo-url> meeting-hub && cd meeting-hub
pnpm install
cp .env.example .env        # local-dev defaults; works as-is
pnpm infra:up               # Postgres+pgvector, Redis, Garage S3 (+ bucket)
pnpm db:migrate
pnpm dev                    # web :3000, api :4000, worker
```

Open <http://localhost:3000/status>: PostgreSQL, Redis and S3 should all show **Healthy**.

## Commands

| Command                   | What it does                                                         |
| ------------------------- | -------------------------------------------------------------------- |
| `pnpm dev`                | Web, API and worker with hot reload                                  |
| `pnpm build`              | Production builds (server bundle, Next.js standalone)                |
| `pnpm lint`               | ESLint (incl. module-boundary rules)                                 |
| `pnpm typecheck`          | `tsc --noEmit` everywhere                                            |
| `pnpm test`               | Unit tests (Vitest)                                                  |
| `pnpm test:integration`   | Integration tests with Testcontainers (needs Docker)                 |
| `pnpm format`             | Prettier                                                             |
| `pnpm infra:up` / `:down` | Start / stop local infrastructure (`infra:reset` also wipes volumes) |
| `pnpm db:generate`        | Generate a SQL migration from the Drizzle schema                     |
| `pnpm db:migrate`         | Apply migrations                                                     |
| `pnpm db:studio`          | Drizzle Studio                                                       |
| `pnpm openapi:export`     | Export OpenAPI → `packages/contracts` and regenerate the web client  |

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
| http://localhost:3000/status          | Dependency status page                       |
| http://localhost:4000/health          | Liveness                                     |
| http://localhost:4000/ready           | Readiness (Postgres, Redis, S3); 503 if down |
| http://localhost:4000/v1/system/flags | Evaluated feature flags (non-production)     |
| http://localhost:4000/openapi.json    | OpenAPI 3.1 document (non-production)        |
| localhost:5432 / 6379 / 3900          | Postgres / Redis / Garage S3 API             |

## Docker images

```bash
docker build -f infra/docker/server.Dockerfile -t meeting-hub-server .
docker build -f infra/docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_URL=http://localhost:4000 -t meeting-hub-web .

docker run meeting-hub-server migrate   # apply migrations
docker run meeting-hub-server api       # default
docker run meeting-hub-server worker
```

Both images run as the non-root `node` user. `NEXT_PUBLIC_API_URL` is baked into the web bundle at build time.

## Troubleshooting

- **Port already in use** — something else is on 5432/6379/3900/3000/4000. Stop it or change the port
  mapping in `infra/docker-compose.yml` and the matching URL in `.env`.
- **Config error on start** — the process prints every invalid/missing variable; compare with `.env.example`.
- **S3 down on `/status`** — run `pnpm infra:up` again; it waits for the `garage-init` job that creates the bucket.

See [`CLAUDE.md`](CLAUDE.md) for conventions and [`docs/adr`](docs/adr) for design decisions.
