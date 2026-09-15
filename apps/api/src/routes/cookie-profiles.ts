/**
 * Cookie profile routes.
 *
 * SECRET HYGIENE (ARCHITECTURE §10, §9.3): cookie material is WRITE-ONLY.
 * - POST /api/cookie-profiles accepts { name, cookieJson, notes } and hands
 *   cookieJson to the repository, which normalizes + encrypts it before save.
 * - NO route ever returns encryptedCookieJson, cookie names, or cookie values.
 *   Reads expose metadata only (cookieCount, domainSummary, expirySummary,
 *   validationStatus, ...) through an explicit whitelist serializer — the
 *   response-schema strip point for this domain.
 * - The decryption path (getCookiesDecrypted) is worker-only.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { CookieProfileDetailDto, CookieProfileMetadataDto } from '../types.js';
import { routeDoc } from '../docs.js';
import { notFound, parseWith } from '../errors.js';
import { cookieProfileImportSchema, cookieProfileReplaceSchema, idParamSchema, toggleSchema } from '../schemas.js';

/** Whitelisted metadata fields — the ONLY shape cookie routes may emit. */
function serializeCookieProfile(profile: CookieProfileMetadataDto): Record<string, unknown> {
    return {
        id: profile.id,
        name: profile.name,
        enabled: profile.enabled,
        cookieCount: profile.cookieCount,
        domainSummary: profile.domainSummary,
        expirySummary: profile.expirySummary,
        validationStatus: profile.validationStatus,
        lastValidatedAt: profile.lastValidatedAt,
        notes: profile.notes,
        assignedScanCount: profile.assignedScanCount,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
    };
}

function serializeCookieProfileDetail(profile: CookieProfileDetailDto): Record<string, unknown> {
    return {
        ...serializeCookieProfile(profile),
        assignedScans: profile.assignedScans.map((scan) => ({ id: scan.id, name: scan.name })),
    };
}

export const cookieProfileRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/cookie-profiles — metadata list.
    app.get('/api/cookie-profiles', {
        schema: routeDoc({
            tags: ['cookies'],
            summary: 'List cookie profiles (metadata only)',
            description: 'cookieCount, domainSummary, expirySummary, validationStatus — never cookie names or values.',
        }),
    }, async () => {
        const rows = await app.cookieProfiles.listProfiles();
        return { rows: rows.map(serializeCookieProfile), total: rows.length };
    });

    // POST /api/cookie-profiles — { name, cookieJson, notes? } import.
    // `issues` are indexed and secret-free (no cookie names/values, §9.3).
    app.post('/api/cookie-profiles', {
        schema: routeDoc({
            tags: ['cookies'],
            summary: 'Import a cookie profile',
            description:
                'Accepts EditThisCookie / Cookie-Editor JSON arrays, a { cookies: [...] } wrapper, or a raw ' +
                'Cookie header string. cookieJson is normalized + encrypted (AES-256-GCM) and NEVER returned ' +
                'again. issues are indexed and secret-free.',
            body: cookieProfileImportSchema,
        }),
    }, async (request, reply) => {
        const body = parseWith(cookieProfileImportSchema, request.body);
        const result = await app.cookieProfiles.importCookies(body.name, body.cookieJson, body.notes);
        return reply.code(201).send({ profile: serializeCookieProfile(result.profile), issues: result.issues });
    });

    // GET /api/cookie-profiles/:id — metadata only (+ assigned scans).
    app.get('/api/cookie-profiles/:id', {
        schema: routeDoc({
            tags: ['cookies'],
            summary: 'Cookie profile detail (metadata only)',
            description: 'Metadata plus assigned scans (id, name). Cookie material is never returned.',
            params: idParamSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const profile = await app.cookieProfiles.getProfile(id);
        if (profile === null) throw notFound(`cookie profile ${id} not found`);
        return serializeCookieProfileDetail(profile);
    });

    // POST /api/cookie-profiles/:id/replace — re-import (re-normalize +
    // re-encrypt), refreshing metadata summaries and validationStatus.
    app.post('/api/cookie-profiles/:id/replace', {
        schema: routeDoc({
            tags: ['cookies'],
            summary: 'Replace a cookie profile\'s cookies',
            description: 'Re-import: re-normalize + re-encrypt, refreshing metadata summaries and validationStatus.',
            params: idParamSchema,
            body: cookieProfileReplaceSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const body = parseWith(cookieProfileReplaceSchema, request.body);
        const result = await app.cookieProfiles.replaceCookies(id, body.cookieJson);
        return { profile: serializeCookieProfile(result.profile), issues: result.issues };
    });

    // POST /api/cookie-profiles/:id/toggle — body { enabled }.
    app.post('/api/cookie-profiles/:id/toggle', {
        schema: routeDoc({
            tags: ['cookies'],
            summary: 'Enable or disable a cookie profile',
            params: idParamSchema,
            body: toggleSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const { enabled } = parseWith(toggleSchema, request.body);
        const profile = await app.cookieProfiles.setEnabled(id, enabled);
        return serializeCookieProfile(profile);
    });

    // DELETE /api/cookie-profiles/:id — referencing scans are SetNull-detached.
    app.delete('/api/cookie-profiles/:id', {
        schema: routeDoc({
            tags: ['cookies'],
            summary: 'Delete a cookie profile',
            description: 'Scans referencing the profile are detached (SetNull).',
            params: idParamSchema,
        }),
    }, async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        await app.cookieProfiles.deleteProfile(id);
        return reply.code(204).send();
    });
};
