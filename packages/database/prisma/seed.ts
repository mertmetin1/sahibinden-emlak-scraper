/**
 * Idempotent dev seed.
 *
 *   1. Ensures the demo ScanDefinition exists ('Adana Seyhan Satılık (demo)',
 *      disabled, includeDetails=false).
 *   2. Ensures ONE synthetic seed ScanRun exists for it (status SUCCEEDED,
 *      trigger TEST, snapshot carries a `seed` marker — reused on re-runs).
 *   3. Imports fixtures/baseline/upstream-category-output-istanbul-20.json
 *      through the SAME repository upsert path the engine uses — so the seed
 *      doubles as an upsert smoke test.
 *
 * Re-running never duplicates listings/images/scans/runs: identity is
 * (source, sourceListingId), the demo scan is matched by name, and the seed
 * run is matched by its snapshot marker. ListingSeenHistory is append-only
 * by design, so each re-seed journals one new sighting per listing (expected).
 *
 * Usage:  pnpm -C packages/database db:seed   (DATABASE_URL from env)
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CategoryListing } from '@sahibindenbot/shared';
import { createDatabaseClient } from '../src/index.js';

const SEED_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SEED_DIR, '..', '..', '..');
const FIXTURE_PATH = path.join(REPO_ROOT, 'fixtures', 'baseline', 'upstream-category-output-istanbul-20.json');

const DEMO_SCAN_NAME = 'Adana Seyhan Satılık (demo)';
const SEED_SNAPSHOT = {
    seed: true,
    fixture: 'upstream-category-output-istanbul-20.json',
    note: 'Synthetic completed run backing the fixture import.',
} as const;

function isSeedSnapshot(snapshot: unknown): boolean {
    return (
        typeof snapshot === 'object' &&
        snapshot !== null &&
        (snapshot as Record<string, unknown>).seed === true
    );
}

async function main(): Promise<void> {
    const db = createDatabaseClient(process.env.DATABASE_URL);
    try {
        // 1. Demo scan definition (matched by name — no unique constraint, so
        //    findFirst + create-if-missing keeps re-seeds duplicate-free).
        let scan = await db.prisma.scanDefinition.findFirst({ where: { name: DEMO_SCAN_NAME } });
        if (scan === null) {
            scan = await db.prisma.scanDefinition.create({
                data: {
                    name: DEMO_SCAN_NAME,
                    description: 'Demo tarama tanımı (seed) — devre dışı; elle çalıştırma içindir.',
                    enabled: false,
                    startUrls: ['https://www.sahibinden.com/satilik-daire/adana-seyhan'],
                    includeDetails: false,
                },
            });
            console.log(`[seed] demo scan created: ${scan.id}`);
        } else {
            console.log(`[seed] demo scan exists: ${scan.id}`);
        }

        // 2. Synthetic seed run (reused across re-seeds via snapshot marker).
        const existingRuns = await db.prisma.scanRun.findMany({
            where: { scanDefinitionId: scan.id, trigger: 'TEST' },
            orderBy: { createdAt: 'asc' },
        });
        let run = existingRuns.find((candidate) => isSeedSnapshot(candidate.configurationSnapshot));
        if (!run) {
            run = await db.prisma.scanRun.create({
                data: {
                    scanDefinitionId: scan.id,
                    trigger: 'TEST',
                    status: 'RUNNING',
                    configurationSnapshot: SEED_SNAPSHOT,
                    startedAt: new Date(),
                },
            });
            console.log(`[seed] synthetic run created: ${run.id}`);
        } else {
            console.log(`[seed] synthetic run reused: ${run.id}`);
        }

        // 3. Fixture import through the repository upsert path.
        const items = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as CategoryListing[];
        const batch = await db.repos.listings.upsertCategoryListings(items, run.id);

        await db.repos.runs.finishRun(run.id, 'SUCCEEDED', {
            itemsDiscovered: items.length,
            itemsInserted: batch.counts.inserted,
            itemsUpdated: batch.counts.updated,
            pricesChanged: batch.counts.priceChanged,
        });

        // 3b. Journal events for the synthetic run so Run Detail shows a
        // realistic log out of the box (only the worker writes events
        // otherwise). Idempotent: skipped when the run already has events.
        const existingEvents = await db.prisma.scanRunEvent.count({ where: { runId: run.id } });
        if (existingEvents === 0) {
            await db.prisma.scanRunEvent.createMany({
                data: [
                    { runId: run.id, type: 'RUN_STARTED', data: { startUrlCount: 1, browserMode: 'managed' } },
                    { runId: run.id, type: 'CATEGORY_PARSED', data: { listingsFound: items.length, newListings: batch.counts.inserted } },
                    { runId: run.id, type: 'RUN_COMPLETED', data: { status: 'SUCCEEDED' } },
                ],
            });
            console.log('[seed] 3 journal events inserted for the demo run');
        }

        const totalListings = await db.prisma.listing.count();
        console.log(
            `[seed] fixture rows: ${items.length} | ` +
                `inserted=${batch.counts.inserted} updated=${batch.counts.updated} ` +
                `priceChanged=${batch.counts.priceChanged} unchanged=${batch.counts.unchanged} ` +
                `errors=${batch.errors.length} | total listings in db: ${totalListings}`,
        );
        for (const error of batch.errors) {
            console.warn(`[seed] item error (${error.sourceListingId ?? 'no-id'}): ${error.message}`);
        }
    } finally {
        await db.disconnect();
    }
}

main().catch((err: unknown) => {
    console.error('[seed] FAILED:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
