/**
 * E2E: offline crawl against a self-contained fixture HTTP server.
 *
 * The server (pattern copied from scripts/serve-fixture.mjs) serves the
 * sanitized category fixture for /satilik/* paths, a zero-listing page at
 * /empty, and a trivial page otherwise. No external server is required.
 *
 * Environment handling:
 * - outputDir is a fresh fs.mkdtemp per test; CRAWLEE_STORAGE_DIR is pointed
 *   at its own temp dir in beforeAll (runCrawl only sets it when unset, so
 *   this pre-set value wins) and removed in afterAll.
 * - Managed browser mode resolves the installed Google Chrome via
 *   channel 'chrome' inside the engine's ManagedBrowserProvider.
 *
 * VERIFIED BEHAVIOR NOTES (deviations from the task brief, trusted from code):
 * - The fixture page yields 51 parsed listings (50 organic + 1 promoted
 *   searchResultsPromoSuper row; the native-ad row is skipped). With
 *   maxItems 50 the engine writes exactly 50 and reports itemsDiscovered 51.
 * - The SSRF guard does NOT throw out of runCrawl: disallowed start URLs are
 *   recorded as typed INVALID_PAGE errors and the run returns status FAILED
 *   (run-crawl.ts, start-URL validation loop + empty startRequests branch).
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
    RuntimeLogger,
} from '../../packages/shared/src/index.js';
import { assertCategoryListingContract } from '../helpers/contract-assertions.js';

const FIXTURE = path.resolve(__dirname, '../../fixtures/html/category-satilik-adana-seyhan.html');
const ZERO_ROW_PAGE = '<html><body>no results</body></html>';
const TRIVIAL_PAGE = '<html><body><h1>fixture server</h1></body></html>';

let server: Server;
let port: number;
let categoryHtml: string;
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
        name: 'offline-e2e',
        maxItems: 50,
        maxPages: 1,
        maxConcurrency: 1,
        delayMinMs: 10,
        delayMaxMs: 50,
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

/** Reads the single `test-run-*.json` dataset file written into outputDir. */
async function readDataset(outputDir: string): Promise<CategoryListing[]> {
    const files = (await readdir(outputDir)).filter(f => /^test-run-.*\.json$/.test(f));
    expect(files.length, 'exactly one dataset file').toBe(1);
    const raw = await readFile(path.join(outputDir, files[0]!), 'utf8');
    const data: unknown = JSON.parse(raw);
    expect(Array.isArray(data)).toBe(true);
    return data as CategoryListing[];
}

/** Indices of the given event types, in emission order. */
function eventIndices(events: CrawlEvent[], types: CrawlEventType[]): number[] {
    return types.map(t => events.findIndex(e => e.type === t));
}

beforeAll(async () => {
    categoryHtml = await readFile(FIXTURE, 'utf8');

    // Point Crawlee's request queue / KV storage at a throwaway dir BEFORE the
    // engine's lazy storage initialization (runCrawl respects an existing value).
    crawleeStorageDir = await makeTempDir('sahibindenbot-e2e-crawlee-');
    process.env.CRAWLEE_STORAGE_DIR = crawleeStorageDir;

    server = createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (url.pathname.startsWith('/satilik')) {
            res.end(categoryHtml);
        } else if (url.pathname === '/empty') {
            res.end(ZERO_ROW_PAGE);
        } else {
            res.end(TRIVIAL_PAGE);
        }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    delete process.env.CRAWLEE_STORAGE_DIR;
    for (const dir of tempDirs) {
        await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    }
}, 60_000);

