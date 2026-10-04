# CLAUDE.md — conventions for working in this repo

Meeting Hub is a modular monolith: **web** (Next.js), **api** (Fastify) and **worker** (BullMQ) in one
pnpm + Turborepo workspace. Read `docs/adr/0001-modular-monolith-and-stack.md` before changing architecture (and ADR 0002 for auth,
ADR 0003 for meetings and uploads).
Ask before changing anything recorded in an ADR; record new architectural decisions as a new ADR.

## Commands

```bash
pnpm infra:up && pnpm db:migrate && pnpm dev   # full local stack
pnpm lint && pnpm typecheck && pnpm test       # must pass before every commit
pnpm format                                    # Prettier (any package); the pre-commit hook formats staged files
pnpm test:integration                          # Testcontainers; needs Docker
pnpm test:e2e                                  # Playwright smoke test; needs infra + migrated DB
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
apps/web/src/proxy.ts             optimistic auth redirect (Next.js Proxy); real checks are server-side
apps/web/e2e/                     Playwright smoke test (Mailpit for email)
```

## Module boundary rules (enforced by `eslint-plugin-boundaries`)

- `lib/` imports only `lib/`.
- `modules/<x>` imports `lib/` and **other modules only via `modules/<y>/index.ts`** — never internals.
- `http/` and `jobs/` import `lib/` and modules' `index.ts`.
- Entry points / `app.ts` / `deps.ts` wire everything and may import anything.
- Don't silence `boundaries/dependencies`; if a rule blocks you, the design needs discussing.
- New domain module = new folder in `src/modules/` with an `index.ts` exporting its public API.

## Feature flags

User-facing features under development get a feature flag. Foundational CRUD that other features depend on
(e.g. meetings) does not. To gate a feature:

1. Add the key to `apps/server/src/modules/platform/flags/definitions.ts` with a safe default (usually `false`).
2. Check `flags.isEnabled('<key>', { workspaceId })` at the feature's entry point (route, job, UI-facing API).
3. Turn it on via a `feature_flags` row (global: `workspace_id IS NULL`) or `FEATURE_FLAGS_OVERRIDE` locally.
4. Remove the flag and dead branch once the feature is fully rolled out.

## Auth, workspaces and authorization (ADR 0002)

- Better Auth is mounted on the API at `/api/auth/*` (allowlist in `http/routes/auth.ts`); the web app proxies
  `/api/auth/*` and `/v1/*` so the browser is same-origin. A Better Auth "organization" **is** a workspace:
  say "workspace" in code, API and UI; Better Auth's tables keep their names.
- **Every `/v1` route declares `config.access`**: `{ kind: 'public' }`, `{ kind: 'authenticated' }` or
  `{ kind: 'workspace', action, flag?, workspaceFrom?, unlessSelf? }`. `http/access.ts` enforces it in one
  `onRequest` hook (requireSession → requireWorkspace → flag → `authorize`). A `/v1` route without it fails at startup.
