/**
 * `runCrawl` — the local-first replacement for upstream's Apify actor main.
 *
 * Behavior ported from upstream `src/main.js` (commit a14740c); Apify plumbing
 * replaced by injected ports (CrawlDeps). See docs/UPSTREAM_AUDIT.md and
 * docs/BASELINE_CONTRACT.md.
 *
 * INTENTIONALLY REMOVED per ADR-0002 (legal boundary) — do not reintroduce:
 * - session pre-warm navigations to earn cf_clearance (CDP mode uses the real
 *   profile; managed mode relies on human-in-the-loop);
 * - `crawler._throwOnBlockedRequest` private-API monkey-patch;
 * - automated PX hold / CF challenge solving (replaced by detection +
 *   human-in-the-loop);
 * - UA pinning/rotation, sec-ch-ua and Sec-Fetch header forging, fingerprint
 *   overrides, stealth plugin (see browser/browser-provider.ts).
 * `autoscaledPool.abort()` for maxItems/cancellation is kept (public API).
 */
import path from 'node:path';
import {
    PuppeteerCrawler,
    type ProxyConfiguration,
    type PuppeteerCrawlingContext,
} from 'crawlee';
import type { Page } from 'puppeteer';
import {
    CrawlError,
    type CategoryListing,
    type CrawlConfig,
    type CrawlErrorCode,
    type CrawlEventType,
    type CrawlResult,
    type CrawlRunStatus,
    type ListingDetail,
} from '@sahibindenbot/shared';
import {
    CATEGORY_ROW_SELECTOR,
    DETAIL_READY_SELECTOR,
    FALLBACK_ROW_SELECTORS,
    NEXT_PAGE_SELECTOR,
    extractCategoryRawInPage,
    extractDetailRawInPage,
    extractListingId,
    isUnavailableDetailHtml,
    normalizeCategoryItems,
    normalizeDetail,
} from '@sahibindenbot/parser-sahibinden';
import { createBrowserProvider } from '../browser/browser-provider.js';
import { randomDelay } from '../utils.js';
import type { ChallengeKind, CrawlDeps } from '../types.js';
import { detectChallengeKind, isChallengedPage, isPxHoldChallenge } from './challenge.js';
import { crawlError, classifyError, classifyErrorMessages } from './errors.js';
import { routeLabel } from './router.js';

const BLOCKED_STATUSES = new Set([403, 503, 429]);
const TLOADING_WAIT_MS = 30_000;
const ROW_SELECTOR_WAIT_MS = 15_000;
const DETAIL_READY_WAIT_MS = 15_000;
const HUMAN_POLL_MS = 3_000;

/**
 * SSRF guard: only configured domains may be crawled (start URLs and enqueued
 * pagination alike). Upstream had NO domain check — this is an added policy.
 */
export function assertAllowedDomain(url: string, allowedDomains: string[]): void {
    let hostname: string;
    try {
        hostname = new URL(url).hostname;
    } catch {
        throw crawlError('INVALID_PAGE', `Malformed URL rejected: ${url}`);
    }
    const allowed = allowedDomains.some(d => hostname === d || hostname.endsWith(`.${d}`));
    if (!allowed) {
        throw crawlError('INVALID_PAGE', `URL host "${hostname}" is not in allowedDomains`);
    }
}

