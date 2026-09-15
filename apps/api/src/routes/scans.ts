/**
 * Scan definition routes — CRUD + duplicate/toggle + run triggers.
 *
 * Run triggers delegate to RunControlService (frozen queue contract):
 * - POST /api/scans/:id/run  → trigger MANUAL
 * - POST /api/scans/:id/test → trigger TEST with { maxItems: 10, maxPages: 1 }
 *   merged into the configuration snapshot (definition untouched).
 */
import type { FastifyPluginAsync } from 'fastify';
import type { ScanRecord } from '@sahibindenbot/database';
import { routeDoc } from '../docs.js';
import { ApiError, conflict, notFound, parseWith, type ValidationIssue } from '../errors.js';
import {
    idParamSchema,
    scanCreateSchema,
    scanListQuerySchema,
    scanUpdateSchema,
    toggleSchema,
} from '../schemas.js';
import { TEST_RUN_OVERRIDES } from '../queue.js';
import { assertProfilesExist } from './helpers.js';

function validationFailed(issues: ValidationIssue[]): ApiError {
    return new ApiError(400, 'VALIDATION_ERROR', 'request validation failed', { issues });
}

/**
 * Cross-field checks for PATCH, evaluated against the MERGED
 * (existing + patch) definition — but only when the patch actually touches
 * the coupled fields, so unrelated edits to a legacy/seeded scan never fail.
 */
function assertMergedScanValid(
    existing: ScanRecord,
    patch: { browserMode?: string; cdpUrl?: string | null; delayMinMs?: number; delayMaxMs?: number },
): void {
    if (patch.browserMode !== undefined || patch.cdpUrl !== undefined) {
        const mode = patch.browserMode ?? existing.browserMode;
        const cdpUrl = patch.cdpUrl !== undefined ? patch.cdpUrl : existing.cdpUrl;
        if (mode === 'cdp' && (cdpUrl === null || cdpUrl === '')) {
            throw validationFailed([
                { path: 'cdpUrl', message: 'cdpUrl is required when browserMode is "cdp"', code: 'custom' },
            ]);
        }
    }
    if (patch.delayMinMs !== undefined || patch.delayMaxMs !== undefined) {
        const min = patch.delayMinMs ?? existing.delayMinMs;
        const max = patch.delayMaxMs ?? existing.delayMaxMs;
        if (max < min) {
            throw validationFailed([{ path: 'delayMaxMs', message: 'delayMaxMs must be >= delayMinMs', code: 'custom' }]);
        }
    }
}

