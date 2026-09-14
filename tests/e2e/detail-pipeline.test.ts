/**
 * E2E: CATEGORY → DETAIL pipeline against a self-contained fixture HTTP server.
 *
 * Server behavior (pattern extended from tests/e2e/offline-crawl.test.ts):
 * - /satilik/*        → the sanitized category fixture, with every absolute
 *                       'https://www.sahibinden.com' URL REWRITTEN to the
 *                       server origin so the crawl stays hermetic. (Listing
 *                       hrefs in the fixture are root-relative /ilan/... —
 *                       served from our origin they absolutize on-origin, so
 *                       the engine's allowedDomains=['127.0.0.1'] SSRF guard
 *                       accepts the enqueued DETAIL requests.)
 * - /ilan/*\/detay    → detail HTML per the current `detailMode`:
 *                       * 'sample1': detail-sample-1.html with the fixture's
 *                         own listing id ('1340140183') string-replaced by the
 *                         id parsed from the REQUEST URL. Rationale: the
 *                         JsonFileOutputRepository dedups detail records by
 *                         listingId (by design — run-crawl.ts §3 "repo dedups
 *                         by listingId"), so serving one static id for 3
 *                         detail URLs would collapse the dataset to 1 record.
 *                         Real detail pages each carry their own id; the
 *                         rewrite reproduces that faithfully.
 *                       * 'unavailable': detail-unavailable.html (removed-
 *                         listing notice; no classifiedInfoList markup).
 * - everything else   → trivial page.
 *
 * Environment handling mirrors offline-crawl.test.ts: mkdtemp outputDirs,
 * CRAWLEE_STORAGE_DIR pointed at its own temp dir in beforeAll (runCrawl only
 * sets it when unset), cleanup in afterAll, managed headless Chrome.
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawlConfigSchema } from '../../packages/config/src/index.js';
import {
    FsDebugArtifactStore,
    JsonFileOutputRepository,
    NullProxyProvider,
    StaticSessionProvider,
    runCrawl,
    type CrawlDeps,
} from '../../packages/scraper-engine/src/index.js';
import type {
    CategoryListing,
    CrawlConfig,
    CrawlEvent,
    CrawlEventType,
    ListingDetail,
    RuntimeLogger,
} from '../../packages/shared/src/index.js';
import {
    assertCategoryListingContract,
    assertListingDetailContract,
} from '../helpers/contract-assertions.js';

const CATEGORY_FIXTURE = path.resolve(__dirname, '../../fixtures/html/category-satilik-adana-seyhan.html');
const DETAIL_FIXTURE = path.resolve(__dirname, '../../fixtures/html/detail-sample-1.html');
const UNAVAILABLE_FIXTURE = path.resolve(__dirname, '../../fixtures/html/detail-unavailable.html');

/** The listing id hardcoded in detail-sample-1.html (data-classifiedid etc.). */
const DETAIL_FIXTURE_ID = '1340140183';
/** detail-sample-1.html's own title — proof that detail extraction ran. */
const SAMPLE1_TITLE = "T.BAŞI_BURGERKİNG_CİV_K.MUTFAK_D.GAZLI_GENİŞ_OTURUMLU_3+1...!";
const TRIVIAL_PAGE = '<html><body><h1>fixture server</h1></body></html>';

type DetailMode = 'sample1' | 'unavailable';

let server: Server;
let port: number;
let origin: string;
let categoryHtmlRaw: string;
let detailHtmlRaw: string;
let unavailableHtml: string;
let detailMode: DetailMode = 'sample1';
/**
 * Cross-run uniqueKey freshness. Crawlee PERSISTS its default request queue
 * in CRAWLEE_STORAGE_DIR and dedups by URL across runCrawl() calls in the
 * same process (verified: a second run with an already-handled start URL
 * processes 0 requests). Each test therefore runs with its own runTag:
 * the start URL gets a harmless ?run=N query and every listing id in the
 * served category page is shifted by runTag * 1e9 (single regex pass over
 * maximal digit runs, mapped ids only) so DETAIL request URLs differ too.
 * Shifted ids stay numeric 9-10 digits — the contract only requires
 * non-empty unique strings, and the detail server echoes whatever id the
 * request URL carries.
 */
