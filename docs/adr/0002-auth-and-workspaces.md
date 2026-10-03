# ADR 0002: Authentication and workspaces

- **Status:** Accepted
- **Date:** 2026-10-03

## Context

Phase 2 adds user accounts and multi-tenant workspaces. Every later feature (meetings, uploads,
transcripts, the decision ledger) is owned by a workspace, so tenancy, roles and the "who can see what"
rules have to be right before any product data exists. We want a maintained auth library rather than
hand-rolled password, session, verification and OAuth code, and we want authorization rules that are
easy to review and impossible to forget on a new route.

## Decision

### Library: Better Auth (Drizzle adapter, organization plugin)

- `better-auth` with `drizzleAdapter(db, { provider: 'pg' })` and the `organization` plugin.
  Teams and dynamic roles are **off**.
- Sign-in methods: email + password (email verification required, password reset), plus Google OAuth
  when `GOOGLE_CLIENT_ID/SECRET` are set **and** the `auth.google_signin` flag is on.
- Sessions are database sessions (`session` table) read on every request. The cookie cache is **off**,
  so revoking a session or removing a member takes effect on the very next request.

### A Better Auth "organization" is our "workspace"

- Better Auth's tables (`user`, `session`, `account`, `verification`, `organization`, `member`,
  `invitation`) stay the source of truth and keep Better Auth's names.
- The `workspaces` module wraps them. API paths, contracts, UI and our own code say **workspace**;
  the word "organization" only appears where we call Better Auth or reference its tables.
- Our own tenant tables reference `organization.id` as `workspace_id`: `workspace_settings`, `people`,
  `audit_logs`, and `feature_flags.workspace_id` (new FK, `ON DELETE CASCADE`).

### Roles and permissions: one matrix, two consumers

- Roles per workspace: `owner > admin > member > viewer`.
- The role × action matrix lives as **data** in one file
  (`apps/server/src/modules/auth/authorization/permissions.ts`). From it we derive:
  1. our `authorize(actor, action, resource)` function, used by every `/v1` route, and
  2. Better Auth's access-control roles (`createAccessControl` + `ac.newRole`), including the
     custom `viewer` role, so Better Auth's internal checks agree with ours.
- Relationship rules that a matrix can't express live next to it as pure functions:
  nobody grants a role above their own, admins cannot modify owners, and the last owner cannot
  leave, be removed or be demoted.

### Not found vs forbidden

A user asking for a workspace (or a workspace-owned resource) they are not a member of gets **404**,
never 403, so existence is not leaked. 403 is only returned to members whose role lacks a permission.
`requireWorkspace` resolves the workspace from the path, checks membership, and attaches
`{ userId, workspaceId, role }` to the request. Repositories for tenant-owned tables take `workspaceId`
as a required argument and have no unscoped query methods.

### HTTP surface: same origin, Better Auth mounted on Fastify

- The Next.js app rewrites `/api/auth/*` and `/v1/*` to the Fastify API in development **and**
  production. The browser only ever talks to the web origin, so cookies are first-party:
  `httpOnly`, `SameSite=Lax`, `Secure` in production. `BETTER_AUTH_URL` is the **web** origin.
- Better Auth's handler is mounted on Fastify under `/api/auth/*`, not in Next.js.
- Only the endpoints the browser needs are exposed there (sign-up/in/out, session, verification,
  password reset, social sign-in). Better Auth's `/organization/*` endpoints are **not** reachable over
  HTTP. Our `/v1` routes call them server-side through `auth.api.*` after our own checks, so every
  workspace mutation goes through `authorize()`, the role rules, audit and people side effects.
  We wrap Better Auth's organization logic; we don't reimplement it.

### IDs

Better Auth supports custom ID generation. We set `advanced.database.generateId: 'uuid'`. With the
Drizzle adapter on Postgres that makes Better Auth omit the `id` on insert and rely on the column
default, which our schema sets to Postgres 18's `uuidv7()`. So **every** table, Better Auth's
included, has UUIDv7 primary keys of type `uuid`, consistent with ADR 0001.

### Schema ownership

The Better Auth schema is generated with the Better Auth CLI (`auth generate`, via
`pnpm --filter @meeting-hub/server auth:schema`) and then committed as reviewed Drizzle schema in
`packages/db/src/schema/auth.ts`, changed only to use `uuidv7()` defaults and `timestamptz`.
Migrations are produced by `drizzle-kit generate` like every other table. Better Auth's runtime schema
validation stays on, so drift between its expectations and our schema fails loudly at startup and in
integration tests.

