/**
 * Shared helpers for the UI e2e suite. API calls go straight to the Fastify
 * origin (:3001) so test setup/assertions don't depend on the Next rewrite.
 */

export const API_BASE = process.env.E2E_API_URL ?? 'http://localhost:3001';

export async function apiGet<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
    return (await res.json()) as T;
}

export async function apiDelete(path: string): Promise<number> {
    const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
    return res.status;
}

/** tr-TR grouping, mirroring the web app's formatNumber/toLocaleString usage. */
export function trNumber(value: number): string {
    return value.toLocaleString('tr-TR');
}
