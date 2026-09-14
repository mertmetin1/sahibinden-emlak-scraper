/**
 * Test kit for tests/db/ — per-file PostgreSQL databases, table truncation,
 * and contract factories (CategoryListing / ListingDetail).
 *
 * ISOLATION MODEL: vitest runs test FILES in parallel forks (maxWorkers: 2),
 * so each test file owns its OWN database named sahibindenbot_test_<slug>,
 * recreated in beforeAll (DROP WITH FORCE + CREATE + prisma migrate deploy,
 * ~1s measured). Within a file, beforeEach truncates all tables. The dev
 * database (sahibindenbot) is never touched: recreateTestDatabase refuses
 * any name not starting with TEST_DB_PREFIX.
 *
 * IMPORTS: relative source paths, per tests/helpers/contract-assertions.ts —
 * the repo root declares no @sahibindenbot/* dependencies, so bare specifiers
 * do not resolve from tests/.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CategoryListing, ListingDetail } from '../../packages/shared/src/index.js';
import { createDatabaseClient } from '../../packages/database/src/index.js';
import type {
    DatabaseClient,
    RunRecord,
    ScanCreateInput,
    ScanRecord,
    ScanRunStatusValue,
    ScanTriggerValue,
} from '../../packages/database/src/index.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATABASE_PKG = path.join(REPO_ROOT, 'packages', 'database');
/** Direct node invocation of the prisma CLI — avoids pnpm shim/platform quirks. */
const PRISMA_CLI = path.join(DATABASE_PKG, 'node_modules', 'prisma', 'build', 'index.js');

const PG_CONTAINER = 'sahibindenbot-postgres';
const PG_USER = 'sahibinden';
const TEST_DB_PREFIX = 'sahibindenbot_test';
const BASE_URL = 'postgresql://sahibinden:sahibinden_local_dev@localhost:5433';

export function testDatabaseUrl(dbName: string): string {
    return `${BASE_URL}/${dbName}`;
}

/** DROP (FORCE) + CREATE + migrate deploy. Measured ~1s total; safe to call per test file. */
export function recreateTestDatabase(dbName: string): void {
    if (!dbName.startsWith(TEST_DB_PREFIX)) {
        throw new Error(`refusing to touch non-test database '${dbName}' (must start with '${TEST_DB_PREFIX}')`);
    }
    execFileSync(
        'docker',
        [
            'exec',
            PG_CONTAINER,
            'psql',
            '-U',
            PG_USER,
            '-d',
            'postgres',
            '-c',
            `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`,
            '-c',
            `CREATE DATABASE ${dbName}`,
        ],
        { stdio: 'pipe' },
    );
    execFileSync(process.execPath, [PRISMA_CLI, 'migrate', 'deploy'], {
        cwd: DATABASE_PKG,
        env: { ...process.env, DATABASE_URL: testDatabaseUrl(dbName) },
        stdio: 'pipe',
    });
}

/** Recreate the file's database and open a wired DatabaseClient on it. */
export function openTestDatabase(dbName: string): DatabaseClient {
    recreateTestDatabase(dbName);
    return createDatabaseClient(testDatabaseUrl(dbName));
}

/** Every table, one statement; RESTART IDENTITY resets ScanRunEvent's BIGSERIAL. */
const ALL_TABLES = [
    'ScanRunEvent',
    'ScanRunListing',
    'ListingSeenHistory',
    'ListingPriceHistory',
    'ListingImage',
    'ListingAttribute',
    'Listing',
    'Seller',
    'ScanRun',
    'ScanDefinition',
    'ProxyEndpoint',
    'ProxyProfile',
    'CookieProfile',
    'SessionPolicy',
    'AppSetting',
] as const;