### Consistency between Better Auth writes and ours

Better Auth writes through its own adapter calls, so its rows and our follow-up rows
(`workspace_settings`, `people`, `audit_logs`) are not in one transaction. Follow-up writes are
idempotent (`ON CONFLICT DO NOTHING` / upsert-by-email), so a retry heals a partial failure, and reads
fall back to defaults when a settings row is missing. We accept this rather than bypass the library.

### Email

A small `Mailer` interface with an SMTP implementation (nodemailer). Locally, SMTP goes to **Mailpit**
(added to `infra/docker-compose.yml`, UI on :8025). Tests use an in-memory mailer or Mailpit's API.
A production provider is a later decision.

### Rate limiting

- Better Auth's own rate limiter is on, backed by Redis through its `customStorage` hook.
- `@fastify/rate-limit` (Redis store) adds stricter per-IP limits on sign-in, sign-up, password reset
  and invitation endpoints. Both fail open if Redis is unreachable; `RATE_LIMIT_ENABLED=false` turns
  them off for tests.

### Audit log

`audit_logs` is append-only (the app never updates or deletes rows). It records sign-in, sign-out,
failed sign-in, workspace created/updated, member invited/joined/removed, role changed, invitation
revoked and people created/updated/deleted, with the actor, IP and user agent. Passwords and tokens are
never written to it.

### People directory

`people` is the per-workspace directory of humans who appear in meetings, whether or not they are
users. Creating a workspace creates a row for the creator; joining a workspace creates or links (by
email) a row for the new member.

## Consequences

- **+** No hand-written password hashing, session, verification or OAuth code.
- **+** One permission matrix drives both our checks and Better Auth's, and an auto-generated test
  (every `/v1` route × every role) makes a forgotten check fail CI.
- **+** First-party cookies on one origin: no CORS-with-credentials or third-party cookie issues.
- **−** Better Auth's table names (`organization`, `member`) differ from our vocabulary; the
  `workspaces` module is the translation layer.
- **−** Better Auth and our tables are not written atomically (see above); follow-ups must stay idempotent.
- **−** Every API request reads the session and membership from Postgres. Fine at our scale; a short
  cache would trade immediacy of revocation for load and would need its own ADR.
- **−** The last-owner check is not serialised; two owners demoting each other concurrently could
  leave none. Acceptable for now, revisit in hardening.

## Alternatives considered

- **Auth.js / Lucia / hand-rolled** — Auth.js has no first-class organizations/roles; Lucia is
  deprecated as a library; hand-rolling auth is not where we add value.
- **Mount Better Auth in Next.js** — would split auth and the API across two processes and two DB
  pools, and put session checks for `/v1` in a different runtime than the API.
- **Separate `workspaces` table mirroring `organization`** — two sources of truth to keep in sync.
- **Return 403 for non-members** — leaks which workspace IDs exist.
- **Expose Better Auth's organization endpoints directly** — would bypass our role rules, audit and
  people side effects.

## Implementation notes (added while building Phase 2)

- **Route access is declarative.** Each `/v1` route sets `config.access`; one `onRequest` hook in
  `apps/server/src/http/access.ts` runs requireSession → requireWorkspace → feature flag → `authorize()` _before_
  body validation, so callers without access learn nothing about a route's schema. Services call `authorize()`
  again as a second line of defence.
- **Two routes beyond the original list:** `GET /v1/auth/providers` (public; lets the sign-in page know whether
  Google is available) and `GET /v1/invitations/{id}` (the accept page shows who invited you to what). The accept
  flow itself is `POST /v1/invitations/{id}/accept`. All three wrap Better Auth.
- **The API addresses workspaces by id, the web app by slug.** `/w/[slug]` resolves the slug from
  `GET /v1/workspaces` (the caller's own list), so a slug never reveals a workspace the caller can't see.
- **Client IP.** Next.js rewrites pass `X-Forwarded-For` through unchanged and add none of their own, so the API
  trusts exactly `TRUST_PROXY_HOPS` (default 1, the web server) for `request.ip`. Behind a load balancer that
  appends the client address this yields the real client; locally it is the web server's address. Better Auth
  only accepts a single-valued `X-Forwarded-For`, so its audit rows have no IP in local dev.
- **Emails are sent in the background** (not awaited) so response time doesn't reveal whether an account exists.
- **Same origin in development too:** the Next.js Proxy (`src/proxy.ts`) does an optimistic cookie-presence check;
  every page re-checks the session server-side through `GET /v1/me`, and the API enforces everything.
