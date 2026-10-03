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
  reactStrictMode: true,
  rewrites() {
    return Promise.resolve([
      { source: '/api/auth/:path*', destination: `${apiUrl}/api/auth/:path*` },
      { source: '/v1/:path*', destination: `${apiUrl}/v1/:path*` },
      { source: '/ready', destination: `${apiUrl}/ready` },
    ]);
  },
};

export default nextConfig;
