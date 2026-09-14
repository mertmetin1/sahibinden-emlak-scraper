/**
 * Browser acquisition strategies.
 *
 * INTENTIONALLY REMOVED per ADR-0002 (legal boundary) — do not reintroduce:
 * - puppeteer-extra + puppeteer-extra-plugin-stealth;
 * - the evaluateOnNewDocument fingerprint-override block (navigator.webdriver,
 *   window.chrome, permissions, languages/platform/hardwareConcurrency,
 *   screen geometry, PluginArray, WebGL vendor/renderer spoofing);
 * - anti-automation launch flags (`--disable-blink-features=AutomationControlled`,
 *   `ignoreDefaultArgs: ['--enable-automation']`);
 * - UA rotation / sec-ch-ua / Sec-Fetch header forging.
 *
 * Rationale: the CDP experiment (docs/UPSTREAM_AUDIT.md §16) proved that
 * attaching to the user's real Chrome sidesteps the entire anti-bot arms race
 * (1008 listings, zero challenges). Managed mode stays plain and relies on
 * human-in-the-loop when a challenge appears.
 */
import { existsSync } from 'node:fs';
import puppeteer, { type Browser, type LaunchOptions } from 'puppeteer';
import type { BrowserConfig, RuntimeLogger } from '@sahibindenbot/shared';

/**
 * Returns something Crawlee's `launchContext.launcher` accepts
 * (typed `unknown` there — see PuppeteerLaunchContext.launcher).
 */
export interface BrowserProvider {
    getLauncher(): unknown;
}

/**
 * Managed mode: Crawlee launches a plain puppeteer browser.
 * Prefers the installed Google Chrome (channel 'chrome') when available,
 * falls back to the bundled Chromium.
 */
export class ManagedBrowserProvider implements BrowserProvider {
    constructor(
        private readonly config: BrowserConfig,
        private readonly logger: RuntimeLogger,
    ) {}

    getLauncher(): unknown {
        // Plain `puppeteer` module — NOT puppeteer-extra, no stealth plugin.
        return puppeteer;
    }

    getLaunchOptions(): LaunchOptions {
        const channel = this.resolveChromeChannel();
        if (channel) {
            this.logger.info('Managed browser: using installed Google Chrome (channel "chrome")');
        } else {
            this.logger.info('Managed browser: system Chrome not found, using bundled Chromium');
        }
        return {
            headless: this.config.headless ?? true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--window-size=1920,1080',
            ],
            ...(channel ? { channel } : {}),
        };
    }

    /** 'chrome' when a system Chrome is resolvable, else undefined (bundled). */
    private resolveChromeChannel(): 'chrome' | undefined {
        try {
            const execPath = puppeteer.executablePath('chrome');
            if (typeof execPath === 'string' && execPath.length > 0 && existsSync(execPath)) {
                return 'chrome';
            }
        } catch {
            // puppeteer throws when no system Chrome is installed — fall through.
        }
        return undefined;
    }
}

/**
 * CDP mode: attaches to the user's already-running Chrome
 * (started with e.g. `--remote-debugging-port=9222`).
 */
export class CdpBrowserProvider implements BrowserProvider {
    constructor(
        private readonly config: BrowserConfig,
        private readonly logger: RuntimeLogger,
    ) {}

    getLauncher(): unknown {
        const cdpUrl = this.config.cdpUrl;
        if (!cdpUrl) {
            // Config validation normally guarantees this; defend anyway.
            throw new Error('CdpBrowserProvider requires browser.cdpUrl (e.g. http://127.0.0.1:9222)');
        }
        const logger = this.logger;

        // Launcher adapter: Crawlee's BrowserLauncher hands this object to
        // PuppeteerPlugin, which calls `launcher.launch(launchOptions)`. We ignore
        // launchOptions entirely and CONNECT instead of launching.
        return {
            launch: async (): Promise<Browser> => {
                logger.info('Connecting to user Chrome via CDP', { cdpUrl });
                const browser = await puppeteer.connect({
                    browserURL: cdpUrl,
                    defaultViewport: null, // keep the real window's viewport
                });

                // Crawlee retires browsers (browserPoolOptions.retireBrowserAfterPageCount)
                // and calls browser.close() — on a CDP-attached browser that would KILL the
                // user's real Chrome. Override close() to only disconnect. Assigned before
                // returning so PuppeteerPlugin's boundMethods capture the override.
                // `newPage()` and everything else pass through untouched.
                browser.close = async (): Promise<void> => {
                    await browser.disconnect();
                };

                return browser;
            },
        };
    }

    /** Connect args live inside the launcher adapter; nothing to pass through. */
    getLaunchOptions(): LaunchOptions {
        return {};
    }
}

/** Picks the provider for the configured browser mode. */
export function createBrowserProvider(
    config: BrowserConfig,
    logger: RuntimeLogger,
): ManagedBrowserProvider | CdpBrowserProvider {
    return config.mode === 'cdp'
        ? new CdpBrowserProvider(config, logger)
        : new ManagedBrowserProvider(config, logger);
}
