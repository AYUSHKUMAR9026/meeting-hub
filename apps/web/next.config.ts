import { join } from 'node:path';

import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: 'standalone',
  // Trace files from the monorepo root so workspace dependencies are included.
  outputFileTracingRoot: join(import.meta.dirname, '../..'),
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