describe('offline crawl (fixture server)', () => {
    it('crawls the category fixture end-to-end and writes a contract-valid dataset', async () => {
        const outputDir = await makeTempDir('sahibindenbot-e2e-out-');
        const events: CrawlEvent[] = [];
        const config = makeConfig(outputDir, {
            startUrls: [`http://127.0.0.1:${port}/satilik/adana-seyhan`],
        });

        const result = await runCrawl(config, makeDeps(outputDir, events));

        expect(result.status).toBe('SUCCEEDED');
        expect(result.itemsWritten).toBe(50); // maxItems cap
        expect(result.itemsDiscovered).toBe(51); // 50 organic + 1 promoted row
        expect(result.categoryPagesVisited).toBe(1);
        expect(result.failedRequests).toBe(0);
        expect(result.errors).toEqual([]);

        const items = await readDataset(outputDir);
        expect(items.length).toBe(50);
        for (const [i, item] of items.entries()) {
            assertCategoryListingContract(item, `dataset item[${i}]`, {
                sourceUrlPrefix: 'http://127.0.0.1:',
                urlPrefix: 'http://127.0.0.1:',
            });
            expect(item.url).toContain('/ilan/');
            expect(item.url.endsWith('/detay')).toBe(true);
        }
        // ID dedup contract carried over from the CDP experiment.
        const ids = items.map(i => i.id);
        expect(new Set(ids).size).toBe(ids.length);

        // Lifecycle events in order: RUN_STARTED → CATEGORY_STARTED →
        // CATEGORY_PARSED → RUN_COMPLETED (and never RUN_FAILED).
        const indices = eventIndices(events, [
            'RUN_STARTED',
            'CATEGORY_STARTED',
            'CATEGORY_PARSED',
            'RUN_COMPLETED',
        ]);
        expect(indices.every(i => i >= 0)).toBe(true);
        expect(indices).toEqual([...indices].sort((a, b) => a - b));
        expect(events.some(e => e.type === 'RUN_FAILED')).toBe(false);
    }, 120_000);

    it('fails fast with a typed INVALID_PAGE error when the start URL is outside allowedDomains (SSRF guard)', async () => {
        const outputDir = await makeTempDir('sahibindenbot-e2e-ssrf-');
        const events: CrawlEvent[] = [];
        const config = makeConfig(outputDir, {
            startUrls: [`http://127.0.0.1:${port}/satilik/x`],
            allowedDomains: ['example.com'],
        });

        // The engine records the rejection and returns FAILED — it does not throw.
        const result = await runCrawl(config, makeDeps(outputDir, events));

        expect(result.status).toBe('FAILED');
        expect(result.itemsWritten).toBe(0);
        expect(result.itemsDiscovered).toBe(0);
        expect(result.categoryPagesVisited).toBe(0);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]!.code).toBe('INVALID_PAGE');
        expect(result.errors[0]!.message).toContain('allowedDomains');

        // Output was finalized with zero items.
        const items = await readDataset(outputDir);
        expect(items).toEqual([]);

        // RUN_STARTED → RUN_FAILED; the crawler never started a category.
        expect(events.some(e => e.type === 'RUN_STARTED')).toBe(true);
        expect(events.some(e => e.type === 'RUN_FAILED')).toBe(true);
        expect(events.some(e => e.type === 'CATEGORY_STARTED')).toBe(false);
        expect(events.some(e => e.type === 'RUN_COMPLETED')).toBe(false);
    }, 60_000);

    it('classifies a zero-row results page as PARSER_CHANGED, never silent-success', async () => {
        const outputDir = await makeTempDir('sahibindenbot-e2e-parser-');
        const events: CrawlEvent[] = [];
        const config = makeConfig(outputDir, {
            startUrls: [`http://127.0.0.1:${port}/empty`],
            // No retries: the selector wait is 15s per attempt (engine constant).
            maxRequestRetries: 0,
        });

        const result = await runCrawl(config, makeDeps(outputDir, events));

        expect(result.status).toBe('FAILED');
        expect(result.itemsWritten).toBe(0);
        expect(result.failedRequests).toBe(1);
        expect(result.errors.some(e => e.code === 'PARSER_CHANGED')).toBe(true);

        expect(events.some(e => e.type === 'CATEGORY_STARTED')).toBe(true);
        expect(events.some(e => e.type === 'CATEGORY_PARSED')).toBe(false);
        expect(events.some(e => e.type === 'RUN_FAILED')).toBe(true);
        expect(events.some(e => e.type === 'RUN_COMPLETED')).toBe(false);
    }, 120_000);
});
