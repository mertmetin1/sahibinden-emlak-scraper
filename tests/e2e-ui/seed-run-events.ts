/**
 * Test-data seeder for the UI e2e suite — executed once via global setup
 * (spawned through tsx; see global-setup.ts).
 *
 * The dev seed's synthetic run (the 'Adana Seyhan Satılık (demo)' scan's
 * SUCCEEDED run) has NO ScanRunEvent journal rows: only the worker writes
 * events, and the worker is deliberately NOT run for UI tests. To exercise
 * the run-detail log's DB-replay path (RunEventLog initialEvents), we insert
 * three well-formed journal rows directly. Idempotent: skipped when the run
 * already has events, so re-runs and re-seeds stay clean.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabaseClient } from '../../packages/database/src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const API = process.env.E2E_API_URL ?? 'http://localhost:3001';
const DEMO_SCAN_NAME = 'Adana Seyhan Satılık (demo)';

function databaseUrl(): string {
    if (process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== '') {
        return process.env.DATABASE_URL;
    }
    const text = readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
        const m = /^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/.exec(line);
        if (m !== null && m[1] !== undefined) return m[1];
    }
    throw new Error('DATABASE_URL not found in process env or root .env');
}

interface ScanRow {
    name: string;
    latestRun: { id: string; status: string } | null;
}

async function findSeededRunId(): Promise<string> {
    const res = await fetch(`${API}/api/scans`);
    if (!res.ok) throw new Error(`GET /api/scans → HTTP ${res.status}`);
    const data = (await res.json()) as { rows: ScanRow[] };
    const demo = data.rows.find((r) => r.name === DEMO_SCAN_NAME && r.latestRun !== null);
    if (demo?.latestRun != null) return demo.latestRun.id;
    // Fallback: any SUCCEEDED run (e.g. demo scan renamed).
    const runsRes = await fetch(`${API}/api/runs?status=SUCCEEDED`);
    if (!runsRes.ok) throw new Error(`GET /api/runs → HTTP ${runsRes.status}`);
    const runs = (await runsRes.json()) as { rows: Array<{ id: string }> };
    const first = runs.rows[0];
    if (first === undefined) throw new Error('no seeded run found (demo scan has no latestRun, no SUCCEEDED runs)');
    return first.id;
}

async function main(): Promise<void> {
    const runId = await findSeededRunId();
    const db = createDatabaseClient(databaseUrl());
    try {
        const existing = await db.prisma.scanRunEvent.count({ where: { runId } });
        if (existing > 0) {
            console.log(`[e2e-seed] run ${runId} already has ${existing} journal event(s) — nothing to do`);
            return;
        }
        await db.prisma.scanRunEvent.createMany({
            data: [
                { runId, type: 'RUN_STARTED', data: { startUrlCount: 1, browserMode: 'managed' } },
                { runId, type: 'CATEGORY_PARSED', data: { listingsFound: 20, newListings: 20 } },
                { runId, type: 'RUN_COMPLETED', data: { status: 'SUCCEEDED' } },
            ],
        });
        console.log(`[e2e-seed] inserted 3 journal events for seeded run ${runId}`);
    } finally {
        await db.disconnect();
    }
}

main().catch((err: unknown) => {
    console.error('[e2e-seed] FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