export const scanRoutes: FastifyPluginAsync = async (app) => {
    // GET /api/scans — list with latest run summary.
    // NOTE: ScanRepository.listWithLatestRun() has no filter/pagination
    // parameters (repo gap — reported); `enabled`/`q` are applied in memory.
    // Scan definitions are operator-scale (tens, not thousands).
    app.get('/api/scans', {
        schema: routeDoc({
            tags: ['scans'],
            summary: 'List scan definitions with latest run summary',
            description:
                'Returns every scan with its latest run inline. enabled/q filters apply in memory ' +
                '(operator-scale data; ScanRepository.listWithLatestRun has no filter params — reported gap).',
            querystring: scanListQuerySchema,
        }),
    }, async (request) => {
        const query = parseWith(scanListQuerySchema, request.query);
        let items = await app.db.repos.scans.listWithLatestRun();
        if (query.enabled !== undefined) items = items.filter((item) => item.scan.enabled === query.enabled);
        if (query.q !== undefined) {
            const needle = query.q.toLowerCase();
            items = items.filter((item) => item.scan.name.toLowerCase().includes(needle));
        }
        return { rows: items.map((item) => ({ ...item.scan, latestRun: item.latestRun })), total: items.length };
    });

    // POST /api/scans — create (full validation incl. cron, timezone, cdp rule).
    app.post('/api/scans', {
        schema: routeDoc({
            tags: ['scans'],
            summary: 'Create a scan definition',
            description:
                'Full field validation: cron expression, IANA timezone, cdpUrl required for browserMode "cdp", ' +
                'delayMaxMs >= delayMinMs, referenced profile ids must exist (400 PROFILE_NOT_FOUND).',
            body: scanCreateSchema,
        }),
    }, async (request, reply) => {
        const body = parseWith(scanCreateSchema, request.body);
        await assertProfilesExist(app, body);
        const scan = await app.db.repos.scans.create(body);
        return reply.code(201).send(scan);
    });

    // GET /api/scans/:id — detail incl. latest run summary.
    app.get('/api/scans/:id', {
        schema: routeDoc({
            tags: ['scans'],
            summary: 'Scan definition detail',
            description: 'Full definition plus the most recent run (latestRun, null when never run).',
            params: idParamSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const scan = await app.db.repos.scans.getById(id);
        if (scan === null) throw notFound(`scan ${id} not found`);
        const { rows } = await app.db.repos.runs.listRuns(id, undefined, 1, 1);
        return { ...scan, latestRun: rows[0] ?? null };
    });

    // PATCH /api/scans/:id — partial update; never touches existing runs
    // (runs execute from their immutable configurationSnapshot).
    app.patch('/api/scans/:id', {
        schema: routeDoc({
            tags: ['scans'],
            summary: 'Partially update a scan definition',
            description:
                'Partial update; never touches existing runs (they execute from their immutable ' +
                'configurationSnapshot). Cross-field rules (cdpUrl, delay ordering) are checked against ' +
                'the merged definition only when the patch touches the coupled fields.',
            params: idParamSchema,
            body: scanUpdateSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const existing = await app.db.repos.scans.getById(id);
        if (existing === null) throw notFound(`scan ${id} not found`);
        const patch = parseWith(scanUpdateSchema, request.body);
        assertMergedScanValid(existing, patch);
        await assertProfilesExist(app, patch);
        return app.db.repos.scans.update(id, patch);
    });

    // DELETE /api/scans/:id — refused while a run is active.
    app.delete('/api/scans/:id', {
        schema: routeDoc({
            tags: ['scans'],
            summary: 'Delete a scan definition',
            description: '409 SCAN_HAS_ACTIVE_RUN while a run is active — cancel it first. Runs cascade.',
            params: idParamSchema,
        }),
    }, async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        const existing = await app.db.repos.scans.getById(id);
        if (existing === null) throw notFound(`scan ${id} not found`);
        const active = await app.runControl.findActiveRun(id);
        if (active !== null) {
            throw conflict(
                'SCAN_HAS_ACTIVE_RUN',
                `scan ${id} has an active run (${active.id}, status ${active.status}) — cancel it first`,
                { activeRunId: active.id, activeRunStatus: active.status },
            );
        }
        await app.db.repos.scans.delete(id);
        return reply.code(204).send();
    });

    // POST /api/scans/:id/duplicate — copy with ' (kopya)' suffix, disabled.
    app.post('/api/scans/:id/duplicate', {
        schema: routeDoc({
            tags: ['scans'],
            summary: 'Duplicate a scan definition',
            description: "Copies the definition with a ' (kopya)' name suffix; the copy is created disabled.",
            params: idParamSchema,
        }),
    }, async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        const existing = await app.db.repos.scans.getById(id);
        if (existing === null) throw notFound(`scan ${id} not found`);
        const copy = await app.db.repos.scans.duplicate(id);
        return reply.code(201).send(copy);
    });

    // POST /api/scans/:id/toggle — body { enabled }.
    app.post('/api/scans/:id/toggle', {
        schema: routeDoc({
            tags: ['scans'],
            summary: 'Enable or disable a scan',
            description: 'Disabled scans refuse run/test triggers (409 SCAN_DISABLED) and are skipped by the scheduler.',
            params: idParamSchema,
            body: toggleSchema,
        }),
    }, async (request) => {
        const { id } = parseWith(idParamSchema, request.params);
        const { enabled } = parseWith(toggleSchema, request.body);
        const existing = await app.db.repos.scans.getById(id);
        if (existing === null) throw notFound(`scan ${id} not found`);
        return app.db.repos.scans.update(id, { enabled });
    });

    // POST /api/scans/:id/run — start a MANUAL run (frozen queue contract).
    app.post('/api/scans/:id/run', {
        schema: routeDoc({
            tags: ['scans'],
            summary: 'Start a manual run',
            description:
                'Creates the ScanRun row (QUEUED, immutable configurationSnapshot) and enqueues the BullMQ ' +
                'job per the frozen queue contract. 409 RUN_ALREADY_ACTIVE when a run is active; 409 ' +
                'SCAN_DISABLED when the scan is disabled.',
            params: idParamSchema,
        }),
    }, async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        const scan = await app.db.repos.scans.getById(id);
        if (scan === null) throw notFound(`scan ${id} not found`);
        if (!scan.enabled) throw conflict('SCAN_DISABLED', `scan ${id} is disabled — enable it before starting a run`);
        const run = await app.runControl.startRun(scan, 'MANUAL');
        return reply.code(201).send(run);
    });

    // POST /api/scans/:id/test — TEST run; { maxItems: 10, maxPages: 1 } are
    // merged into the snapshot (frozen contract), the definition is untouched.
    app.post('/api/scans/:id/test', {
        schema: routeDoc({
            tags: ['scans'],
            summary: 'Start a smoke test run',
            description:
                'TEST trigger with the frozen overrides { maxItems: 10, maxPages: 1 } merged into the ' +
                'configuration snapshot only — the definition is untouched.',
            params: idParamSchema,
        }),
    }, async (request, reply) => {
        const { id } = parseWith(idParamSchema, request.params);
        const scan = await app.db.repos.scans.getById(id);
        if (scan === null) throw notFound(`scan ${id} not found`);
        if (!scan.enabled) throw conflict('SCAN_DISABLED', `scan ${id} is disabled — enable it before starting a test run`);
        const run = await app.runControl.startRun(scan, 'TEST', { ...TEST_RUN_OVERRIDES });
        return reply.code(201).send(run);
    });
};
