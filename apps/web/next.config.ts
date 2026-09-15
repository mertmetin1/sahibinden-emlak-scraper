import type { NextConfig } from 'next';

/**
 * API WIRING (single consistent approach):
 * - The browser only ever talks to the Next.js origin. `/api/*` and `/health`
 *   are rewritten to the Fastify API — same-origin, so no CORS, and SSE
 *   streams proxy transparently through the rewrite.
 * - Server Components fetch the API directly via the same base URL
 *   (see src/lib/server-api.ts); client code uses relative `/api/...` paths
 *   (see src/lib/api.ts).
 * - Override the target with API_INTERNAL_URL (Docker: http://api:3001);
 *   API_URL is accepted as an alias. Default: local dev on :3001.
 */
const API_URL = process.env.API_INTERNAL_URL ?? process.env.API_URL ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
    async rewrites() {
        return [
            { source: '/api/:path*', destination: `${API_URL}/api/:path*` },
            { source: '/health', destination: `${API_URL}/health` },
        ];
    },
};

export default nextConfig;
