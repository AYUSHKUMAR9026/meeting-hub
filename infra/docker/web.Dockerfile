# syntax=docker/dockerfile:1.7
# Meeting Hub web image (Next.js standalone output).
# Build from the repo root:
#   docker build -f infra/docker/web.Dockerfile --build-arg API_INTERNAL_URL=http://api:4000 -t meeting-hub-web .

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@12.8.1 && npm cache clean --force
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@meeting-hub/web..."

FROM deps AS build
# Where the Next.js server proxies /api/auth/* and /v1/* (same-origin, ADR 0002).
# Rewrites are resolved at build time, so this is a build argument; the runtime env var of the
# same name is used for server-side API calls.
ARG API_INTERNAL_URL=http://localhost:4000
ENV API_INTERNAL_URL=$API_INTERNAL_URL
COPY . .
RUN pnpm --filter @meeting-hub/web build

FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