let runTag = 0;
let fixtureListingIds: string[] = [];
let crawleeStorageDir: string;
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

const silentLogger: RuntimeLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

function makeDeps(outputDir: string, events: CrawlEvent[]): CrawlDeps {
    return {
        output: new JsonFileOutputRepository(outputDir, 'test-run'),
        debugStore: new FsDebugArtifactStore(path.join(outputDir, 'debug')),
        proxyProvider: new NullProxyProvider(),
        sessionProvider: new StaticSessionProvider([]),
        logger: silentLogger,
        events: { emit: e => events.push(e) },
    };
}

function makeConfig(outputDir: string, overrides: Record<string, unknown>): CrawlConfig {
    const parsed = crawlConfigSchema.parse({
        name: 'detail-pipeline-e2e',
        maxItems: 3,
        maxPages: 1,
        maxConcurrency: 1,
        delayMinMs: 10,
        delayMaxMs: 10,
        navigationTimeoutSeconds: 60,
        maxRequestRetries: 2,
        browser: { mode: 'managed', headless: true },
        allowedDomains: ['127.0.0.1'],
        humanInTheLoop: false,
        debugMode: false,
        outputDir,
        ...overrides,
    });
    // Same cast loadConfig applies: ParsedCrawlConfig is structurally CrawlConfig.
    return parsed as CrawlConfig;
}

/** Reads the single `test-run-*.json` CATEGORY dataset file (never the -details- file). */
async function readCategoryDataset(outputDir: string): Promise<CategoryListing[]> {
    const files = (await readdir(outputDir)).filter(
        f => f.startsWith('test-run-') && !f.startsWith('test-run-details-') && f.endsWith('.json'),
    );
    expect(files.length, 'exactly one category dataset file').toBe(1);
    const raw = await readFile(path.join(outputDir, files[0]!), 'utf8');
    const data: unknown = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    return data as CategoryListing[];
}

/** Reads the single `test-run-details-*.json` file; null when it was never written. */
async function readDetailsDataset(outputDir: string): Promise<ListingDetail[] | null> {
    const files = (await readdir(outputDir)).filter(f => /^test-run-details-.*\.json$/.test(f));
    if (files.length === 0) return null;
    expect(files.length, 'at most one details dataset file').toBe(1);
    const raw = await readFile(path.join(outputDir, files[0]!), 'utf8');
    const data: unknown = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    return data as ListingDetail[];
}

/** Indices of the FIRST occurrence of each given event type, in emission order. */
function eventIndices(events: CrawlEvent[], types: CrawlEventType[]): number[] {
    return types.map(t => events.findIndex(e => e.type === t));
}

