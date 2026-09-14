/**
 * ProxyHealthChecker — connectivity/routing health for proxy endpoints.
 *
 * Scope rule (project policy): checks run ONLY against a benign echo target
 * (default https://api.ipify.org?format=json), NEVER against the crawl
 * target site. Health = "does this endpoint carry an HTTP request to
 * completion", not "is this endpoint unblocked on sahibinden.com".
 *
 * Transports:
 * - http proxy + http target: absolute-URI forward GET (node:http).
 * - http(s) proxy + https target: CONNECT tunnel, then TLS to the target
 *   (node:net + node:tls). https proxies (TLS to the proxy itself) are
 *   supported by wrapping the proxy connection in TLS first.
 * - socks4/socks5: NOT supported — no socks client exists in this package's
 *   declared dependency set (pnpm isolates transitive deps), so adding one
 *   would be a new dependency decision. Returns ok:false /
 *   'unsupported-protocol' (documented, deliberate).
 *
 * Any HTTP response status through the proxy counts as routing success —
 * except 407 Proxy Authentication Required, which classifies as 'auth'.
 * TLS handshake failures classify as 'tls' (they still prove CONNECT
 * routing worked, but the check is strict: ok:false).
 *
 * Credential hygiene: endpoints are logged via describeEndpoint()
 * (protocol://host:port) — username/password NEVER appear in logs.
 */
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { performance } from 'node:perf_hooks';
import type { RuntimeLogger } from '@sahibindenbot/shared';
import { describeEndpoint, normalizeProxyProtocol, type ProxyEndpointInput } from './proxy.js';

export type ProxyCheckErrorKind =
    | 'timeout'
    | 'connect-refused'
    | 'auth'
    | 'dns'
    | 'tls'
    | 'unsupported-protocol'
    | 'other';

export interface ProxyCheckResult {
    ok: boolean;
    /** Round-trip of the whole check; null when the check failed. */
    latencyMs: number | null;
    error?: ProxyCheckErrorKind;
}

export interface CheckEndpointOptions {
    /** Benign echo endpoint. Default https://api.ipify.org?format=json */
    targetUrl?: string;
    /** Whole-check deadline. Default 10_000. */
    timeoutMs?: number;
}

const DEFAULT_TARGET_URL = 'https://api.ipify.org?format=json';
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = 'sahibindenbot-proxy-health/1.0';

/** Internal error carrying a machine-classifiable `code`. */
class ProxyCheckError extends Error {
    constructor(
        public readonly code: string,
        message: string,
    ) {
        super(message);
        this.name = 'ProxyCheckError';
    }
}

const TLS_ERROR_CODES = new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'ERR_TLS_CERT_ALTNAME_INVALID',
    'EPROTO',
]);

