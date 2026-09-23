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
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
    PuppeteerCrawler,
    RequestQueue,
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
import {
    detectChallengeKind,
    isChallengeVisible,
    isChallengedPage,
    isPxHoldChallenge,
    isUnusualAccessHtml,
    pageHasCrawlableContent,
    unusualAccessVisible,
} from './challenge.js';
import { crawlError, classifyError, classifyErrorMessages } from './errors.js';
import {
    clickElementLikeHuman,
    findListingTitleLink,
    goBackLikeHuman,
    isHumanPacing,
    lookAround,
} from './human-browse.js';
import { routeLabel } from './router.js';
import {
    PROXY_HOP_EVERY,
    UNUSUAL_ACCESS_COOLDOWN_MS,
    UNUSUAL_ACCESS_MAX_RECOVERIES,
    clearBrowserCookies,
    isListingDetailUrl,
    isUnusualAccessUrl,
    proxyHopCooldownMs,
    proxyRotationAvailable,
    resumeUrlForUnusualAccess,
    shouldHopProxy,
} from './unusual-access.js';

const BLOCKED_STATUSES = new Set([403, 503, 429]);
const TLOADING_WAIT_MS = 30_000;
const ROW_SELECTOR_WAIT_MS = 15_000;
const DETAIL_READY_WAIT_MS = 15_000;
const HUMAN_POLL_MS = 3_000;
/** CF often answers 403 / leftover challenge HTML, then paints the real page. */
const CHALLENGE_GRACE_MS = 60_000;
const CHALLENGE_GRACE_POLL_MS = 2_000;
// Behavior pacing: after this many detail pages, take a cooldown so
// Cloudflare's per-IP signal decays. 8 was the observed safe burst size;
// cooldown is a pause, not a second burst — trimmed vs the first conservative 30–60s.
const DETAIL_BATCH_SIZE = 8;
const DETAIL_BATCH_COOLDOWN_MIN_MS = 18_000;
const DETAIL_BATCH_COOLDOWN_MAX_MS = 36_000;

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
    const canRotateProxy = proxyRotationAvailable(config.browser.mode, proxyConfiguration !== null);
    if (proxyConfiguration === null) {
        logger.warn('No proxy configured — crawling direct. Sahibinden may rate-limit this connection.');
    } else if (!canRotateProxy) {
        logger.warn('Proxy profile is set but CDP ignores it — residential rotation needs Managed browser mode');
    } else {
        logger.info('Residential proxy rotation enabled — hop before unusual-access, concurrency capped at 1');
    }

    const browserProvider = createBrowserProvider(config.browser, logger);
    // Human-in-the-loop only makes sense when a human can see the browser.
    const browserIsVisible = config.browser.mode === 'cdp' || config.browser.headless === false;

    // Crawlee's default request queue is process-global and persists handled
    // URLs on disk. A long-lived worker then treats the same start URL as
    // already done (~500ms SUCCEEDED, 0 listings). Isolate every crawl.
    const requestQueue = await RequestQueue.open(`run-${randomUUID()}`);

    const humanPacing = isHumanPacing(config.delayMinMs);
    let resumeTargetUrl = startRequests[0]?.url ?? '';
    let unusualAccessRecoveries = 0;
    let skipCookieReinject = false;
    let abortCurrentHandler = false;
    const crawlerRef: { current: PuppeteerCrawler | null } = { current: null };

    const rememberListUrl = (url: string): void => {
        if (url.trim() === '' || isListingDetailUrl(url) || isUnusualAccessUrl(url)) return;
        if (url.includes('/giris') || url.includes('/cs/tloading')) return;
        resumeTargetUrl = url;
    };

    // Click-through details stay on one category request: dwell + back +
    // batch cooldowns. Budget ~36s per listing plus cooldown slack.
    const clickThroughBudgetSecs =
        config.includeDetails && humanPacing
            ? Math.max(1_800, (config.maxItems ?? 20) * 36 + 480)
            : 0;
    const unusualAccessBudgetSecs = UNUSUAL_ACCESS_MAX_RECOVERIES * 720;
    const hopBudgetSecs =
        canRotateProxy && config.includeDetails
            ? Math.ceil((config.maxItems ?? 1000) / PROXY_HOP_EVERY) * 50
            : 0;
    const requestHandlerTimeoutSecs = Math.max(
        config.requestHandlerTimeoutSeconds,
        config.humanInTheLoop ? config.humanInTheLoopTimeoutSeconds + 60 : 0,
        clickThroughBudgetSecs + unusualAccessBudgetSecs + hopBudgetSecs,
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
    const pageLooksReady = async (page: Page): Promise<boolean> => {
        try {
            return (await page.evaluate(pageHasCrawlableContent)) === true;
        } catch {
            return false;
        }
    };

    const visibleChallengeOn = async (page: Page): Promise<boolean> => {
        try {
            return (await page.evaluate(isChallengeVisible)) === true;
        } catch {
            return false;
        }
    };

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

            let currentUrl = '';
            try {
                currentUrl = page.url();
            } catch {
                await new Promise(resolve => setTimeout(resolve, HUMAN_POLL_MS));
                continue;
            }

            const onLoginWall =
                currentUrl.includes('/giris') || currentUrl.includes('secure.sahibinden.com');
            const ready = await pageLooksReady(page);
            const visible = await visibleChallengeOn(page);

            if (!onLoginWall && (ready || !visible)) {
                emit('HUMAN_SOLVE_RESOLVED', { url });
                logger.info('>>> Page is usable, continuing.', { url, ready, visible });
                return true;
            }

            await new Promise(resolve => setTimeout(resolve, HUMAN_POLL_MS));
        }

        // Timed out but still nothing on screen to solve: do not fail the run.
        const ready = await pageLooksReady(page);
        const visible = await visibleChallengeOn(page);
        if (ready || !visible) {
            emit('HUMAN_SOLVE_RESOLVED', { url });
            logger.info('>>> Human-solve window ended with a usable page, continuing.', { url, ready, visible });
            return true;
        }

        logger.warn('>>> Human solve timed out.', { url, timeoutSeconds: config.humanInTheLoopTimeoutSeconds });
        return false;
    };

    const sleepCancellable = async (ms: number): Promise<boolean> => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (deps.cancellation?.isCancelled) return false;
            const slice = Math.min(5_000, end - Date.now());
            if (slice <= 0) break;
            await new Promise(resolve => setTimeout(resolve, slice));
        }
        return deps.cancellation?.isCancelled !== true;
    };

    const hopAfterCooldown = async (
        page: Page,
        session: PuppeteerCrawlingContext['session'],
        reason: 'proxy-hop' | 'unusual-access',
        cooldownMs: number,
    ): Promise<void> => {
        const resumeUrl = resumeUrlForUnusualAccess(page.url(), resumeTargetUrl);
        rememberListUrl(resumeUrl);
        if (reason === 'unusual-access') {
            emit('UNUSUAL_ACCESS_COOLDOWN', {
                url: page.url(),
                resumeUrl,
                cooldownMs,
                attempt: unusualAccessRecoveries,
                rotatedProxy: canRotateProxy,
            });
        } else {
            emit('PROXY_ROTATED', {
                url: page.url(),
                resumeUrl,
                cooldownMs,
                detailsWritten,
                hopEvery: PROXY_HOP_EVERY,
            });
        }
        logger.warn(
            reason === 'unusual-access'
                ? `Unusual access — ${Math.round(cooldownMs / 1000)}s cooldown, wipe cookies, resume ${resumeUrl}`
                : `Proxy hop after ${detailsWritten} details — ${Math.round(cooldownMs / 1000)}s cooldown, new IP, resume ${resumeUrl}`,
            { reason, resumeUrl, canRotateProxy, detailsWritten },
        );
        const waited = await sleepCancellable(cooldownMs);
        if (!waited) return;
        await clearBrowserCookies(page);
        skipCookieReinject = true;
        if (session) {
            session.userData = { ...session.userData, cookiesInjected: true };
        }
        if (canRotateProxy && crawlerRef.current) {
            try {
                session?.retire();
            } catch {
                // Session may already be closing with the browser.
            }
            try {
                crawlerRef.current.browserPool.retireBrowserByPage(page);
            } catch (err) {
                logger.warn('Could not retire browser after proxy hop', { error: (err as Error).message });
            }
            await crawlerRef.current.addRequests([
                {
                    url: resumeUrl,
                    uniqueKey: `hop:${reason}:${Date.now()}:${resumeUrl}`,
                    userData: { label: 'CATEGORY' as const },
                },
            ]);
            abortCurrentHandler = true;
            logger.info('Enqueued resume URL on a new proxy session', { resumeUrl, reason });
            return;
        }
        logger.info('Cookies wiped; opening resume URL on the same browser (no proxy rotation)', { resumeUrl });
        await randomDelay(1_200, 3_000);
        await page.goto(resumeUrl, {
            waitUntil: 'load',
            timeout: config.navigationTimeoutSeconds * 1000,
        });
        rememberListUrl(page.url());
    };

    const recoverFromUnusualAccess = async (
        page: Page,
        session: PuppeteerCrawlingContext['session'],
    ): Promise<void> => {
        unusualAccessRecoveries += 1;
        if (unusualAccessRecoveries > UNUSUAL_ACCESS_MAX_RECOVERIES) {
            session?.markBad();
            throw crawlError(
                'RATE_LIMIT',
                `Unusual access persisted after ${UNUSUAL_ACCESS_MAX_RECOVERIES} cookie-wipe cooldowns`,
            );
        }
        await hopAfterCooldown(page, session, 'unusual-access', UNUSUAL_ACCESS_COOLDOWN_MS);
    };

    const unusualAccessOn = async (page: Page): Promise<boolean> => {
        if (isUnusualAccessUrl(page.url())) return true;
        if (await pageLooksReady(page)) return false;
        if ((await page.evaluate(unusualAccessVisible).catch(() => false)) === true) return true;
        const html = await page.content().catch(() => '');
        return isUnusualAccessHtml(html);
    };

    const settleAfterLoad = async (
        page: Page,
        session: PuppeteerCrawlingContext['session'],
        url: string,
        statusCode?: number,
    ): Promise<void> => {
        const html = await page.content().catch(() => '');
        const blockedStatus = statusCode !== undefined && BLOCKED_STATUSES.has(statusCode);
        let ready = await pageLooksReady(page);
        let visible = await visibleChallengeOn(page);

        while (await unusualAccessOn(page)) {
            if (deps.cancellation?.isCancelled) return;
            await recoverFromUnusualAccess(page, session);
            if (deps.cancellation?.isCancelled || abortCurrentHandler) return;
            ready = await pageLooksReady(page);
            visible = await visibleChallengeOn(page);
        }

        const htmlAfter = await page.content().catch(() => html);
        const htmlHint = isPxHoldChallenge(htmlAfter) || isChallengedPage(htmlAfter);

        // Real page is up and no overlay → leftover CF HTML / stale 403 is noise.
        if (ready && !visible) {
            if (statusCode !== undefined && statusCode >= 200 && statusCode < 300) session?.markGood();
            // fall through to tloading / login checks
        } else if (visible && !ready) {
            logger.warn(`Visible challenge on ${url} (status ${statusCode ?? 'n/a'})`);
            await saveDebugArtifacts(page, `${statusCode ?? 'nav'}-initial`);
            const kind = detectChallengeKind(htmlAfter);
            if (kind === 'unusual-access') {
                await recoverFromUnusualAccess(page, session);
                if (abortCurrentHandler) return;
                ready = await pageLooksReady(page);
                visible = await visibleChallengeOn(page);
            } else {
                emit('CHALLENGE_DETECTED', { kind, url, statusCode });
                const solved = await waitForHumanSolve(page, url, kind);
                if (!solved) {
                    session?.markBad();
                    throw crawlError(
                        'RATE_LIMIT',
                        `Blocked with status ${statusCode ?? 'n/a'} (${kind}) and no human resolution`,
                    );
                }
            }
        } else if ((blockedStatus || htmlHint || !ready) && !visible) {
            // 403 / leftover HTML / empty body, but no overlay. Wait up to 1 min
            // for the real page to paint, then continue if still no CF UI.
            logger.info(
                `No visible challenge (status ${statusCode ?? 'n/a'}) — waiting up to ${CHALLENGE_GRACE_MS / 1000}s for the page to settle.`,
                { url, blockedStatus, htmlHint, ready },
            );
            const graceDeadline = Date.now() + CHALLENGE_GRACE_MS;
            let handedToHuman = false;
            while (Date.now() < graceDeadline) {
                if (deps.cancellation?.isCancelled) return;
                await new Promise(resolve => setTimeout(resolve, CHALLENGE_GRACE_POLL_MS));
                if (await unusualAccessOn(page)) {
                    await recoverFromUnusualAccess(page, session);
                    if (abortCurrentHandler) return;
                    ready = await pageLooksReady(page);
                    visible = await visibleChallengeOn(page);
                    session?.markGood();
                    break;
                }
                ready = await pageLooksReady(page);
                visible = await visibleChallengeOn(page);
                if (ready && !visible) {
                    logger.info('Page settled with real content, continuing.', { url });
                    session?.markGood();
                    break;
                }
                if (visible && !ready) {
                    const kind = detectChallengeKind(await page.content().catch(() => htmlAfter));
                    if (kind === 'unusual-access') {
                        await recoverFromUnusualAccess(page, session);
                        if (abortCurrentHandler) return;
                        ready = await pageLooksReady(page);
                        visible = await visibleChallengeOn(page);
                        break;
                    }
                    emit('CHALLENGE_DETECTED', { kind, url, statusCode });
                    const solved = await waitForHumanSolve(page, url, kind);
                    if (!solved) {
                        session?.markBad();
                        throw crawlError(
                            'RATE_LIMIT',
                            `Blocked with status ${statusCode ?? 'n/a'} (${kind}) and no human resolution`,
                        );
                    }
                    handedToHuman = true;
                    break;
                }
            }
            if (!handedToHuman) {
                ready = await pageLooksReady(page);
                visible = await visibleChallengeOn(page);
                if (visible && !ready) {
                    const kind = detectChallengeKind(await page.content().catch(() => htmlAfter));
                    if (kind === 'unusual-access') {
                        await recoverFromUnusualAccess(page, session);
                        if (abortCurrentHandler) return;
                    } else {
                        emit('CHALLENGE_DETECTED', { kind, url, statusCode });
                        const solved = await waitForHumanSolve(page, url, kind);
                        if (!solved) {
                            session?.markBad();
                            throw crawlError(
                                'RATE_LIMIT',
                                `Blocked with status ${statusCode ?? 'n/a'} (${kind}) and no human resolution`,
                            );
                        }
                    }
                } else {
                    logger.info('Grace elapsed with no visible challenge — continuing.', { url, ready, visible });
                }
            }
        }

        if (abortCurrentHandler) return;

        if (page.url().includes('/cs/tloading')) {
            logger.info('Detected tloading protection page, waiting for JS redirect...');
            try {
                await page.waitForNavigation({ waitUntil: 'load', timeout: TLOADING_WAIT_MS });
                logger.info(`tloading resolved, now at: ${page.url()}`);
            } catch {
                session?.markBad();
                throw crawlError('TIMEOUT', 'tloading interstitial did not redirect within 30s');
            }
        }

        if (page.url().includes('/giris') || page.url().includes('secure.sahibinden.com')) {
            emit('CHALLENGE_DETECTED', { kind: 'login-wall', url: page.url() });
            const solved = await waitForHumanSolve(page, url, 'login-wall');
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
    };

    // Politeness MUST run before navigation. A delay inside requestHandler is
    // too late: Crawlee already fetched the page. With maxConcurrency>1 that
    // bursts N tabs at once and Cloudflare 403s. Chain waits so one goto
    // starts only after the previous slot's delay has elapsed.
    let navigationPace = Promise.resolve();
    const waitForPoliteNavigationSlot = (): Promise<void> => {
        const slot = navigationPace.then(() => randomDelay(config.delayMinMs, config.delayMaxMs));
        navigationPace = slot.then(
            () => undefined,
            () => undefined,
        );
        return slot;
    };

    const crawler = new PuppeteerCrawler({
        requestQueue,
        // null → undefined: Crawlee's option validation rejects explicit null.
        proxyConfiguration: proxyConfiguration ?? undefined,
        maxConcurrency: canRotateProxy ? 1 : config.maxConcurrency,
        // With details, every category page can spawn up to a pageful of
        // DETAIL requests: pages + items + slack. Proxy hops re-enqueue the
        // current list URL, so leave room for those extra CATEGORY requests.
        maxRequestsPerCrawl: config.includeDetails
            ? (config.maxPages ?? 100) +
              (config.maxItems ?? 1000) +
              50 +
              Math.ceil((config.maxItems ?? 1000) / PROXY_HOP_EVERY) +
              UNUSUAL_ACCESS_MAX_RECOVERIES
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
            // CDP attaches to one real Chrome profile — extra sessions just
            // open tabs until Target.createTarget fails (ADR-0006).
            maxPoolSize: config.browser.mode === 'cdp' ? 1 : (deps.sessionPolicy?.poolSize ?? 10),
            sessionOptions: { maxUsageCount: deps.sessionPolicy?.maxUsageCount ?? 50 },
        },

        browserPoolOptions: {
            // Crawlee defaults useFingerprints:true — fingerprint-generator
            // forges a UA / navigator that does not match this Chrome, which
            // Cloudflare scores as a bot. Keep the real browser identity.
            useFingerprints: false,
            // One tab at a time in CDP (a person is not opening 20 tabs).
            maxOpenPagesPerBrowser: config.browser.mode === 'cdp' || canRotateProxy ? 1 : 20,
            // CDP reconnect ("launch") after retirement kills the attach and
            // surfaces as Puppeteer's "Failed to launch browser". Keep the
            // same connection for the whole run.
            retireBrowserAfterPageCount: config.browser.mode === 'cdp' ? 10_000 : 20,
        },

        launchContext: {
            launcher: browserProvider.getLauncher(),
            launchOptions: browserProvider.getLaunchOptions(),
        },

        preNavigationHooks: [
            async ({ page, session, request }, gotoOptions) => {
                await waitForPoliteNavigationSlot();

                // Inject authorized user cookies ONCE per session. Re-injecting on
                // every request would overwrite the fresh cookies the browser earns
                // with the stale originals (upstream rationale, main.js:281-284).
                const alreadyInjected = session?.userData?.cookiesInjected === true;
                if (!alreadyInjected && !skipCookieReinject && sessionCookies.length > 0) {
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

                // CDP: never override the real window. Managed: a single
                // desktop viewport is enough — do not stamp 1920x1080 on
                // every navigation (that is a crawler tell).
                if (config.browser.mode !== 'cdp' && !session?.userData?.viewportSet) {
                    await page.setViewport({ width: 1920, height: 1080 });
                    if (session) session.userData = { ...session.userData, viewportSet: true };
                }

                if (gotoOptions) {
                    // `load` is what a normal Chrome navigation waits for.
                    // `networkidle2` is a scraper pattern and stalls on
                    // long-polling ads/analytics.
                    gotoOptions.waitUntil = 'load';
                    gotoOptions.timeout = config.navigationTimeoutSeconds * 1000;
                    // Native Puppeteer referer (not setExtraHTTPHeaders).
                    // Detail pages were discovered from a category URL —
                    // a person arrives via that link, not a typed address.
                    const listingData = request.userData?.listingData as CategoryListing | undefined;
                    const referer =
                        listingData?.sourceUrl ??
                        (typeof request.userData?.refererUrl === 'string' ? request.userData.refererUrl : undefined);
                    if (referer) gotoOptions.referer = referer;
                }
            },
        ],

        postNavigationHooks: [
            async ({ page, response, request, session }) => {
                const statusCode = response?.status();
                logger.info(`Response status: ${statusCode ?? 'unknown'} for ${request.url}`);
                await settleAfterLoad(page, session, request.url, statusCode);
            },
        ],

        requestHandler: async ctx => {
            // Cooperative cancellation between requests (category AND detail).
            if (deps.cancellation?.isCancelled) {
                await crawler.autoscaledPool?.abort();
                return;
            }

            try {
                // postNavigationHooks may have hopped already (dead page).
                // If the hop happened inside this handler, `finally` clears the
                // flag so the resume CATEGORY request is not skipped.
                if (abortCurrentHandler) return;

                // Explicit label routing — throws UNSUPPORTED_LABEL for anything
                // but 'CATEGORY'/'DETAIL'. A DETAIL request never reaches
                // category parsing logic and vice versa.
                const label = routeLabel(ctx.request.userData?.label);

                if (label === 'DETAIL') {
                    await handleDetailPage(ctx);
                } else {
                    await handleCategoryPage(ctx);
                }
            } finally {
                abortCurrentHandler = false;
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
    crawlerRef.current = crawler;

    const maybeBatchCooldown = async (url: string): Promise<void> => {
        if (canRotateProxy) return;
        if (detailsWritten === 0 || detailsWritten % DETAIL_BATCH_SIZE !== 0) return;
        const cooldown = humanPacing
            ? DETAIL_BATCH_COOLDOWN_MIN_MS
              + Math.floor(Math.random() * (DETAIL_BATCH_COOLDOWN_MAX_MS - DETAIL_BATCH_COOLDOWN_MIN_MS + 1))
            : config.delayMaxMs;
        emit('BATCH_COOLDOWN', {
            batch: Math.floor(detailsWritten / DETAIL_BATCH_SIZE),
            cooldownMs: cooldown,
            detailsWritten,
        });
        logger.info(
            `Batch cooldown after ${detailsWritten} details — pausing ${Math.round(cooldown / 1000)}s before next batch.`,
            { url, batch: Math.floor(detailsWritten / DETAIL_BATCH_SIZE) },
        );
        await new Promise(resolve => setTimeout(resolve, cooldown));
    };

    const ingestCurrentDetailPage = async (
        page: Page,
        url: string,
        listingData: CategoryListing | undefined,
        throwOnParserMiss: boolean,
        session: PuppeteerCrawlingContext['session'],
    ): Promise<void> => {
        const listingId = listingData?.id ?? extractListingId(url);
        emit('DETAIL_STARTED', { url, listingId });

        let readySelectorFound = true;
        try {
            await page.waitForSelector(DETAIL_READY_SELECTOR, { timeout: DETAIL_READY_WAIT_MS });
        } catch {
            readySelectorFound = false;
        }
        const html = await page.content().catch(() => '');
        if (isUnavailableDetailHtml(html)) {
            detailPagesVisited++;
            logger.info('Detail page unavailable (removed listing)', { url, listingId });
            emit('DETAIL_UNAVAILABLE', { url, listingId });
            return;
        }
        if (!readySelectorFound) {
            await saveDebugArtifacts(page, 'detail-ready-timeout');
            const err = crawlError(
                'PARSER_CHANGED',
                `Detail ready selector not found within ${DETAIL_READY_WAIT_MS}ms: ${url}`,
            );
            if (throwOnParserMiss) throw err;
            logger.warn(err.message, { url });
            errors.push({ code: 'PARSER_CHANGED', message: err.message, url });
            failedRequests++;
            return;
        }

        const raw = await page.evaluate(extractDetailRawInPage);
        let detail: ListingDetail;
        try {
            detail = normalizeDetail(raw, { url, category: listingData });
        } catch (err) {
            await saveDebugArtifacts(page, 'detail-normalize-failed');
            const wrapped = crawlError(
                'INVALID_PAGE',
                `normalizeDetail failed for ${url}: ${(err as Error).message}`,
                err,
            );
            if (throwOnParserMiss) throw wrapped;
            logger.warn(wrapped.message, { url });
            errors.push({ code: 'INVALID_PAGE', message: wrapped.message, url });
            failedRequests++;
            return;
        }

        await deps.output.upsertDetails([detail]);
        detailPagesVisited++;
        detailsWritten++;
        logger.info(`Parsed detail ${detail.listingId ?? url}. Total details: ${detailsWritten}`, { url });
        emit('DETAIL_PARSED', { url, listingId: detail.listingId, sellerType: detail.sellerType });
        await maybeBatchCooldown(url);
        if (canRotateProxy && shouldHopProxy(detailsWritten)) {
            await hopAfterCooldown(page, session, 'proxy-hop', proxyHopCooldownMs());
        }
    };

    const enqueueDetailBatch = async (batch: CategoryListing[]): Promise<void> => {
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
            logger.info(`Enqueued ${detailRequests.length} detail requests`);
        }
    };

    const visitDetailsByClick = async (
        page: Page,
        session: PuppeteerCrawlingContext['session'],
        batch: CategoryListing[],
        categoryUrl: string,
    ): Promise<void> => {
        const navTimeout = config.navigationTimeoutSeconds * 1000;
        for (const item of batch) {
            if (deps.cancellation?.isCancelled || abortCurrentHandler) return;
            const dedupKey = item.id ?? item.url;
            if (seenDetailKeys.has(dedupKey)) continue;
            try {
                assertAllowedDomain(item.url, config.allowedDomains);
            } catch {
                logger.warn('Skipping off-domain detail URL', { url: item.url });
                continue;
            }

            await waitForPoliteNavigationSlot();
            const link = await findListingTitleLink(page, item);
            if (!link) {
                logger.warn('Listing link not on page — falling back to queued navigation', { url: item.url });
                seenDetailKeys.add(dedupKey);
                await crawler.addRequests([{ url: item.url, userData: { label: 'DETAIL', listingData: item } }]);
                continue;
            }

            const before = page.url();
            let navigated = false;
            try {
                const pending = page.waitForNavigation({ waitUntil: 'load', timeout: navTimeout });
                await clickElementLikeHuman(page, link);
                await pending;
                navigated = true;
            } catch {
                navigated = page.url() !== before && page.url().includes('/ilan/');
            } finally {
                await link.dispose().catch(() => undefined);
            }

            if (!navigated) {
                logger.warn('Click did not open listing — falling back to queued navigation', { url: item.url });
                seenDetailKeys.add(dedupKey);
                await crawler.addRequests([{ url: item.url, userData: { label: 'DETAIL', listingData: item } }]);
                continue;
            }

            await settleAfterLoad(page, session, page.url());
            if (abortCurrentHandler) return;
            if (isUnusualAccessUrl(page.url())) {
                await recoverFromUnusualAccess(page, session);
                if (abortCurrentHandler) return;
                continue;
            }
            if (!isListingDetailUrl(page.url())) {
                logger.warn('Returned to list after challenge recovery — retrying this listing', { url: item.url });
                continue;
            }
            await lookAround(page, {
                delayMinMs: config.delayMinMs,
                delayMaxMs: config.delayMaxMs,
                kind: 'detail',
            });
            try {
                await ingestCurrentDetailPage(page, page.url(), item, false, session);
                seenDetailKeys.add(dedupKey);
            } catch (err) {
                seenDetailKeys.add(dedupKey);
                logger.warn('Detail parse failed after click; returning to list', {
                    url: item.url,
                    error: (err as Error).message,
                });
            }
            if (abortCurrentHandler) return;

            // Back is a person hitting the button, not a new "session" — don't
            // burn another full polite slot here (that doubled every listing).
            await randomDelay(350, 1_100);
            let back = await goBackLikeHuman(page, navTimeout);
            if (!back) {
                await page.goto(categoryUrl, { waitUntil: 'load', timeout: navTimeout, referer: page.url() });
            }
            await settleAfterLoad(page, session, page.url());
            if (abortCurrentHandler) return;
            try {
                await page.waitForSelector(CATEGORY_ROW_SELECTOR, { timeout: ROW_SELECTOR_WAIT_MS });
            } catch {
                await page.goto(categoryUrl, { waitUntil: 'load', timeout: navTimeout });
                await settleAfterLoad(page, session, page.url());
                if (abortCurrentHandler) return;
            }
            rememberListUrl(page.url() || categoryUrl);
            await lookAround(page, {
                delayMinMs: config.delayMinMs,
                delayMaxMs: config.delayMaxMs,
                kind: 'list-return',
            });
        }
    };

    const handleCategoryPage = async (ctx: PuppeteerCrawlingContext): Promise<void> => {
        const { page, request, enqueueLinks, session } = ctx;
        let categoryUrl = request.url;
        while (true) {
        if (abortCurrentHandler) return;
        rememberListUrl(page.url() || categoryUrl);
        emit('CATEGORY_STARTED', { url: categoryUrl });
        await lookAround(page, { delayMinMs: config.delayMinMs, delayMaxMs: config.delayMaxMs, kind: 'list' });

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
            logger.warn(`Primary selector failed: ${CATEGORY_ROW_SELECTOR}`, { url: categoryUrl });
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
                `No listing rows found on category page with any known selector: ${categoryUrl}`,
            );
        }

        // 2) Extract in-page → normalize node-side (13-field contract).
        const rawRows = await page.evaluate(extractCategoryRawInPage, rowSelector);
        const parsed = normalizeCategoryItems(rawRows, categoryUrl);
        if (parsed.length < rawRows.length) {
            logger.debug(`Skipped ${rawRows.length - parsed.length} rows missing title/url`, {
                url: categoryUrl,
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
            url: categoryUrl,
        });
        emit('CATEGORY_PARSED', { url: categoryUrl, itemCount: batch.length });
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

        // 5) Details: on live pacing, click the listing (same tab, real
        // referer / Sec-Fetch). Fixture tests keep the queued goto path.
        if (config.includeDetails && batch.length > 0) {
            if (humanPacing) {
                await visitDetailsByClick(page, session, batch, categoryUrl);
            } else {
                await enqueueDetailBatch(batch);
            }
            if (abortCurrentHandler) return;
        }

        // 6) Pagination: click "Sonraki" when living in the tab; otherwise enqueue.
        const itemsAllowMore = config.maxItems === null || itemsWritten < config.maxItems;
        const pagesAllowMore = config.maxPages === null || categoryPagesVisited < config.maxPages;
        if (itemsAllowMore && pagesAllowMore) {
            const nextHref = await page
                .$eval(NEXT_PAGE_SELECTOR, el => (el as HTMLAnchorElement).href)
                .catch(() => null);
            if (nextHref) {
                const absoluteNext = new URL(nextHref, page.url() || categoryUrl).toString();
                try {
                    assertAllowedDomain(absoluteNext, config.allowedDomains);
                    rememberListUrl(absoluteNext);
                    const nextEl = humanPacing ? await page.$(NEXT_PAGE_SELECTOR) : null;
                    if (nextEl) {
                        await waitForPoliteNavigationSlot();
                        try {
                            const pending = page.waitForNavigation({
                                waitUntil: 'load',
                                timeout: config.navigationTimeoutSeconds * 1000,
                            });
                            await clickElementLikeHuman(page, nextEl);
                            await pending;
                            await settleAfterLoad(page, session, page.url());
                            if (abortCurrentHandler) return;
                            categoryUrl = page.url();
                            rememberListUrl(categoryUrl);
                            logger.info(`Opened next category page by click: ${categoryUrl}`);
                            continue;
                        } catch {
                            await enqueueLinks({
                                urls: [absoluteNext],
                                userData: { label: 'CATEGORY', refererUrl: categoryUrl },
                            });
                            logger.info(`Enqueued next category page: ${absoluteNext}`);
                        } finally {
                            await nextEl.dispose().catch(() => undefined);
                        }
                    } else {
                        await enqueueLinks({
                            urls: [absoluteNext],
                            userData: { label: 'CATEGORY', refererUrl: categoryUrl },
                        });
                        logger.info(`Enqueued next category page: ${absoluteNext}`);
                    }
                } catch (err) {
                    if (err instanceof CrawlError) {
                        logger.warn('Skipping off-domain pagination URL', { url: absoluteNext });
                    } else {
                        throw err;
                    }
                }
            } else {
                logger.info(`No next page button found on ${categoryUrl}`);
            }
        }
        break;
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
        const { page, request, session } = ctx;
        const listingData = request.userData?.listingData as CategoryListing | undefined;
        if (abortCurrentHandler) return;
        if (!isListingDetailUrl(page.url())) {
            logger.warn('Detail handler did not land on a listing — skipping ingest', {
                url: request.url,
                landed: page.url(),
            });
            return;
        }
        await lookAround(page, {
            delayMinMs: config.delayMinMs,
            delayMaxMs: config.delayMaxMs,
            kind: 'detail',
        });
        await ingestCurrentDetailPage(page, request.url, listingData, true, session);
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
        const message = unwrapLaunchError(err);
        errors.push({ code, message });
        logger.error('Crawl run crashed', { code, message });
        result = buildResult(deps.cancellation?.isCancelled ? 'CANCELLED' : 'FAILED');
        emit('RUN_FAILED', { message, code });
    } finally {
        try {
            await requestQueue.drop();
        } catch (err) {
            logger.warn('Could not drop per-run request queue', { error: (err as Error).message });
        }
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

/** Crawlee wraps launcher.launch() failures in a generic Puppeteer message. */
function unwrapLaunchError(err: unknown): string {
    if (!(err instanceof Error)) return String(err);
    const cause = (err as Error & { cause?: unknown }).cause;
    if (err.message.includes('Failed to launch browser') && cause instanceof Error && cause.message.trim().length > 0) {
        return cause.message;
    }
    return err.message;
}