beforeAll(async () => {
    categoryHtmlRaw = await readFile(CATEGORY_FIXTURE, 'utf8');
    detailHtmlRaw = await readFile(DETAIL_FIXTURE, 'utf8');
    unavailableHtml = await readFile(UNAVAILABLE_FIXTURE, 'utf8');
    fixtureListingIds = [
        ...new Set([...categoryHtmlRaw.matchAll(/data-id="(\d{8,12})"/g)].map(m => m[1]!)),
    ];
    expect(fixtureListingIds.length).toBeGreaterThan(40); // sanity: 50 organic + promoted

    // Point Crawlee's request queue / KV storage at a throwaway dir BEFORE the
    // engine's lazy storage initialization (runCrawl respects an existing value).
    crawleeStorageDir = await makeTempDir('sahibindenbot-e2e-detail-crawlee-');
    process.env.CRAWLEE_STORAGE_DIR = crawleeStorageDir;

    server = createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (url.pathname.startsWith('/satilik')) {
            // Keep every absolute sahibinden.com URL on-origin (hermetic crawl).
            let html = categoryHtmlRaw.replaceAll('https://www.sahibinden.com', origin);
            if (runTag > 0) {
                // Single-pass remap of the fixture's listing ids (see runTag note).
                const shifted = new Map(fixtureListingIds.map(id => [id, String(Number(id) + runTag * 1_000_000_000)]));
                html = html.replace(/\d{9,12}/g, m => shifted.get(m) ?? m);
            }
            res.end(html);
        } else if (url.pathname.includes('/ilan/') && url.pathname.endsWith('/detay')) {
            if (detailMode === 'unavailable') {
                res.end(unavailableHtml);
                return;
            }
            // Serve detail-sample-1 with the REQUESTED listing id (see header).
            const idMatch = url.pathname.match(/(\d{8,12})(?:\/|$)/);
            const requestedId = idMatch?.[1] ?? DETAIL_FIXTURE_ID;
            res.end(
                detailHtmlRaw
                    .replaceAll('https://www.sahibinden.com', origin)
                    .replaceAll(DETAIL_FIXTURE_ID, requestedId),
            );
        } else {
            res.end(TRIVIAL_PAGE);
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    origin = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    delete process.env.CRAWLEE_STORAGE_DIR;
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
}, 60_000);

describe('detail pipeline (fixture server)', () => {
    it('includeDetails=true crawls category + 3 details and writes contract-valid category AND details datasets', async () => {
        detailMode = 'sample1';
        runTag = 0; // first run: pristine fixture ids
        const outputDir = await makeTempDir('sahibindenbot-e2e-detail-out-');
        const events: CrawlEvent[] = [];
        const config = makeConfig(outputDir, {
            startUrls: [`${origin}/satilik/adana-seyhan`],
            includeDetails: true,
        });

        const result = await runCrawl(config, makeDeps(outputDir, events));

        // --- run result ---
        expect(result.status).toBe('SUCCEEDED');
        expect(result.itemsWritten).toBe(3); // maxItems cap
        expect(result.categoryPagesVisited).toBe(1);
        expect(result.failedRequests).toBe(0);
        expect(result.errors).toEqual([]);
        expect(result.detailPagesVisited).toBe(3);
        expect(result.detailsWritten).toBe(3);

        // --- category dataset: 3 items, 13-field contract ---
        const items = await readCategoryDataset(outputDir);
        expect(items.length).toBe(3);
        for (const [i, item] of items.entries()) {
            assertCategoryListingContract(item, `category item[${i}]`, {
                sourceUrlPrefix: 'http://127.0.0.1:',
                urlPrefix: 'http://127.0.0.1:',
            });
            expect(item.url).toContain('/ilan/');
            expect(item.url.endsWith('/detay')).toBe(true);
        }
        const categoryIds = new Set(items.map(i => i.id));

        // --- details dataset: 3 ListingDetail records, one per category row ---
        const details = await readDetailsDataset(outputDir);
        expect(details, 'details dataset file must exist').not.toBeNull();
        expect(details!.length).toBe(3);
        for (const [i, detail] of details!.entries()) {
            assertListingDetailContract(detail, `detail[${i}]`, {
                requireCategory: true,
                sourceUrlPrefix: 'http://127.0.0.1:',
            });
            // Identity join: the detail's listingId is its category row's id.
            expect(categoryIds.has(detail.listingId)).toBe(true);
            expect(detail.category!.id).toBe(detail.listingId);
            // Category merge: the row that discovered this detail is carried
            // through, and its url IS the detail page URL.
            expect(detail.category!.url).toBe(detail.sourceUrl);
            // Detail-parse artifacts present.
            expect(Object.keys(detail.attributesRaw).length).toBeGreaterThan(15);
            expect(detail.sellerType).toBe('REAL_ESTATE_OFFICE');
            expect(detail.title).toBe(SAMPLE1_TITLE);

            // --- ISOLATION: the DETAIL handler never ran category extraction ---
            // detail.sourceUrl is the /ilan/.../detay URL, NOT the category URL.
            expect(detail.sourceUrl).toContain('/ilan/');
            expect(detail.sourceUrl.endsWith('/detay')).toBe(true);
            expect(detail.sourceUrl).not.toContain('/satilik');
            // The category-parser's sourceUrl artifact (the /satilik page URL)
            // survives ONLY inside the merged category sub-record.
            expect(detail.category!.sourceUrl).toContain('/satilik');
            expect(detail.sourceUrl).not.toBe(detail.category!.sourceUrl);
        }
        // One detail record per distinct listing id.
        expect(new Set(details!.map(d => d.listingId)).size).toBe(3);

        // --- events: lifecycle ordering ---
        const indices = eventIndices(events, [
            'RUN_STARTED',
            'CATEGORY_STARTED',
            'CATEGORY_PARSED',
            'DETAIL_STARTED',
            'DETAIL_PARSED',
            'RUN_COMPLETED',
        ]);
        expect(indices.every(i => i >= 0), `all lifecycle events present: ${JSON.stringify(indices)}`).toBe(true);
        expect(indices).toEqual([...indices].sort((a, b) => a - b));
        expect(events.filter(e => e.type === 'DETAIL_STARTED').length).toBe(3);
        expect(events.filter(e => e.type === 'DETAIL_PARSED').length).toBe(3);
        expect(events.filter(e => e.type === 'DETAIL_UNAVAILABLE').length).toBe(0);
        expect(events.some(e => e.type === 'RUN_FAILED')).toBe(false);
        expect(events.some(e => e.type === 'REQUEST_FAILED')).toBe(false);
        // DETAIL_PARSED carries the classification payload.
        for (const e of events.filter(e => e.type === 'DETAIL_PARSED')) {
            expect(e.data?.sellerType).toBe('REAL_ESTATE_OFFICE');
        }
    }, 120_000);

    it('includeDetails=false writes NO details file and emits NO DETAIL_* events', async () => {
        detailMode = 'sample1';
        runTag = 1; // fresh uniqueKeys (Crawlee queue persists across in-process runs)
        const outputDir = await makeTempDir('sahibindenbot-e2e-nodetail-out-');
        const events: CrawlEvent[] = [];
        const config = makeConfig(outputDir, {
            startUrls: [`${origin}/satilik/adana-seyhan?run=1`],
            includeDetails: false,
        });

        const result = await runCrawl(config, makeDeps(outputDir, events));

        expect(result.status).toBe('SUCCEEDED');
        expect(result.itemsWritten).toBe(3);
        // Detail counters are only present on detail runs (additive optionals).
        expect(result.detailPagesVisited).toBeUndefined();
        expect(result.detailsWritten).toBeUndefined();

        const items = await readCategoryDataset(outputDir);
        expect(items.length).toBe(3);

        // No details dataset file at all (repo writes it only when non-empty).
        expect(await readDetailsDataset(outputDir)).toBeNull();

        // No DETAIL_* events whatsoever.
        for (const t of ['DETAIL_STARTED', 'DETAIL_PARSED', 'DETAIL_UNAVAILABLE'] as const) {
            expect(events.some(e => e.type === t), `no ${t} events`).toBe(false);
        }
        expect(events.some(e => e.type === 'RUN_COMPLETED')).toBe(true);
    }, 120_000);

    it('unavailable detail pages emit DETAIL_UNAVAILABLE, write no details, and still SUCCEED', async () => {
        detailMode = 'unavailable';
        runTag = 2; // fresh uniqueKeys (Crawlee queue persists across in-process runs)
        const outputDir = await makeTempDir('sahibindenbot-e2e-unavailable-out-');
        const events: CrawlEvent[] = [];
        const config = makeConfig(outputDir, {
            startUrls: [`${origin}/satilik/adana-seyhan?run=2`],
            includeDetails: true,
            maxItems: 2,
        });

        const result = await runCrawl(config, makeDeps(outputDir, events));

        // Unavailable listings are a normal outcome, never an error.
        expect(result.status).toBe('SUCCEEDED');
        expect(result.itemsWritten).toBe(2);
        expect(result.failedRequests).toBe(0);
        expect(result.errors).toEqual([]);
        expect(result.detailPagesVisited).toBe(2); // visited + confirmed unavailable
        expect(result.detailsWritten).toBe(0);

        // Category dataset written; details dataset absent (nothing recorded).
        const items = await readCategoryDataset(outputDir);
        expect(items.length).toBe(2);
        expect(await readDetailsDataset(outputDir)).toBeNull();

        // Events: one DETAIL_STARTED + one DETAIL_UNAVAILABLE per listing, no DETAIL_PARSED.
        expect(events.filter(e => e.type === 'DETAIL_STARTED').length).toBe(2);
        expect(events.filter(e => e.type === 'DETAIL_UNAVAILABLE').length).toBe(2);
        expect(events.filter(e => e.type === 'DETAIL_PARSED').length).toBe(0);
        expect(events.some(e => e.type === 'RUN_COMPLETED')).toBe(true);
        expect(events.some(e => e.type === 'RUN_FAILED')).toBe(false);
    }, 120_000);
});
