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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
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

                // Resilience: if Chrome is briefly down (user closed the debug
                // window, or it crashed), retry the connect for up to ~3 min
                // instead of failing the run in 560ms. The user can reopen
                // Chrome and the bot picks up. This is pacing, not anti-bot.
                const deadline = Date.now() + 180_000;
                const pollMs = 5_000;
                let browser: Browser | null = null;
                let lastErr: unknown = null;
                let attempt = 0;
                while (Date.now() < deadline) {
                    attempt++;
                    try {
                        browser = await puppeteer.connect({
                            browserURL: cdpUrl,
                            defaultViewport: null, // keep the real window's viewport
                        });
                        break;
                    } catch (err) {
                        lastErr = err;
                        const cause = err instanceof Error ? err.message : String(err);
                        logger.warn(
                            `CDP Chrome'a bağlanılamadı (deneme ${attempt}) — ${pollMs / 1000}s sonra tekrar denenecek.`,
                            { cdpUrl, cause },
                        );
                        if (attempt === 1) {
                            tryLaunchDebugChrome(cdpUrl, logger);
                        }
                        await new Promise(resolve => setTimeout(resolve, pollMs));
                    }
                }
                if (browser === null) {
                    const cause = lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'unknown');
                    throw new Error(
                        `[NETWORK] CDP Chrome'a bağlanılamadı (${cdpUrl}) — 3 dk denendi. ` +
                            `Chrome'u --remote-debugging-port=9222 ve ayrı profil klasörüyle açıp taramayı tekrar çalıştırın. ${cause}`,
                    );
                }

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

function debugProfileDir(): string {
    if (process.env.CHROME_USER_DATA_DIR && process.env.CHROME_USER_DATA_DIR.length > 0) {
        return process.env.CHROME_USER_DATA_DIR;
    }
    const fromCwd = path.resolve(process.cwd(), '.chrome-debug-profile');
    const fromWorker = path.resolve(process.cwd(), '..', '..', '.chrome-debug-profile');
    return existsSync(fromWorker) || existsSync(path.dirname(fromWorker)) ? fromWorker : fromCwd;
}

function chromeExecutable(): string | undefined {
    try {
        const execPath = puppeteer.executablePath('chrome');
        if (typeof execPath === 'string' && execPath.length > 0 && existsSync(execPath)) return execPath;
    } catch {
        // no system Chrome via puppeteer
    }
    const candidates = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    return candidates.find((p) => existsSync(p));
}

function portFromCdpUrl(cdpUrl: string): string {
    try {
        return new URL(cdpUrl).port || '9222';
    } catch {
        return '9222';
    }
}

/** Spawn the dedicated debug Chrome once; connect retries pick it up. */
function tryLaunchDebugChrome(cdpUrl: string, logger: RuntimeLogger): void {
    const exe = chromeExecutable();
    if (!exe) {
        logger.warn('Debug Chrome executable not found — cannot auto-open CDP browser');
        return;
    }
    const profile = debugProfileDir();
    const port = portFromCdpUrl(cdpUrl);
    logger.info('Opening dedicated debug Chrome for CDP', { exe, profile, port });
    try {
        const child = spawn(
            exe,
            [
                `--remote-debugging-port=${port}`,
                `--user-data-dir=${profile}`,
                '--no-first-run',
                '--no-default-browser-check',
                'about:blank',
            ],
            { detached: true, stdio: 'ignore', windowsHide: false },
        );
        child.unref();
    } catch (err) {
        logger.warn('Failed to spawn debug Chrome', { error: (err as Error).message });
    }
}
