# CLAUDE.md — conventions for working in this repo

Meeting Hub is a modular monolith: **web** (Next.js), **api** (Fastify) and **worker** (BullMQ) in one
pnpm + Turborepo workspace. Read `docs/adr/0001-modular-monolith-and-stack.md` before changing architecture.
Ask before changing anything recorded in an ADR; record new architectural decisions as a new ADR.

## Commands

```bash
pnpm infra:up && pnpm db:migrate && pnpm dev   # full local stack
pnpm lint && pnpm typecheck && pnpm test       # must pass before every commit
pnpm test:integration                          # Testcontainers; needs Docker
pnpm db:generate                               # after editing packages/db/src/schema
pnpm openapi:export                            # after changing any API route or contract
pnpm --filter @meeting-hub/server <script>     # run a script in one package
```

## Layout

```
apps/server/src/
  api.ts, worker.ts, migrate.ts   entry points (composition only)
  app.ts, deps.ts                 Fastify app factory and dependency wiring
  http/                           routes, error handler, request IDs, readiness
  jobs/                           queues, default job options, processors
  modules/<name>/                 domain modules; public API is index.ts
  lib/                            config, logger, errors, db, redis, s3 (no domain logic)
packages/db/                      Drizzle schema (src/schema) + SQL migrations (migrations/)
packages/contracts/               Zod request/response schemas + exported openapi.json
packages/config/                  tsconfig bases, ESLint flat config, Prettier
apps/web/src/lib/api/             openapi-fetch client; schema.d.ts is GENERATED
```

## Module boundary rules (enforced by `eslint-plugin-boundaries`)

- `lib/` imports only `lib/`.
- `modules/<x>` imports `lib/` and **other modules only via `modules/<y>/index.ts`** — never internals.
- `http/` and `jobs/` import `lib/` and modules' `index.ts`.
- Entry points / `app.ts` / `deps.ts` wire everything and may import anything.
- Don't silence `boundaries/dependencies`; if a rule blocks you, the design needs discussing.
- New domain module = new folder in `src/modules/` with an `index.ts` exporting its public API.

## Every new feature goes behind a feature flag

1. Add the key to `apps/server/src/modules/platform/flags/definitions.ts` with a safe default (usually `false`).
2. Check `flags.isEnabled('<key>', { workspaceId })` at the feature's entry point (route, job, UI-facing API).
3. Turn it on via a `feature_flags` row (global: `workspace_id IS NULL`) or `FEATURE_FLAGS_OVERRIDE` locally.
4. Remove the flag and dead branch once the feature is fully rolled out.

## Code conventions

- TypeScript strict; no `any` without a comment explaining why. Validate all external input with Zod.
- Config: add new env vars to `lib/config.ts` **and** `.env.example` (with a comment). Never read `process.env` elsewhere.
- Errors: throw `AppError` subclasses with a stable `UPPER_SNAKE` `code`; never rename an existing code.
  API errors are `application/problem+json`. In jobs, throw `PermanentError` for non-retryable failures
  and `RetryableError` (or any error) for transient ones.
- Logging: use the injected pino logger (`req.log` in routes); no `console`. Never log meeting content —
  fields named `transcript`, `text`, `content` are redacted, so keep those names for such data.
- DB: schema changes only via `pnpm db:generate` → review the SQL → commit migration + snapshot.
  UUIDv7 primary keys (`DEFAULT uuidv7()`). Timestamps are `timestamptz`.
  Hand-written SQL (extensions, data fixes) goes into the generated migration file or `drizzle-kit generate --custom`.
- Cross-module side effects: write a `domain_events` row in the same transaction (outbox).
- API contracts: define schemas in `packages/contracts` with `.meta({ id })`, use them in routes,
  then `pnpm openapi:export` and commit `openapi.json` + `schema.d.ts` (CI fails on drift).
- Jobs: add queue names to `jobs/queues.ts`; rely on `defaultJobOptions`; make processors idempotent.
- Pin exact dependency versions; check the latest stable version before adding one.

## Testing expectations

- Unit tests (`*.test.ts`) for any logic: pure functions, services with injected fakes, error mapping.
- Integration tests (`*.int.test.ts`) with Testcontainers for anything touching Postgres/Redis
  (migrations, repositories, routes end-to-end, job processing). Use `pgvector/pgvector:0.8.7-pg18-trixie`.
- New routes: at least one `app.inject` test for the happy path and one for the problem+json error path.
- New flags: test both on and off paths.

## Git

- Conventional commits (`feat(scope):`, `fix:`, `chore:`, `test:`, `docs:`, `build:`), small and logical.
- Never commit `.env` or real secrets. Local dev credentials live only in `.env.example` / `docker-compose.yml`.

## Out of scope until their phase

Auth/workspaces (Phase 2, Better Auth), meetings/uploads, transcription, AI/LLM calls, embeddings, search,
deployment. Do not create `packages/ai` or `evals/` until those phases start.
