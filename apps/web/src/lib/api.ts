/**
 * Client-side API wrapper. Browser code only ever calls same-origin relative
 * `/api/...` paths; next.config rewrites proxy them to the Fastify API.
 * Errors are typed: ApiError carries the uniform API error shape
 * ({ error: { code, message, details.issues[] } }) so forms can map 400
 * validation issues back to fields.
 */

export interface ApiValidationIssue {
    path: string;
    message: string;
    code: string;
}

export class ApiError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly issues: ApiValidationIssue[] = [],
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

interface ErrorBody {
    error?: {
        code?: unknown;
        message?: unknown;
        details?: unknown;
    };
}

function toIssues(details: unknown): ApiValidationIssue[] {
    if (typeof details !== 'object' || details === null) return [];
    const issues = (details as { issues?: unknown }).issues;
    if (!Array.isArray(issues)) return [];
    return issues
        .map((issue): ApiValidationIssue | null => {
            if (typeof issue !== 'object' || issue === null) return null;
            const i = issue as Record<string, unknown>;
            if (typeof i.path !== 'string' || typeof i.message !== 'string') return null;
            return { path: i.path, message: i.message, code: typeof i.code === 'string' ? i.code : 'custom' };
        })
        .filter((i): i is ApiValidationIssue => i !== null);
}

async function parseErrorResponse(res: Response): Promise<ApiError> {
    let body: ErrorBody | null = null;
    try {
        body = (await res.json()) as ErrorBody;
    } catch {
        // Non-JSON error body (proxy failure, HTML error page, …).
    }
    const code = typeof body?.error?.code === 'string' ? body.error.code : 'INTERNAL';
    const message =
        typeof body?.error?.message === 'string' ? body.error.message : `İstek başarısız (HTTP ${res.status})`;
    return new ApiError(res.status, code, message, toIssues(body?.error?.details));
}

export interface ApiRequestInit extends Omit<RequestInit, 'body'> {
    /** JSON-serialized body (content-type set automatically). */
    json?: unknown;
}

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
    const { json, headers, ...rest } = init;
    let res: Response;
    try {
        res = await fetch(path, {
            ...rest,
            headers: {
                ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
                ...headers,
            },
            body: json !== undefined ? JSON.stringify(json) : undefined,
        });
    } catch (err) {
        throw new ApiError(0, 'NETWORK', err instanceof Error ? err.message : 'Ağ hatası');
    }
    if (!res.ok) throw await parseErrorResponse(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
}

export function apiGet<T>(path: string): Promise<T> {
    return apiFetch<T>(path);
}

export function apiPost<T>(path: string, json?: unknown): Promise<T> {
    return apiFetch<T>(path, { method: 'POST', json });
}

export function apiPatch<T>(path: string, json: unknown): Promise<T> {
    return apiFetch<T>(path, { method: 'PATCH', json });
}

export function apiDelete(path: string): Promise<void> {
    return apiFetch<void>(path, { method: 'DELETE' });
}
