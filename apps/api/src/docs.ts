/**
 * OpenAPI documentation helpers.
 *
 * Route `schema` slots carry JSON Schemas converted from the same Zod
 * schemas the handlers validate with (parseWith). app.ts installs a NO-OP
 * validator compiler, so these schemas are documentation-only — runtime
 * validation stays with Zod (which produces the uniform VALIDATION_ERROR
 * shape and handles query-string coercion). Response schemas are
 * deliberately NOT attached: Fastify would switch serialization to
 * fast-json-stringify and silently drop undeclared fields.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';

/** OpenAPI tags — one per route domain (ARCHITECTURE §7). */
export const API_TAGS = [
    { name: 'system', description: 'Health and liveness' },
    { name: 'dashboard', description: 'Aggregated operator dashboard metrics' },
    { name: 'listings', description: 'Listing search, detail, price history, CSV export' },
    { name: 'scans', description: 'Scan definition CRUD and run triggers' },
    { name: 'runs', description: 'Run inspection, control, event replay and live SSE stream' },
    { name: 'proxies', description: 'Proxy profiles and endpoints (credentials are write-only)' },
    { name: 'cookies', description: 'Cookie profiles (cookie material is write-only, metadata reads only)' },
    { name: 'sessions', description: 'Session policies' },
    { name: 'settings', description: 'Editable application settings (code-defined keys only)' },
] as const;

/**
 * Zod → JSON Schema (draft-07 subset) for the route `schema` slot.
 * The `$schema` key is stripped — the OpenAPI 3.1 document already pins the
 * dialect. Effects (transform/refine) unwrap to their inner schema, which is
 * exactly what the wire looks like after Zod coercion.
 */
export function doc(schema: z.ZodTypeAny): Record<string, unknown> {
    const jsonSchema = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    return jsonSchema;
}

interface RouteDoc {
    tags: readonly string[];
    summary: string;
    description?: string;
    params?: z.ZodTypeAny;
    querystring?: z.ZodTypeAny;
    body?: z.ZodTypeAny;
}

/** Builds the Fastify route `schema` slot for docs (tags + summary + converted Zod schemas). */
export function routeDoc(route: RouteDoc): Record<string, unknown> {
    return {
        tags: route.tags,
        summary: route.summary,
        ...(route.description !== undefined ? { description: route.description } : {}),
        ...(route.params !== undefined ? { params: doc(route.params) } : {}),
        ...(route.querystring !== undefined ? { querystring: doc(route.querystring) } : {}),
        ...(route.body !== undefined ? { body: doc(route.body) } : {}),
    };
}