/** Pure error → kind mapping. Never throws; unknown shapes → 'other'. */
export function classifyProxyError(err: unknown): ProxyCheckErrorKind {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (typeof code === 'string') {
        if (code === 'PROXY_CHECK_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout';
        if (code === 'ECONNREFUSED') return 'connect-refused';
        if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
        if (code === 'PROXY_AUTH') return 'auth';
        if (code === 'UNSUPPORTED_PROTOCOL') return 'unsupported-protocol';
        if (TLS_ERROR_CODES.has(code)) return 'tls';
    }
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (msg.includes('timed out') || msg.includes('timeout') || msg.includes('etimedout')) return 'timeout';
    if (msg.includes('econnrefused') || msg.includes('connection refused')) return 'connect-refused';
    if (msg.includes('enotfound') || msg.includes('eai_again') || msg.includes('getaddrinfo')) return 'dns';
    if (msg.includes('407') || msg.includes('proxy authentication')) return 'auth';
    if (msg.includes('unsupported protocol') || msg.includes('unsupported-protocol')) return 'unsupported-protocol';
    if (msg.includes('tls') || msg.includes('ssl') || msg.includes('certificate') || msg.includes('eproto')) {
        return 'tls';
    }
    return 'other';
}

function proxyAuthHeader(endpoint: ProxyEndpointInput): string | null {
    if (endpoint.username === null || endpoint.username === '') return null;
    const raw = `${endpoint.username}:${endpoint.password ?? ''}`;
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/** Parses the status code from an accumulated HTTP response head. */
function statusFromHead(head: string): number | null {
    const lineEnd = head.indexOf('\r\n');
    if (lineEnd === -1) return null;
    const status = Number(head.slice(0, lineEnd).split(/\s+/)[1]);
    return Number.isNaN(status) ? null : status;
}

/**
 * http:// target through an http(s) proxy: absolute-URI forward GET.
 * Resolves on ANY response status (routing proven) except 407 → 'auth'.
 */
function httpForwardGet(endpoint: ProxyEndpointInput, target: URL, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const headers: Record<string, string> = {
            Host: target.host,
            'User-Agent': USER_AGENT,
            Accept: '*/*',
            Connection: 'close',
        };
        const auth = proxyAuthHeader(endpoint);
        if (auth) headers['Proxy-Authorization'] = auth;

        const req = http.request({
            host: endpoint.host,
            port: endpoint.port,
            method: 'GET',
            // Forward-proxy request form: absolute URI as the request target.
            path: target.toString(),
            headers,
        });
        const timer = setTimeout(() => {
            req.destroy(new ProxyCheckError('PROXY_CHECK_TIMEOUT', `proxy did not respond within ${timeoutMs}ms`));
        }, timeoutMs);

        req.on('response', res => {
            res.resume(); // drain so the socket can close
            clearTimeout(timer);
            if (res.statusCode === 407) {
                reject(new ProxyCheckError('PROXY_AUTH', 'proxy responded 407 Proxy Authentication Required'));
                return;
            }
            resolve();
        });
        req.on('error', err => {
            clearTimeout(timer);
            reject(err);
        });
        req.end();
    });
}

/**
 * https:// target through an http(s) proxy: CONNECT tunnel, then TLS to the
 * target inside the tunnel, then a plain GET. Resolves on any HTTP status
 * from the target; 407 (at either stage) → 'auth'; TLS failure rejects with
 * the original tls error (classified 'tls' by classifyProxyError).
 */
function httpsConnectGet(endpoint: ProxyEndpointInput, target: URL, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let proxySocket: net.Socket | null = null;
        let tunnel: tls.TLSSocket | null = null;
        const cleanup = (): void => {
            clearTimeout(timer);
            proxySocket?.destroy();
            tunnel?.destroy();
        };
        const fail = (err: Error): void => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err);
        };
        const done = (): void => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };
        const timer = setTimeout(
            () => fail(new ProxyCheckError('PROXY_CHECK_TIMEOUT', `check timed out after ${timeoutMs}ms`)),
            timeoutMs,
        );

        const targetPort = target.port === '' ? 443 : Number(target.port);
        const onProxyConnect = (): void => {
            const lines = [
                `CONNECT ${target.hostname}:${targetPort} HTTP/1.1`,
                `Host: ${target.hostname}:${targetPort}`,
                `User-Agent: ${USER_AGENT}`,
            ];
            const auth = proxyAuthHeader(endpoint);
            if (auth) lines.push(`Proxy-Authorization: ${auth}`);
            proxySocket?.write(`${lines.join('\r\n')}\r\n\r\n`);
        };

        // http proxy: plain TCP. https proxy: TLS to the proxy first.
        if (normalizeProxyProtocol(endpoint.protocol) === 'https') {
            const s = tls.connect({ host: endpoint.host, port: endpoint.port, servername: endpoint.host });
            proxySocket = s;
            s.once('secureConnect', onProxyConnect);
        } else {
            const s = net.connect({ host: endpoint.host, port: endpoint.port });
            proxySocket = s;
            s.once('connect', onProxyConnect);
        }
        proxySocket.once('error', fail);

        let connectHead = '';
        const onConnectData = (chunk: Buffer): void => {
            connectHead += chunk.toString('latin1');
            if (!connectHead.includes('\r\n\r\n')) return;
            proxySocket?.removeListener('data', onConnectData);
            const status = statusFromHead(connectHead);
            if (status === 407) {
                fail(new ProxyCheckError('PROXY_AUTH', 'proxy CONNECT responded 407 Proxy Authentication Required'));
                return;
            }
            if (status !== 200) {
                fail(new ProxyCheckError('PROXY_CONNECT_STATUS', `proxy CONNECT responded ${status ?? 'unparseable head'}`));
                return;
            }
            startTunnel();
        };
        proxySocket.on('data', onConnectData);

        const startTunnel = (): void => {
            if (!proxySocket) return fail(new ProxyCheckError('PROXY_CONNECT_STATUS', 'proxy socket lost'));
            tunnel = tls.connect({ socket: proxySocket, servername: target.hostname });
            tunnel.once('error', fail);
            tunnel.once('secureConnect', () => {
                tunnel?.write(
                    `GET ${target.pathname}${target.search} HTTP/1.1\r\n` +
                        `Host: ${target.host}\r\nUser-Agent: ${USER_AGENT}\r\nAccept: */*\r\nConnection: close\r\n\r\n`,
                );
            });
            let resHead = '';
            tunnel.on('data', (chunk: Buffer) => {
                resHead += chunk.toString('latin1');
                const status = statusFromHead(resHead);
                if (status === null) return; // status line not complete yet
                if (status === 407) {
                    fail(new ProxyCheckError('PROXY_AUTH', 'received 407 inside tunnel'));
                    return;
                }
                done();
            });
        };
    });
}

