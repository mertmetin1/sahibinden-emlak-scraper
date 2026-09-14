/**
 * Unit tests for @sahibindenbot/config: crawlConfigSchema defaults +
 * validation rules, and loadConfig's friendly error paths.
 *
 * Imports are relative source paths — see tests/helpers/contract-assertions.ts
 * header for why bare @sahibindenbot/* specifiers cannot resolve from tests/.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawlConfigSchema, loadConfig } from '../../packages/config/src/index.js';

const VALID_START = 'https://www.sahibinden.com/satilik/adana-seyhan';

describe('crawlConfigSchema', () => {
    it('applies every documented default to a minimal valid config', () => {
        const cfg = crawlConfigSchema.parse({ startUrls: [VALID_START] });

        expect(cfg.startUrls).toEqual([VALID_START]);
        expect(cfg.maxConcurrency).toBe(3);
        expect(cfg.delayMinMs).toBe(2000);
        expect(cfg.delayMaxMs).toBe(5000);
        expect(cfg.allowedDomains).toEqual(['sahibinden.com', 'www.sahibinden.com']);
        expect(cfg.maxItems).toBeNull();
        expect(cfg.maxPages).toBeNull();
        expect(cfg.navigationTimeoutSeconds).toBe(90);
        expect(cfg.requestHandlerTimeoutSeconds).toBe(180);
        expect(cfg.maxRequestRetries).toBe(8);
        expect(cfg.debugMode).toBe(false);
        expect(cfg.storeRawHtml).toBe(false);
        expect(cfg.browser).toEqual({ mode: 'managed', headless: true });
        expect(cfg.proxy).toBeNull();
        expect(cfg.sessionCookiesFile).toBeNull();
        expect(cfg.outputDir).toBe('storage/datasets');
        expect(cfg.humanInTheLoop).toBe(true);
        expect(cfg.humanInTheLoopTimeoutSeconds).toBe(180);
        expect(cfg.name).toBeUndefined();
    });

    it('rejects an invalid startUrl', () => {
        const r = crawlConfigSchema.safeParse({ startUrls: ['not-a-url'] });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some(i => i.path.join('.') === 'startUrls.0')).toBe(true);
        }
    });

    it('rejects an empty startUrls array', () => {
        const r = crawlConfigSchema.safeParse({ startUrls: [] });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some(i => i.path.join('.') === 'startUrls')).toBe(true);
        }
    });

    it('rejects delayMaxMs < delayMinMs', () => {
        const r = crawlConfigSchema.safeParse({
            startUrls: [VALID_START],
            delayMinMs: 5000,
            delayMaxMs: 100,
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some(i => i.path.join('.') === 'delayMaxMs')).toBe(true);
        }
    });

    it('rejects browser.mode "cdp" without cdpUrl', () => {
        const r = crawlConfigSchema.safeParse({
            startUrls: [VALID_START],
            browser: { mode: 'cdp' },
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some(i => i.message.includes('cdpUrl'))).toBe(true);
        }
    });

    it('accepts browser.mode "cdp" with a cdpUrl', () => {
        const r = crawlConfigSchema.safeParse({
            startUrls: [VALID_START],
            browser: { mode: 'cdp', cdpUrl: 'http://127.0.0.1:9222' },
        });
        expect(r.success).toBe(true);
    });

    it.each([0, 11])('rejects maxConcurrency %i (schema bounds 1-10)', maxConcurrency => {
        const r = crawlConfigSchema.safeParse({ startUrls: [VALID_START], maxConcurrency });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some(i => i.path.join('.') === 'maxConcurrency')).toBe(true);
        }
    });

    it('defaults proxy to null and accepts an explicit proxy list', () => {
        expect(crawlConfigSchema.parse({ startUrls: [VALID_START] }).proxy).toBeNull();
        const withProxy = crawlConfigSchema.parse({
            startUrls: [VALID_START],
            proxy: { urls: ['http://user:pass@proxy.example:8080'] },
        });
        expect(withProxy.proxy).toEqual({ urls: ['http://user:pass@proxy.example:8080'] });
    });

    it('defaults maxItems to null and rejects maxItems 0', () => {
        expect(crawlConfigSchema.parse({ startUrls: [VALID_START] }).maxItems).toBeNull();
        expect(crawlConfigSchema.safeParse({ startUrls: [VALID_START], maxItems: 0 }).success).toBe(false);
    });
});

describe('loadConfig', () => {
    let dir: string;

    beforeAll(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'sahibindenbot-config-test-'));
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    it('throws a friendly error for a nonexistent file', async () => {
        const missing = path.join(dir, 'does-not-exist.json');
        await expect(loadConfig(missing)).rejects.toThrow(/Config file not readable/);
    });

    it('throws a friendly error for invalid JSON', async () => {
        const file = path.join(dir, 'broken.json');
        await writeFile(file, '{ this is not json', 'utf8');
        await expect(loadConfig(file)).rejects.toThrow(/Config file is not valid JSON/);
    });

    it('throws an error listing schema issues for schema-invalid JSON', async () => {
        const file = path.join(dir, 'schema-invalid.json');
        await writeFile(file, JSON.stringify({ startUrls: [], maxConcurrency: 99 }), 'utf8');
        const err = await loadConfig(file).then(
            () => null,
            (e: unknown) => e as Error,
        );
        expect(err).not.toBeNull();
        expect(err!.message).toContain('Invalid crawl config:');
        // Issues are listed one per line with their path.
        expect(err!.message).toMatch(/- startUrls:/);
        expect(err!.message).toMatch(/- maxConcurrency:/);
    });

    it('loads a valid config file with defaults applied', async () => {
        const file = path.join(dir, 'valid.json');
        await writeFile(file, JSON.stringify({ startUrls: [VALID_START], maxItems: 25 }), 'utf8');
        const cfg = await loadConfig(file);
        expect(cfg.startUrls).toEqual([VALID_START]);
        expect(cfg.maxItems).toBe(25);
        expect(cfg.maxConcurrency).toBe(3);
        expect(cfg.allowedDomains).toEqual(['sahibinden.com', 'www.sahibinden.com']);
    });
});
