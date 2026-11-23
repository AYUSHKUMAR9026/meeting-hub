import { join } from 'node:path';

import type { NextConfig } from 'next';

/**
 * Where the API listens, as seen from the Next.js server. The browser never calls it directly:
 * /api/auth/* and /v1/* are proxied so everything is same-origin (first-party cookies, no CORS).
 * Read when the config loads, so for `next build` it is baked into the build.
 */
const apiUrl = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: 'standalone',
  // Trace files from the monorepo root so workspace dependencies are included.
  outputFileTracingRoot: join(import.meta.dirname, '../..'),
  poweredByHeader: false,
  // `next dev` otherwise writes apps/web/AGENTS.md + CLAUDE.md when it detects a coding agent; the
  // repo's instructions live in the root CLAUDE.md only.
  agentRules: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@meeting-hub/contracts'],
  reactStrictMode: true,
  logging: {
    incomingRequests: {
      ignore: [
        /^\/share(?:\/|$)/,
        /^\/v1\/public\/shares(?:\/|$)/,
        /^\/v1\/workspaces\/[^/]+\/(?:decisions|action-items)(?:\?|$)/,
      ],
    },
  },
  headers() {
    return Promise.resolve([
      {
        source: '/share/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ]);
  },
  rewrites() {
    return Promise.resolve([
      { source: '/api/auth/:path*', destination: `${apiUrl}/api/auth/:path*` },
      { source: '/v1/:path*', destination: `${apiUrl}/v1/:path*` },
      { source: '/ready', destination: `${apiUrl}/ready` },
    ]);
  },
};

export default nextConfig;
