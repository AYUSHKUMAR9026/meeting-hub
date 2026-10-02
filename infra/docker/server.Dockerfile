# syntax=docker/dockerfile:1.7
# Meeting Hub server image: one image, three commands — api | worker | migrate.
# Build from the repo root: docker build -f infra/docker/server.Dockerfile -t meeting-hub-server .

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm install -g pnpm@12.8.1 && npm cache clean --force
WORKDIR /repo

# --- Install dependencies (cached unless manifests change) -------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@meeting-hub/server..."

# --- Build and assemble a production-only node_modules -----------------------
FROM deps AS build
COPY . .
RUN pnpm --filter @meeting-hub/server build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @meeting-hub/server deploy --prod --legacy /out

# --- Runtime -----------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/apps/server/dist ./dist
COPY --from=build --chown=node:node /repo/packages/db/migrations ./migrations
COPY --chown=node:node infra/docker/server-entrypoint.sh /usr/local/bin/server-entrypoint
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD [ "$SERVER_ROLE" != "api" ] || wget -qO- "http://127.0.0.1:${API_PORT:-4000}/health" >/dev/null || exit 1
# tini forwards SIGTERM to node so graceful shutdown runs.
ENTRYPOINT ["/sbin/tini", "--", "server-entrypoint"]
CMD ["api"]