export async function truncateAllTables(db: DatabaseClient): Promise<void> {
    await db.prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${ALL_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
}

// ---------------------------------------------------------------------------
// Scan / run helpers
// ---------------------------------------------------------------------------

export async function createScan(db: DatabaseClient, overrides: Partial<ScanCreateInput> = {}): Promise<ScanRecord> {
    return db.repos.scans.create({
        name: `test-scan-${Math.random().toString(36).slice(2, 10)}`,
        startUrls: ['https://www.sahibinden.com/satilik-daire/istanbul'],
        ...overrides,
    });
}

export async function createRun(
    db: DatabaseClient,
    scanDefinitionId: string,
    configurationSnapshot: unknown = { incrementalMode: false },
    trigger: ScanTriggerValue = 'SCHEDULE',
): Promise<RunRecord> {
    return db.repos.runs.createRun(scanDefinitionId, trigger, configurationSnapshot);
}

/**
 * Simulates one scan run end-to-end: create run, observe the given category
 * listings through the real upsert path, set the final status. Returns the
 * run plus the observed sourceListingId -> listingId map.
 */
export async function runScan(
    db: DatabaseClient,
    scanDefinitionId: string,
    observedIds: string[],
    opts: { status?: ScanRunStatusValue; incremental?: boolean } = {},
): Promise<{ run: RunRecord; listingIds: Map<string, string> }> {
    const run = await createRun(db, scanDefinitionId, { incrementalMode: opts.incremental === true });
    const listingIds = new Map<string, string>();
    for (const id of observedIds) {
        const result = await db.repos.listings.upsertCategoryListing(makeCategoryListing({ id }), run.id);
        listingIds.set(id, result.listingId);
    }
    await db.repos.runs.updateStatus(run.id, opts.status ?? 'SUCCEEDED');
    return { run, listingIds };
}

// ---------------------------------------------------------------------------
// Contract factories
// ---------------------------------------------------------------------------

export function makeCategoryListing(overrides: Partial<CategoryListing> = {}): CategoryListing {
    return {
        id: '9000000001',
        url: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-test-9000000001/detay',
        title: 'Test Satılık Daire 2+1',
        price: 1_000_000,
        price_currency: 'TL',
        price_raw: '1.000.000 TL',
        price_per_sqm: '',
        area: '100',
        location: 'Beylikdüzü / Gürpınar',
        date: '14 Eylül 2026',
        image: 'https://i0.shbdn.com/photos/90/00/00/lthmb_9000000001abc.jpg',
        scrapedAt: '2026-09-14T15:00:00.000Z',
        sourceUrl: 'https://www.sahibinden.com/satilik-daire/istanbul?sorting=date_desc',
        ...overrides,
    };
}

export function makeListingDetail(overrides: Partial<ListingDetail> = {}): ListingDetail {
    return {
        listingId: '9000000001',
        canonicalUrl: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-test-9000000001',
        source: 'sahibinden.com',
        sourceUrl: 'https://www.sahibinden.com/ilan/emlak-konut-satilik-test-9000000001/detay',
        scrapedAt: '2026-09-14T15:05:00.000Z',
        title: 'Test Satılık Daire 2+1 — Detay',
        description: 'Deniz manzaralı, site içerisinde, krediye uygun test ilanı.',
        price: 1_000_000,
        currency: 'TL',
        priceRaw: '1.000.000 TL',
        pricePerSquareMeter: 10_000,
        listingType: 'SALE',
        propertyCategory: 'Konut',
        propertySubtype: 'Daire',
        grossAreaM2: 120,
        netAreaM2: 100,
        rooms: '2+1',
        buildingAge: '5',
        floor: '3',
        totalFloors: '10',
        heating: 'Kombi (Doğalgaz)',
        bathroomCount: '1',
        balcony: 'Var',
        furnished: 'Hayır',
        usageStatus: 'Boş',
        insideSite: 'Evet',
        siteName: 'Test Sitesi',
        dues: '500 TL',
        deposit: null,
        deedStatus: 'Müstakil Tapulu',
        creditEligible: 'Evet',
        exchangeEligible: 'Hayır',
        province: 'İstanbul',
        district: 'Beylikdüzü',
        neighborhood: 'Gürpınar',
        locationRaw: 'İstanbul / Beylikdüzü / Gürpınar',
        listingDate: '2026-09-14T00:00:00.000Z',
        listingDateRaw: '14 Eylül 2026',
        updatedDate: null,
        updatedDateRaw: null,
        sellerType: 'REAL_ESTATE_OFFICE',
        sellerTypeEvidence: 'Emlak Ofisinden',
        sellerDisplayName: 'Test Emlak Danışmanı',
        officeName: 'Test Emlak Ofisi',
        sellerProfileUrl: 'https://www.sahibinden.com/emlak-ofisi/test-emlak-9001',
        publicContactPhone: '0212 000 00 00',
        images: [
            { url: 'https://i0.shbdn.com/photos/90/00/00/9000000001x01.jpg', position: 0, isPrimary: true },
            { url: 'https://i0.shbdn.com/photos/90/00/00/9000000001x02.jpg', position: 1, isPrimary: false },
            { url: 'https://i0.shbdn.com/photos/90/00/00/9000000001x03.jpg', position: 2, isPrimary: false },
        ],
        videoUrl: null,
        virtualTourUrl: null,
        attributesRaw: {
            'Oda Sayısı': '2+1',
            'Bina Yaşı': '5',
            'Isıtma': 'Kombi (Doğalgaz)',
        },
        unavailable: false,
        ...overrides,
    };
}
