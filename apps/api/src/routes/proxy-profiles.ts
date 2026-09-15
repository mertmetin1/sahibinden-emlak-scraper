/**
 * Proxy profile & endpoint routes.
 *
 * SECRET HYGIENE (ARCHITECTURE §10): endpoint credentials are write-only.
 * The repository read paths already reduce them to hasUsername/hasPassword
 * presence booleans; the serializers below are a defense-in-depth whitelist —
 * only the listed fields can ever leave this process. The decryption path
 * (getEndpointCredentials) is worker-only and never called here.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ProxyEndpointRecordDto, ProxyProfileDetailDto, ProxyProfileRecordDto } from '../types.js';
import { routeDoc } from '../docs.js';
import { notFound, parseWith } from '../errors.js';
import {
    idParamSchema,
    proxyBulkImportSchema,
    proxyEndpointCreateSchema,
    proxyEndpointUpdateSchema,
    proxyProfileCreateSchema,
    proxyProfileUpdateSchema,
    toggleSchema,
} from '../schemas.js';

/** Whitelisted endpoint fields — credentials exist here only as booleans. */
function serializeEndpoint(endpoint: ProxyEndpointRecordDto): Record<string, unknown> {
    return {
        id: endpoint.id,
        profileId: endpoint.profileId,
        name: endpoint.name,
        host: endpoint.host,
        port: endpoint.port,
        protocol: endpoint.protocol,
        hasUsername: endpoint.hasUsername,
        hasPassword: endpoint.hasPassword,
        enabled: endpoint.enabled,
        weight: endpoint.weight,
        country: endpoint.country,
        notes: endpoint.notes,
        lastCheckedAt: endpoint.lastCheckedAt,
        lastSuccessAt: endpoint.lastSuccessAt,
        lastFailureAt: endpoint.lastFailureAt,
        successCount: endpoint.successCount,
        failureCount: endpoint.failureCount,
        latencyMs: endpoint.latencyMs,
        healthStatus: endpoint.healthStatus,
        quarantinedUntil: endpoint.quarantinedUntil,
        createdAt: endpoint.createdAt,
        updatedAt: endpoint.updatedAt,
    };
}

function serializeProfile(profile: ProxyProfileRecordDto): Record<string, unknown> {
    return {
        id: profile.id,
        name: profile.name,
        strategy: profile.strategy,
        enabled: profile.enabled,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
    };
}

function serializeProfileDetail(profile: ProxyProfileDetailDto): Record<string, unknown> {
    return { ...serializeProfile(profile), endpoints: profile.endpoints.map(serializeEndpoint) };
}

