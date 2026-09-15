/**
 * Server-side API access for Server Components. Fetches the Fastify API
 * directly (no rewrite hop) using the same base URL as next.config's
 * rewrites: API_INTERNAL_URL (Docker) ?? API_URL ?? http://localhost:3001.
 *
 * Every call is `cache: 'no-store'` — this is a live operations panel, and
 * all pages using it are `export const dynamic = 'force-dynamic'`.
 *
 * Never import this module from a client component.
 */

const API_URL = process.env.API_INTERNAL_URL ?? process.env.API_URL ?? 'http://localhost:3001';

export class ServerApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'ServerApiError';
    }
}

export async function serverApiGet<T>(path: string): Promise<T> {
    const url = new URL(path, API_URL);
    let res: Response;
    try {
        res = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
    } catch (err) {
        throw new ServerApiError(0, 'NETWORK', err instanceof Error ? err.message : 'API unreachable');
    }
    if (!res.ok) {
        let code = 'INTERNAL';
        let message = `API request failed (HTTP ${res.status})`;
        try {
            const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
            if (typeof body.error?.code === 'string') code = body.error.code;
            if (typeof body.error?.message === 'string') message = body.error.message;
        } catch {
            // Non-JSON error body — keep the generic message.
        }
        throw new ServerApiError(res.status, code, message);
    }
    return (await res.json()) as T;
}

export { API_URL };