- **Permissions are data**: `modules/auth/authorization/permissions.ts` (role × action). `authorize(actor, action,
resource)` and Better Auth's access-control roles are both derived from it. Add an action there, never an
  ad-hoc role check. Relationship rules (no granting above your role, admins can't touch owners, last owner)
  live in `role-rules.ts`.
- **404, not 403, across tenants**: not a member / wrong workspace / unknown id → 404 (`requireWorkspace`).
  403 only for members whose role lacks the action.
- **Workspace-scoped repositories**: every method on a tenant-owned table takes `workspaceId` (or resolves it through
  the caller's membership). No unscoped "find by id" for tenant data.
- Workspace mutations go through our services, which call Better Auth server-side (`auth.api.*` via `callAuth`) after
  our checks, then write side effects (settings, people, audit). Don't expose Better Auth's `/organization/*` endpoints.
- **Audit**: record security-relevant actions with `AuditService.record` (actions listed in `modules/audit`).
  `audit_logs` is append-only (DB trigger). Never put passwords, tokens or meeting content in `metadata`.
- **Authorization matrix test** (`apps/server/test/authorization-matrix.int.test.ts`) runs every `/v1` route × owner/
  admin/member/viewer/non-member/signed-out plus cross-workspace 404s. **A new route needs an entry in its `ROUTES`
  table** (access + how to build a valid request), or the test fails.
- Better Auth schema: `pnpm --filter @meeting-hub/server auth:schema` regenerates the CLI's view; reconcile with
  `packages/db/src/schema/auth.ts`, then `pnpm db:generate`.

## Code conventions

- TypeScript strict; no `any` without a comment explaining why. Validate all external input with Zod.
- Web: Next.js 16 has breaking changes from older versions (APIs, conventions, file layout). Read the matching guide
  in `apps/web/node_modules/next/dist/docs/` before writing web code, and heed deprecation notices.
  `agentRules: false` in `next.config.ts` stops `next dev` from writing its own `apps/web/AGENTS.md`/`CLAUDE.md`.
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

## Meetings, uploads and storage (ADR 0003)

- **Bytes never pass through the API.** Browsers upload recordings straight to S3 with presigned multipart URLs;
  the API only creates, signs, completes and aborts uploads (`modules/media`) and keeps Postgres in step
  (`modules/meetings`). Never add a route that accepts file bodies.
- **Storage keys** come only from `modules/media/storage-keys.ts`: `ws/{workspaceId}/meetings/{meetingId}/<kind>/{uuid}`.
  Never put file names or other user input in a key; the original name lives in `recordings.original_filename`.
  Everything a meeting owns sits under its `ws/{wid}/meetings/{mid}/` prefix — deletion sweeps that prefix.
- Presign with `deps.s3Signer` (`S3_PUBLIC_ENDPOINT`), call storage with `deps.s3`. The S3 client computes
  checksums only `WHEN_REQUIRED`; don't change that or presigned part URLs break in browsers.
- **Upload rules** (type allowlist, default size limit) live in `@meeting-hub/contracts/upload-rules` (no Zod) and are
  shared by API and web; the API's `MAX_UPLOAD_BYTES` is what's enforced.
- Bucket **CORS must allow the web origin and expose `ETag`** (set by `infra/garage/init.sh` locally; see README for
  production). Without it browser uploads can't complete — and only browsers notice.
- **Outbox:** state changes other modules/phases react to write a `domain_events` row in the **same transaction**
  (e.g. `recording.uploaded` in `UploadTx.markUploaded`). Payload: ids and storage keys, never meeting content.
  Event types are stable strings; consumers must be idempotent.
- **Idempotency:** retried client operations take an `Idempotency-Key` (unique per workspace); completion locks the
  recording row (`withLockedUpload`) so repeats return the same result without side effects.
- Deleting tenant data with storage behind it = soft delete (`deleted_at`, filtered everywhere) + a maintenance job
  that removes objects, then rows, then audits; an hourly sweep re-enqueues anything left behind.
- Members may edit/upload only meetings they created (`authorization/meeting-rules.ts`) → 403, not 404.
- Integration tests use a real Garage container (`test/support/garage.ts`) — don't stub S3 on upload paths.

## Testing expectations

- Unit tests (`*.test.ts`) for any logic: pure functions, services with injected fakes, error mapping.
- Integration tests (`*.int.test.ts`) with Testcontainers for anything touching Postgres/Redis
  (migrations, repositories, routes end-to-end, job processing). Use `pgvector/pgvector:0.8.7-pg18-trixie`.
- New routes: at least one `app.inject` test for the happy path and one for the problem+json error path.
- New flags: test both on and off paths.
- Server integration tests share one Postgres/Redis/Garage per run (`test/support/global-setup.ts`); build the app with
  `createTestApp()` from `test/support/harness.ts` and isolate with unique emails (`uniqueEmail`).
- New `/v1` routes: add them to the authorization matrix test's `ROUTES` table.
- E2E (`apps/web/e2e`, Playwright) covers the main browser flow only; keep it to smoke tests.

## Git

- Conventional commits (`feat(scope):`, `fix:`, `chore:`, `test:`, `docs:`, `build:`), small and logical.
- Never commit `.env` or real secrets. Local dev credentials live only in `.env.example` / `docker-compose.yml`.
- Never run Prettier on generated files (`openapi.json`, `schema.d.ts`, migration snapshots). Every `format` script
  passes the root `.prettierignore` and `.gitignore` explicitly, and the pre-commit hook (simple-git-hooks + lint-staged)
  formats only staged files with the same ignore files. Don't run bare `prettier .` inside a package.

## Out of scope until their phase

Processing runs, ffmpeg/ffprobe and outbox consumers (Phase 4), transcription, AI/LLM calls, embeddings, search, 2FA/SSO, Postgres RLS (hardening),
production email provider, deployment. Do not create `packages/ai` or `evals/` until those phases start.