export const proxyProfileRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/proxy-profiles — summaries with endpoint counts + health breakdown.
    app.get('/api/proxy-profiles', {
        schema: routeDoc({
            tags: ['proxies'],
            summary: 'List proxy profiles',
            description: 'Profile summaries with endpoint counts and per-health-status breakdown. Metadata only.',
        }),
    }, async () => {
        const rows = await app.proxyProfiles.listProfiles();
        return { rows, total: rows.length };
    });

    // POST /api/proxy-profiles
    app.post('/api/proxy-profiles', {
        schema: routeDoc({
            tags: ['proxies'],
            summary: 'Create a proxy profile',
            description: 'strategy ROUND_ROBIN (Crawlee rotation) or SESSION_STICKY (session-consistent assignment).',
            body: proxyProfileCreateSchema,
        }),
    }, async (request, reply) => {
        const body = parseWith(proxyProfileCreateSchema, request.body);
        const profile = await app.proxyProfiles.createProfile(body);
        return reply.code(201).send(serializeProfile(profile));
    });

    // GET /api/proxy-profiles/:id — profile + endpoints (credentials masked).
    app.get('/api/proxy-profiles/:id', {
        schema: routeDoc({
            tags: ['proxies'],
            summary: 'Proxy profile detail with endpoints',
            description: 'Endpoints expose credentials as hasUsername/hasPassword booleans only — never values.',
            params: idParamSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const profile = await app.proxyProfiles.getProfile(id);
        if (profile === null) throw notFound(`proxy profile ${id} not found`);
        return serializeProfileDetail(profile);
    });

    // PATCH /api/proxy-profiles/:id
    app.patch('/api/proxy-profiles/:id', {
        schema: routeDoc({
            tags: ['proxies'],
            summary: 'Update a proxy profile',
            params: idParamSchema,
            body: proxyProfileUpdateSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const body = parseWith(proxyProfileUpdateSchema, request.body);
        const profile = await app.proxyProfiles.updateProfile(id, body);
        return serializeProfile(profile);
    });

    // DELETE /api/proxy-profiles/:id — endpoints cascade.
    app.delete('/api/proxy-profiles/:id', {
        schema: routeDoc({
            tags: ['proxies'],
            summary: 'Delete a proxy profile',
            description: 'Endpoints cascade; scans referencing the profile are detached (SetNull).',
            params: idParamSchema,
        }),
    }, async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        await app.proxyProfiles.deleteProfile(id);
        return reply.code(204).send();
    });

    // POST /api/proxy-profiles/:id/endpoints — single endpoint add.
    app.post('/api/proxy-profiles/:id/endpoints', {
        schema: routeDoc({
            tags: ['proxies'],
            summary: 'Add a proxy endpoint',
            description:
                'username/password are write-only: encrypted (AES-256-GCM) before persist, never returned. ' +
                'Responses carry hasUsername/hasPassword presence booleans.',
            params: idParamSchema,
            body: proxyEndpointCreateSchema,
        }),
    }, async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        const profile = await app.proxyProfiles.getProfile(id);
        if (profile === null) throw notFound(`proxy profile ${id} not found`);
        const body = parseWith(proxyEndpointCreateSchema, request.body);
        const endpoint = await app.proxyProfiles.addEndpoint(id, {
            ...body,
            name: body.name ?? null,
            country: body.country ?? null,
        });
        return reply.code(201).send(serializeEndpoint(endpoint));
    });

    // POST /api/proxy-profiles/:id/endpoints/bulk — { text } conventional
    // lines (protocol://user:pass@host:port, host:port:user:pass, ...).
    // Per-line failures are collected with MASKED content by the repository.
    app.post('/api/proxy-profiles/:id/endpoints/bulk', {
        schema: routeDoc({
            tags: ['proxies'],
            summary: 'Bulk import proxy endpoints',
            description:
                'Accepts conventional line formats (protocol://user:pass@host:port, host:port:user:pass, …). ' +
                'Per-line failures are collected with masked content.',
            params: idParamSchema,
            body: proxyBulkImportSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const body = parseWith(proxyBulkImportSchema, request.body);
        // importEndpoints throws (CrawlError) only when the profile is missing.
        return app.proxyProfiles.importEndpoints(id, body.text);
    });

    // PATCH /api/proxy-endpoints/:id — partial update; credentials tri-state
    // (omitted = keep, null = clear, string = re-encrypt & store).
    app.patch('/api/proxy-endpoints/:id', {
        schema: routeDoc({
            tags: ['proxies'],
            summary: 'Update a proxy endpoint',
            description: 'Credentials are tri-state: omitted = keep, null = clear, string = re-encrypt & store.',
            params: idParamSchema,
            body: proxyEndpointUpdateSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const body = parseWith(proxyEndpointUpdateSchema, request.body);
        const endpoint = await app.proxyProfiles.updateEndpoint(id, body);
        return serializeEndpoint(endpoint);
    });

    // DELETE /api/proxy-endpoints/:id
    app.delete('/api/proxy-endpoints/:id', {
        schema: routeDoc({
            tags: ['proxies'],
            summary: 'Delete a proxy endpoint',
            params: idParamSchema,
        }),
    }, async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        await app.proxyProfiles.deleteEndpoint(id);
        return reply.code(204).send();
    });

    // POST /api/proxy-endpoints/:id/toggle — enable resets health to UNKNOWN
    // and clears quarantine; disable marks health DISABLED (operator-owned).
    app.post('/api/proxy-endpoints/:id/toggle', {
        schema: routeDoc({
            tags: ['proxies'],
            summary: 'Enable or disable a proxy endpoint',
            description: 'Enable resets health to UNKNOWN and clears quarantine; disable marks health DISABLED.',
            params: idParamSchema,
            body: toggleSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const { enabled } = parseWith(toggleSchema, request.body);
        const endpoint = await app.proxyProfiles.setEndpointEnabled(id, enabled);
        return serializeEndpoint(endpoint);
    });
};