/** Runs one crawl to completion (or cancellation) and returns a structured result. */
export async function runCrawl(config: CrawlConfig, deps: CrawlDeps): Promise<CrawlResult> {
    const startedAt = new Date();
    const { logger } = deps;

    // Keep Crawlee's request queue / KV storage local to this project.
    // Must be set before the crawler (lazily) initializes its storage clients.
    if (!process.env.CRAWLEE_STORAGE_DIR) {
        process.env.CRAWLEE_STORAGE_DIR = path.resolve(config.outputDir, '..', 'crawlee');
    }

    const errors: CrawlResult['errors'] = [];
    let itemsDiscovered = 0;
    let itemsWritten = 0;
    let categoryPagesVisited = 0;
    let detailPagesVisited = 0;
    let detailsWritten = 0;
    let failedRequests = 0;
    /** Per-run dedup for DETAIL enqueues (listing id, falling back to URL). */
    const seenDetailKeys = new Set<string>();

    const emit = (type: CrawlEventType, data?: Record<string, unknown>): void => {
        try {
            deps.events.emit({ type, at: new Date().toISOString(), data });
        } catch (err) {
            // A broken event sink must never kill a crawl.
            logger.warn('Event sink threw', { type, error: (err as Error).message });
        }
    };

    const buildResult = (status: CrawlRunStatus): CrawlResult => {
        const finishedAt = new Date();
        return {
            status,
            itemsDiscovered,
            itemsWritten,
            categoryPagesVisited,
            failedRequests,
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            errors,
            // Additive optional counters — only meaningful for detail runs.
            ...(config.includeDetails ? { detailPagesVisited, detailsWritten } : {}),
        };
    };

    emit('RUN_STARTED', {
        name: config.name ?? 'crawl',
        startUrls: config.startUrls,
        maxItems: config.maxItems,
        maxPages: config.maxPages,
        browserMode: config.browser.mode,
    });

    // --- Start URLs: SSRF validation + label routing (upstream main.js:823-841) ---
    const startRequests: Array<{ url: string; userData: { label: string } }> = [];
    for (const url of config.startUrls) {
        try {
            assertAllowedDomain(url, config.allowedDomains);
            const isDetailUrl = url.includes('/ilan/') && url.includes('/detay');
            startRequests.push({ url, userData: { label: isDetailUrl ? 'DETAIL' : 'CATEGORY' } });
        } catch (err) {
            const message = (err as Error).message;
            logger.warn('Skipping disallowed start URL', { url, message });
            errors.push({ code: 'INVALID_PAGE', message, url });
        }
    }

    if (startRequests.length === 0) {
        logger.error('No valid start URLs after allowed-domain validation.');
        emit('RUN_FAILED', { message: 'No valid start URLs after allowed-domain validation.' });
        const result = buildResult('FAILED');
        await finalizeOutput(deps, logger);
        return result;
    }

    // Cookies are loaded once per run; injection into the browser happens once
    // per Crawlee session (preNavigationHook, `userData.cookiesInjected` flag).
    const sessionCookies = await deps.sessionProvider.getCookies();
    if (sessionCookies.length > 0) {
        logger.info('Session cookies loaded', { count: sessionCookies.length });
    } else {
        logger.warn('No session cookies provided — login-walled content will fail with AUTH_REQUIRED.');
    }

    const proxyConfiguration = (await deps.proxyProvider.getProxyConfiguration()) as ProxyConfiguration | null;
    if (proxyConfiguration === null) {
        logger.warn('No proxy configured — crawling direct. Sahibinden may rate-limit this connection.');
    }

    const browserProvider = createBrowserProvider(config.browser, logger);
    // Human-in-the-loop only makes sense when a human can see the browser.
    const browserIsVisible = config.browser.mode === 'cdp' || config.browser.headless === false;

    // A human solve must fit inside the request handler timeout (upstream bug:
    // 180s handler timeout raced the 180s manual-solve window — audit §14.10).
    const requestHandlerTimeoutSecs = Math.max(
        config.requestHandlerTimeoutSeconds,
        config.humanInTheLoop ? config.humanInTheLoopTimeoutSeconds + 60 : 0,
    );

    const saveDebugArtifacts = async (page: Page, label: string): Promise<void> => {
        if (!config.debugMode) return;
        try {
            const png = await page.screenshot({ fullPage: true, type: 'png' });
            await deps.debugStore.saveScreenshot(label, png);
        } catch (err) {
            logger.warn('Could not save debug screenshot', { label, error: (err as Error).message });
        }
        try {
            const html = await page.content();
            await deps.debugStore.saveHtml(label, html);
        } catch (err) {
            logger.warn('Could not save debug HTML', { label, error: (err as Error).message });
        }
    };

    /**
     * Human-in-the-loop challenge handling (replaces ALL automated solving).
     * Polls the page until a human clears the challenge. NEVER auto-solves,
     * NEVER holds buttons programmatically.
     */
    const waitForHumanSolve = async (page: Page, url: string, kind: ChallengeKind): Promise<boolean> => {
        if (!config.humanInTheLoop || !browserIsVisible) return false;

        emit('HUMAN_SOLVE_REQUESTED', { url, kind, timeoutSeconds: config.humanInTheLoopTimeoutSeconds });
        logger.warn(
            '>>> HUMAN SOLVE REQUIRED: please solve the verification in the visible browser window. Waiting...',
            { url, kind, timeoutSeconds: config.humanInTheLoopTimeoutSeconds },
        );

        const deadline = Date.now() + config.humanInTheLoopTimeoutSeconds * 1000;
        while (Date.now() < deadline) {
            if (deps.cancellation?.isCancelled) return false;
            await new Promise(resolve => setTimeout(resolve, HUMAN_POLL_MS));
            const html = await page.content().catch(() => '');
            if (!html) continue; // mid-navigation — keep waiting
            const currentUrl = page.url();
            const stillChallenged =
                isPxHoldChallenge(html) ||
                isChallengedPage(html) ||
                currentUrl.includes('/giris') ||
                currentUrl.includes('secure.sahibinden.com');
            if (!stillChallenged) {
                emit('HUMAN_SOLVE_RESOLVED', { url });
                logger.info('>>> Human verification succeeded, continuing.', { url });
                return true;
            }
        }

        logger.warn('>>> Human solve timed out.', { url, timeoutSeconds: config.humanInTheLoopTimeoutSeconds });
        return false;
    };

    const crawler = new PuppeteerCrawler({
        // null → undefined: Crawlee's option validation rejects explicit null.
        proxyConfiguration: proxyConfiguration ?? undefined,
        maxConcurrency: config.maxConcurrency,
        // With details, every category page can spawn up to a pageful of
        // DETAIL requests: pages + items + slack. Otherwise keep the
        // upstream heuristic (maxItems * 3, else 1000).
        maxRequestsPerCrawl: config.includeDetails
            ? (config.maxPages ?? 100) + (config.maxItems ?? 1000) + 10
            : config.maxItems
              ? config.maxItems * 3
              : 1000,
        maxRequestRetries: config.maxRequestRetries,
        navigationTimeoutSecs: config.navigationTimeoutSeconds,
        requestHandlerTimeoutSecs,

        useSessionPool: true,
        // SessionPolicy (ARCHITECTURE.md §4) arrives via CrawlDeps; absent →
        // the historical defaults (pool 10, maxUsageCount 50, persist true).
        // The DB model's proxyAffinity / retireOnNetworkFailures /
        // failureThreshold fields are consumed by the WORKER layer (proxy
        // health + quarantine + retirement), never by the engine.
        persistCookiesPerSession: deps.sessionPolicy?.persistCookiesPerSession ?? true,
        sessionPoolOptions: {
            maxPoolSize: deps.sessionPolicy?.poolSize ?? 10,
            sessionOptions: { maxUsageCount: deps.sessionPolicy?.maxUsageCount ?? 50 },
        },

        browserPoolOptions: { retireBrowserAfterPageCount: 20 },

        launchContext: {
            launcher: browserProvider.getLauncher(),
            launchOptions: browserProvider.getLaunchOptions(),
        },

        preNavigationHooks: [
            async ({ page, session }, gotoOptions) => {
                // Inject authorized user cookies ONCE per session. Re-injecting on
                // every request would overwrite the fresh cookies the browser earns
                // with the stale originals (upstream rationale, main.js:281-284).
                const alreadyInjected = session?.userData?.cookiesInjected === true;
                if (!alreadyInjected && sessionCookies.length > 0) {
                    const nowSecs = Date.now() / 1000;
                    const valid = sessionCookies.filter(c => {
                        if (!c.name) return false;
                        if (c.expires !== undefined && c.expires > 0 && c.expires < nowSecs) return false;
                        return true;
                    });
                    if (valid.length < sessionCookies.length) {
                        logger.warn(`Filtered ${sessionCookies.length - valid.length} expired session cookies.`);
                    }
                    if (valid.length > 0) {
                        await page.setCookie(
                            ...valid.map(c => ({
                                name: c.name,
                                value: c.value,
                                domain: c.domain ?? '.sahibinden.com',
                                path: c.path ?? '/',
                                secure: c.secure !== false,
                                httpOnly: c.httpOnly === true,
                                ...(c.sameSite ? { sameSite: c.sameSite } : {}),
                                ...(c.expires !== undefined && c.expires > 0 ? { expires: c.expires } : {}),
                            })),
                        );
                        // Cookie NAMES only — values never touch logs/events.
                        logger.info(`Injected ${valid.length} session cookies`, { names: valid.map(c => c.name) });
                    } else {
                        logger.warn('All provided session cookies were expired — none injected. Export fresh cookies.');
                    }
                    if (session) session.userData = { ...session.userData, cookiesInjected: true };
                }

                await page.setViewport({ width: 1920, height: 1080 });

                if (gotoOptions) {
                    gotoOptions.waitUntil = 'networkidle2';
                    gotoOptions.timeout = config.navigationTimeoutSeconds * 1000;
                }
            },
        ],

        postNavigationHooks: [
            async ({ page, response, request, session }) => {
                const statusCode = response?.status();
                logger.info(`Response status: ${statusCode ?? 'unknown'} for ${request.url}`);

                if (statusCode !== undefined && BLOCKED_STATUSES.has(statusCode)) {
                    logger.warn(`Got ${statusCode} for ${request.url} — checking page content...`);
                    await saveDebugArtifacts(page, `${statusCode}-initial`);

                    const content = await page.content().catch(() => '');
                    const kind = detectChallengeKind(content);
                    emit('CHALLENGE_DETECTED', { kind, url: request.url, statusCode });
                    await saveDebugArtifacts(page, `${statusCode}-${kind}`);

                    const solved = await waitForHumanSolve(page, request.url, kind);
                    if (!solved) {
                        session?.markBad();
                        throw crawlError(
                            'RATE_LIMIT',
                            `Blocked with status ${statusCode} (${kind}) and no human resolution`,
                        );
                    }
                    // Solved: fall through — the live page now holds real content;
                    // the (stale) response status is ignored below.
                }

                // tloading interstitial (HTTP 200 JS-redirect page) — wait ≤30s.
                if (page.url().includes('/cs/tloading')) {
                    logger.info('Detected tloading protection page, waiting for JS redirect...');
                    try {
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: TLOADING_WAIT_MS });
                        logger.info(`tloading resolved, now at: ${page.url()}`);
                    } catch {
                        session?.markBad();
                        throw crawlError('TIMEOUT', 'tloading interstitial did not redirect within 30s');
                    }
                }

                // Login wall → session cookies are missing/expired.
                if (page.url().includes('/giris') || page.url().includes('secure.sahibinden.com')) {
                    emit('CHALLENGE_DETECTED', { kind: 'login-wall', url: page.url() });
                    const solved = await waitForHumanSolve(page, request.url, 'login-wall');
                    if (!solved) {
                        session?.markBad();
                        throw crawlError(
                            'AUTH_REQUIRED',
                            'Mandatory login required. Session cookies are missing or expired.',
                        );
                    }
                }

                if (statusCode !== undefined && statusCode >= 200 && statusCode < 300) {
                    session?.markGood();
                }
            },
        ],

        requestHandler: async ctx => {
            // Cooperative cancellation between requests (category AND detail).
            if (deps.cancellation?.isCancelled) {
                await crawler.autoscaledPool?.abort();
                return;
            }

            // Explicit label routing — throws UNSUPPORTED_LABEL for anything
            // but 'CATEGORY'/'DETAIL'. A DETAIL request never reaches
            // category parsing logic and vice versa.
            const label = routeLabel(ctx.request.userData?.label);

            // Politeness pacing applies to every request type.
            await randomDelay(config.delayMinMs, config.delayMaxMs);

            if (label === 'DETAIL') {
                await handleDetailPage(ctx);
            } else {
                await handleCategoryPage(ctx);
            }
        },

        // Fires on every failed attempt (before retry) — drives REQUEST_RETRY.
        errorHandler: async ({ request }, error) => {
            const code = classifyError(error);
            if (request.retryCount < config.maxRequestRetries) {
                emit('REQUEST_RETRY', { url: request.url, retryCount: request.retryCount + 1, code });
            }
        },

        // After all retries: RECORD the failure (upstream only logged it — the
        // URL was silently lost; audit §5 hole #2).
        failedRequestHandler: async ({ request }) => {
            failedRequests++;
            const code = classifyErrorMessages(request.errorMessages);
            const message = (request.errorMessages?.join(' | ') ?? 'unknown error').slice(0, 500);
            errors.push({ code, message, url: request.url });
            logger.error('Request failed after all retries', { url: request.url, code });
            emit('REQUEST_FAILED', { url: request.url, code });
        },
    });

    const handleCategoryPage = async (ctx: PuppeteerCrawlingContext): Promise<void> => {
        const { page, request, enqueueLinks } = ctx;
        emit('CATEGORY_STARTED', { url: request.url });

        // 1) Locate listing rows: primary selector (waited), then the 7-fallback chain.
        let rowSelector: string | null = CATEGORY_ROW_SELECTOR;
        let rowCount = 0;
        try {
            await page.waitForSelector(CATEGORY_ROW_SELECTOR, { timeout: ROW_SELECTOR_WAIT_MS });
            rowCount = (await page.$$(CATEGORY_ROW_SELECTOR)).length;
        } catch {
            rowCount = 0;
        }
        if (rowCount === 0) {
            logger.warn(`Primary selector failed: ${CATEGORY_ROW_SELECTOR}`, { url: request.url });
            await saveDebugArtifacts(page, 'category-selector-failed');
            for (const alt of FALLBACK_ROW_SELECTORS) {
                const n = (await page.$$(alt)).length;
                if (n > 0) {
                    rowSelector = alt;
                    rowCount = n;
                    logger.info(`Found ${n} rows with fallback selector: ${alt}`);
                    break;
                }
            }
            if (rowCount === 0) rowSelector = null;
        }
        if (rowSelector === null) {
            // Zero rows on a 200 category page: upstream swallowed this (audit
            // §5 hole #1). Our contract: never silently succeed-empty.
            await saveDebugArtifacts(page, 'category-no-rows');
            throw crawlError(
                'PARSER_CHANGED',
                `No listing rows found on category page with any known selector: ${request.url}`,
            );
        }

        // 2) Extract in-page → normalize node-side (13-field contract).
        const rawRows = await page.evaluate(extractCategoryRawInPage, rowSelector);
        const parsed = normalizeCategoryItems(rawRows, request.url);
        if (parsed.length < rawRows.length) {
            logger.debug(`Skipped ${rawRows.length - parsed.length} rows missing title/url`, {
                url: request.url,
            });
        }

        // 3) maxItems cut, then one batch write per page (upstream granularity).
        let batch = parsed;
        if (config.maxItems !== null) {
            const remaining = config.maxItems - itemsWritten;
            batch = remaining > 0 ? parsed.slice(0, remaining) : [];
        }
        itemsDiscovered += parsed.length;
        if (batch.length > 0) {
            await deps.output.upsertListings(batch);
            itemsWritten += batch.length;
        }
        categoryPagesVisited++;
        logger.info(`Parsed ${batch.length} listings from page. Total written: ${itemsWritten}`, {
            url: request.url,
        });
        emit('CATEGORY_PARSED', { url: request.url, itemCount: batch.length });
        emit('LISTING_DISCOVERED', { total: itemsWritten, discovered: itemsDiscovered });

        if (config.storeRawHtml) {
            const html = await page.content().catch(() => null);
            if (html) await deps.debugStore.saveHtml(`category-page-${categoryPagesVisited}`, html);
        }

        // 4) Cooperative cancellation between pages.
        if (deps.cancellation?.isCancelled) {
            logger.info('Cancellation requested — stopping crawl.');
            await crawler.autoscaledPool?.abort();
            return;
        }

        // 5) Detail enqueue (includeDetails): one DETAIL request per written
        // listing. `batch` is already maxItems-capped, so details never exceed
        // the cap; a per-run key set dedups repeats across pages; off-domain
        // URLs are skipped with a warning (same SSRF policy as pagination).
        if (config.includeDetails && batch.length > 0) {
            const detailRequests: Array<{
                url: string;
                userData: { label: 'DETAIL'; listingData: CategoryListing };
            }> = [];
            for (const item of batch) {
                const dedupKey = item.id ?? item.url;
                if (seenDetailKeys.has(dedupKey)) continue;
                try {
                    assertAllowedDomain(item.url, config.allowedDomains);
                } catch {
                    logger.warn('Skipping off-domain detail URL', { url: item.url });
                    continue;
                }
                seenDetailKeys.add(dedupKey);
                detailRequests.push({ url: item.url, userData: { label: 'DETAIL', listingData: item } });
            }
            if (detailRequests.length > 0) {
                await crawler.addRequests(detailRequests);
                logger.info(`Enqueued ${detailRequests.length} detail requests`, { url: request.url });
            }
        }

        // 6) Pagination: follow "Sonraki" until absent / maxPages / maxItems.
        const itemsAllowMore = config.maxItems === null || itemsWritten < config.maxItems;
        const pagesAllowMore = config.maxPages === null || categoryPagesVisited < config.maxPages;
        if (itemsAllowMore && pagesAllowMore) {
            const nextHref = await page
                .$eval(NEXT_PAGE_SELECTOR, el => (el as HTMLAnchorElement).href)
                .catch(() => null);
            if (nextHref) {
                const absoluteNext = new URL(nextHref, request.loadedUrl ?? request.url).toString();
                try {
                    assertAllowedDomain(absoluteNext, config.allowedDomains);
                    await enqueueLinks({ urls: [absoluteNext], userData: { label: 'CATEGORY' } });
                    logger.info(`Enqueued next category page: ${absoluteNext}`);
                } catch (err) {
                    if (err instanceof CrawlError) {
                        logger.warn('Skipping off-domain pagination URL', { url: absoluteNext });
                    } else {
                        throw err;
                    }
                }
            } else {
                logger.info(`No next page button found on ${request.url}`);
            }
        }

        // 7) maxItems reached → stop scheduling (public API, kept from
        // upstream). With includeDetails the pool must stay alive to drain the
        // enqueued DETAIL requests — the pagination gate above already stops
        // new category pages, so the run ends naturally when the queue empties.
        if (!config.includeDetails && config.maxItems !== null && itemsWritten >= config.maxItems) {
            logger.info(`maxItems (${config.maxItems}) reached — stopping crawl.`);
            await crawler.autoscaledPool?.abort();
        }
    };

    /**
     * DETAIL handler — exactly one detail page per request. NEVER runs
     * category parsing logic. A removed/unavailable listing is a normal
     * outcome (DETAIL_UNAVAILABLE), not an error; a broken parser on a
     * present listing fails only this request (INVALID_PAGE/PARSER_CHANGED),
     * never the run.
     */
    const handleDetailPage = async (ctx: PuppeteerCrawlingContext): Promise<void> => {
        const { page, request } = ctx;
        const listingData = request.userData?.listingData as CategoryListing | undefined;
        const listingId = listingData?.id ?? extractListingId(request.url);
        emit('DETAIL_STARTED', { url: request.url, listingId });

        // 1) Wait for the detail container; on timeout decide between a
        // removed listing (normal) and a parser break (error). The
        // unavailable check runs on the matched path too (defense in depth).
        let readySelectorFound = true;
        try {
            await page.waitForSelector(DETAIL_READY_SELECTOR, { timeout: DETAIL_READY_WAIT_MS });
        } catch {
            readySelectorFound = false;
        }
        const html = await page.content().catch(() => '');
        if (isUnavailableDetailHtml(html)) {
            detailPagesVisited++;
            logger.info('Detail page unavailable (removed listing)', { url: request.url, listingId });
            emit('DETAIL_UNAVAILABLE', { url: request.url, listingId });
            return; // NOT an error — nothing recorded.
        }
        if (!readySelectorFound) {
            await saveDebugArtifacts(page, 'detail-ready-timeout');
            throw crawlError(
                'PARSER_CHANGED',
                `Detail ready selector not found within ${DETAIL_READY_WAIT_MS}ms: ${request.url}`,
            );
        }

        // 2) Extract in-page → normalize node-side. A throwing normalizer
        // fails only this request — one bad detail must never kill the run.
        const raw = await page.evaluate(extractDetailRawInPage);
        let detail: ListingDetail;
        try {
            detail = normalizeDetail(raw, { url: request.url, category: listingData });
        } catch (err) {
            await saveDebugArtifacts(page, 'detail-normalize-failed');
            throw crawlError(
                'INVALID_PAGE',
                `normalizeDetail failed for ${request.url}: ${(err as Error).message}`,
                err,
            );
        }

        // 3) One record per detail page (repo dedups by listingId).
        await deps.output.upsertDetails([detail]);
        detailPagesVisited++;
        detailsWritten++;
        logger.info(`Parsed detail ${detail.listingId ?? request.url}. Total details: ${detailsWritten}`, {
            url: request.url,
        });
        emit('DETAIL_PARSED', { url: request.url, listingId: detail.listingId, sellerType: detail.sellerType });
    };

    let result: CrawlResult;
    try {
        await crawler.addRequests(startRequests);
        logger.info(`Added ${startRequests.length} initial requests to the queue.`);
        await crawler.run();

        const cancelled = deps.cancellation?.isCancelled === true;
        const status: CrawlRunStatus = cancelled
            ? 'CANCELLED'
            : failedRequests === 0
              ? 'SUCCEEDED'
              : itemsWritten > 0
                ? 'PARTIAL'
                : 'FAILED';
        result = buildResult(status);

        if (status === 'FAILED') {
            emit('RUN_FAILED', { message: 'All requests failed; nothing written.', ...summarize(result) });
        } else {
            emit('RUN_COMPLETED', summarize(result));
        }
    } catch (err) {
        const code: CrawlErrorCode = classifyError(err);
        const message = (err as Error).message;
        errors.push({ code, message });
        logger.error('Crawl run crashed', { code, message });
        result = buildResult(deps.cancellation?.isCancelled ? 'CANCELLED' : 'FAILED');
        emit('RUN_FAILED', { message, code });
    } finally {
        await finalizeOutput(deps, logger);
    }

    logger.info('Crawl finished', summarize(result));
    return result;
}

function summarize(result: CrawlResult): Record<string, unknown> {
    return {
        status: result.status,
        itemsDiscovered: result.itemsDiscovered,
        itemsWritten: result.itemsWritten,
        categoryPagesVisited: result.categoryPagesVisited,
        failedRequests: result.failedRequests,
        durationMs: result.durationMs,
        ...(result.detailPagesVisited !== undefined
            ? { detailPagesVisited: result.detailPagesVisited, detailsWritten: result.detailsWritten ?? 0 }
            : {}),
    };
}

async function finalizeOutput(deps: CrawlDeps, logger: CrawlDeps['logger']): Promise<void> {
    try {
        await deps.output.finalize();
    } catch (err) {
        logger.error('Output finalize failed', { error: (err as Error).message });
    }
}
