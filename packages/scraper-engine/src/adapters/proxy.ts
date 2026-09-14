/**
 * Proxy providers. Replaces `Actor.createProxyConfiguration` — there is no
 * Apify proxy anymore; users supply conventional proxy URLs (or none).
 *
 * Credential hygiene: proxy URLs may embed user:pass. They are NEVER logged
 * in full — `redactProxyUrl` reduces them to protocol://host:port.
 */
import type { ProxyProvider, RuntimeLogger } from '@sahibindenbot/shared';

/** protocol://[user:pass@]host:port — port is mandatory. */
const PROXY_URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/@\s]+:[^/@\s]+@)?[^/:@\s]+:\d+\/?$/;

/** protocol://host:port — credentials stripped. Safe for logs. */
export function redactProxyUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}`;
    } catch {
        return '<malformed proxy URL>';
    }
}

/** Static list of conventional proxy URLs; empty list = direct connection. */
export class StaticProxyProvider implements ProxyProvider {
    constructor(
        private readonly urls: string[],
        private readonly logger?: RuntimeLogger,
    ) {
        urls.forEach((url, i) => {
            if (!PROXY_URL_PATTERN.test(url)) {
                throw new Error(
                    `Malformed proxy URL at index ${i} (expected protocol://[user:pass@]host:port): ${redactProxyUrl(url)}`,
                );
            }
        });
    }

    async getProxyConfiguration(): Promise<unknown | null> {
        if (this.urls.length === 0) return null;
        this.logger?.info('Using static proxy list', { proxies: this.urls.map(redactProxyUrl) });
        const { ProxyConfiguration } = await import('crawlee');
        return new ProxyConfiguration({ proxyUrls: this.urls });
    }
}

/** Always direct — explicit no-proxy choice. */
export class NullProxyProvider implements ProxyProvider {
    constructor(private readonly logger?: RuntimeLogger) {}

    async getProxyConfiguration(): Promise<null> {
        this.logger?.warn('No proxy configured — crawling direct.');
        return null;
    }
}
