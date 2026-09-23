/**
 * Pins the ScanDefinition-snapshot → CrawlConfig mapping: full field mapping,
 * schema-mirrored defaults, and the cdp-without-url passthrough (validation
 * belongs to the API layer, not this pure mapper).
 */
import { describe, expect, it } from 'vitest';
import { crawlConfigFromSnapshot, SNAPSHOT_DEFAULTS } from './config-from-snapshot.js';

describe('crawlConfigFromSnapshot', () => {
    it('maps every provided field', () => {
        const config = crawlConfigFromSnapshot({
            name: 'istanbul-konut',
            startUrls: ['https://www.sahibinden.com/satilik/istanbul'],
            maxItems: 500,
            maxPages: 25,
            includeDetails: true,
            maxConcurrency: 5,
            navigationTimeoutSeconds: 120,
            requestHandlerTimeoutSeconds: 240,
            maxRequestRetries: 4,
            delayMinMs: 1000,
            delayMaxMs: 3000,
            debugMode: true,
            storeRawHtml: true,
            browserMode: 'cdp',
            cdpUrl: 'http://127.0.0.1:9222',
            allowedDomains: ['sahibinden.com'],
            humanInTheLoop: false,
        });

        expect(config).toEqual({
            name: 'istanbul-konut',
            startUrls: ['https://www.sahibinden.com/satilik/istanbul'],
            maxItems: 500,
            maxPages: 25,
            includeDetails: true,
            maxConcurrency: 5,
            navigationTimeoutSeconds: 120,
            requestHandlerTimeoutSeconds: 240,
            maxRequestRetries: 4,
            delayMinMs: 1000,
            delayMaxMs: 3000,
            debugMode: true,
            storeRawHtml: true,
            browser: { mode: 'cdp', cdpUrl: 'http://127.0.0.1:9222' },
            proxy: null,
            sessionCookiesFile: null,
            allowedDomains: ['sahibinden.com'],
            outputDir: SNAPSHOT_DEFAULTS.outputDir,
            humanInTheLoop: false,
            humanInTheLoopTimeoutSeconds: SNAPSHOT_DEFAULTS.humanInTheLoopTimeoutSeconds,
        });
    });

    it('applies schema defaults for a minimal snapshot', () => {
        const config = crawlConfigFromSnapshot({ startUrls: ['https://www.sahibinden.com/satilik'] });

        expect(config).toEqual({
            startUrls: ['https://www.sahibinden.com/satilik'],
            maxItems: null,
            maxPages: null,
            includeDetails: false,
            maxConcurrency: 3,
            navigationTimeoutSeconds: 90,
            requestHandlerTimeoutSeconds: 180,
            maxRequestRetries: 8,
            delayMinMs: 2000,
            delayMaxMs: 5000,
            debugMode: false,
            storeRawHtml: false,
            browser: { mode: 'managed', headless: false },
            proxy: null,
            sessionCookiesFile: null,
            allowedDomains: ['sahibinden.com', 'www.sahibinden.com'],
            outputDir: 'storage/datasets',
            humanInTheLoop: true,
            humanInTheLoopTimeoutSeconds: 180,
        });
    });

    it('treats DB-style null optionals as unset (except maxItems/maxPages where null is meaningful)', () => {
        const config = crawlConfigFromSnapshot({
            startUrls: ['https://www.sahibinden.com/satilik'],
            name: null,
            maxConcurrency: null,
            includeDetails: null,
            allowedDomains: null,
            humanInTheLoop: null,
            browserMode: null,
            cdpUrl: null,
        });

        expect(config.name).toBeUndefined();
        expect(config.maxConcurrency).toBe(3);
        expect(config.includeDetails).toBe(false);
        expect(config.allowedDomains).toEqual(['sahibinden.com', 'www.sahibinden.com']);
        expect(config.humanInTheLoop).toBe(true);
        expect(config.browser).toEqual({ mode: 'managed', headless: false });
        // Explicit nulls survive as nulls (unlimited), not as defaults-of-last-resort.
        expect(config.maxItems).toBeNull();
        expect(config.maxPages).toBeNull();
    });

    it('passes cdp mode without cdpUrl through unchanged (validation is the API layer job)', () => {
        const config = crawlConfigFromSnapshot({
            startUrls: ['https://www.sahibinden.com/satilik'],
            browserMode: 'cdp',
        });
        expect(config.browser.mode).toBe('cdp');
        expect(config.browser.cdpUrl).toBeUndefined();
    });

    it('never aliases input arrays (snapshot mutation cannot leak into the config)', () => {
        const startUrls = ['https://www.sahibinden.com/satilik'];
        const allowedDomains = ['example.com'];
        const config = crawlConfigFromSnapshot({ startUrls, allowedDomains });

        startUrls.push('https://evil.example');
        allowedDomains.push('evil.example');

        expect(config.startUrls).toEqual(['https://www.sahibinden.com/satilik']);
        expect(config.allowedDomains).toEqual(['example.com']);
    });

    it('falls back to default allowedDomains when an empty array is provided', () => {
        const config = crawlConfigFromSnapshot({
            startUrls: ['https://www.sahibinden.com/satilik'],
            allowedDomains: [],
        });
        expect(config.allowedDomains).toEqual(['sahibinden.com', 'www.sahibinden.com']);
    });
});