/**
 * Health-checks proxy endpoints against a benign echo target.
 * DB-agnostic: consumes plain ProxyEndpointInput, returns plain results;
 * persistence of health (ProxyEndpoint.health, latency, quarantine) is the
 * worker layer's job.
 */
export class ProxyHealthChecker {
    constructor(private readonly logger?: RuntimeLogger) {}

    /** Checks one endpoint. Never throws — failures are reported in the result. */
    async checkEndpoint(endpoint: ProxyEndpointInput, opts: CheckEndpointOptions = {}): Promise<ProxyCheckResult> {
        const targetUrl = opts.targetUrl ?? DEFAULT_TARGET_URL;
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const started = performance.now();
        try {
            await this.routeGet(endpoint, targetUrl, timeoutMs);
            return { ok: true, latencyMs: Math.round(performance.now() - started) };
        } catch (err) {
            const error = classifyProxyError(err);
            this.logger?.warn('Proxy health check failed', {
                endpoint: describeEndpoint(endpoint), // redacted — credentials never logged
                error,
                message: (err as Error).message,
            });
            return { ok: false, latencyMs: null, error };
        }
    }

    /**
     * Checks many endpoints with bounded concurrency.
     * Results are returned in INPUT order (results[i] ↔ endpoints[i]).
     */
    async checkProfile(
        endpoints: ProxyEndpointInput[],
        concurrency = 5,
        opts: CheckEndpointOptions = {},
    ): Promise<ProxyCheckResult[]> {
        const results: ProxyCheckResult[] = new Array(endpoints.length);
        let nextIndex = 0;
        const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, endpoints.length));
        const workers = Array.from({ length: workerCount }, async () => {
            while (nextIndex < endpoints.length) {
                const i = nextIndex++;
                const endpoint = endpoints[i];
                if (endpoint) results[i] = await this.checkEndpoint(endpoint, opts);
            }
        });
        await Promise.all(workers);
        return results;
    }

    private async routeGet(endpoint: ProxyEndpointInput, targetUrl: string, timeoutMs: number): Promise<void> {
        const protocol = normalizeProxyProtocol(endpoint.protocol);
        if (protocol === 'socks4' || protocol === 'socks5') {
            throw new ProxyCheckError(
                'UNSUPPORTED_PROTOCOL',
                `socks health checks unsupported (no socks client in the dependency set): ${describeEndpoint(endpoint)}`,
            );
        }
        let target: URL;
        try {
            target = new URL(targetUrl);
        } catch {
            throw new ProxyCheckError('BAD_TARGET', `malformed health-check target URL: ${targetUrl}`);
        }
        if (target.protocol === 'http:') return httpForwardGet(endpoint, target, timeoutMs);
        if (target.protocol === 'https:') return httpsConnectGet(endpoint, target, timeoutMs);
        throw new ProxyCheckError('BAD_TARGET', `unsupported health-check target protocol: ${target.protocol}`);
    }
}
