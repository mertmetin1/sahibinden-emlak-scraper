/**
 * Hermetic tests for ProxyHealthChecker — no external network.
 *
 * Happy path uses a LOCAL absolute-URI forward proxy (node:http) on
 * 127.0.0.1 forwarding to a local origin, per the phase spec. Failure modes
 * (refused / 407 / silent-timeout / CONNECT-407 / socks) are all simulated
 * with local servers. classifyProxyError is tested as a pure function.
 */
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyProxyError, ProxyHealthChecker } from './proxy-health.js';
import type { ProxyEndpointInput } from './proxy.js';

// --- local server registry (guaranteed cleanup, no dangling sockets) --------
const running: Array<{ server: http.Server | net.Server; sockets: Set<net.Socket> }> = [];

function register<T extends http.Server | net.Server>(server: T): T {
    const sockets = new Set<net.Socket>();
    server.on('connection', s => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
    });
    running.push({ server, sockets });
    return server;
}

afterEach(async () => {
    const all = running.splice(0);
    for (const { sockets } of all) for (const s of sockets) s.destroy();
    await Promise.all(all.map(({ server }) => new Promise<void>(res => server.close(() => res()))));
});

async function listen(server: http.Server | net.Server): Promise<number> {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return (server.address() as AddressInfo).port;
}

/** Minimal CONNECT-less absolute-URL forward proxy for http:// targets. */
async function startForwardProxy(onRequest?: (req: http.IncomingMessage) => void): Promise<number> {
    const server = register(
        http.createServer((req, res) => {
            onRequest?.(req);
            let target: URL;
            try {
                target = new URL(req.url ?? '');
            } catch {
                res.writeHead(400);
                res.end();
                return;
            }
            const proxyReq = http.request(
                {
                    host: target.hostname,
                    port: target.port,
                    path: `${target.pathname}${target.search}`,
                    method: req.method,
                    headers: { Host: target.host },
                },
                proxyRes => {
                    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
                    proxyRes.pipe(res);
                },
            );
            proxyReq.on('error', () => {
                if (!res.headersSent) res.writeHead(502);
                res.end();
            });
            req.pipe(proxyReq);
        }),
    );
    return listen(server);
}

async function startOrigin(): Promise<number> {
    const server = register(
        http.createServer((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        }),
    );
    return listen(server);
}

/** Accepts TCP and never says a word (drives the deadline path). */
async function startSilentServer(): Promise<number> {
    const server = register(net.createServer(() => {}));
    return listen(server);
}

/** A port nothing listens on (listen → grab port → close). */
async function closedPort(): Promise<number> {
    const server = net.createServer();
    const port = await listen(server);
    server.close();
    await once(server, 'close');
    return port;
}

function endpoint(port: number, overrides: Partial<ProxyEndpointInput> = {}): ProxyEndpointInput {
    return { host: '127.0.0.1', port, protocol: 'http', username: null, password: null, ...overrides };
}

describe('classifyProxyError', () => {
    it('maps error codes to kinds', () => {
        const cases: Array<[unknown, string]> = [
            [{ code: 'ECONNREFUSED' }, 'connect-refused'],
            [{ code: 'ENOTFOUND' }, 'dns'],
            [{ code: 'EAI_AGAIN' }, 'dns'],
            [{ code: 'ETIMEDOUT' }, 'timeout'],
            [{ code: 'PROXY_CHECK_TIMEOUT' }, 'timeout'],
            [{ code: 'PROXY_AUTH' }, 'auth'],
            [{ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, 'tls'],
            [{ code: 'CERT_HAS_EXPIRED' }, 'tls'],
            [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'tls'],
            [{ code: 'EPROTO' }, 'tls'],
            [{ code: 'UNSUPPORTED_PROTOCOL' }, 'unsupported-protocol'],
            [{ code: 'ECONNRESET' }, 'other'],
            [new Error('socket hang up'), 'other'],
            ['garbage', 'other'],
            [undefined, 'other'],
            [null, 'other'],
        ];
        for (const [err, kind] of cases) {
            expect(classifyProxyError(err), JSON.stringify(err)).toBe(kind);
        }
    });

    it('falls back to message text when no code is present', () => {
        expect(classifyProxyError(new Error('connect ETIMEDOUT 1.2.3.4:8080'))).toBe('timeout');
        expect(classifyProxyError(new Error('request timed out after 10000ms'))).toBe('timeout');
        expect(classifyProxyError(new Error('407 Proxy Authentication Required'))).toBe('auth');
        expect(classifyProxyError(new Error('getaddrinfo ENOTFOUND proxy.local'))).toBe('dns');
        expect(classifyProxyError(new Error('write EPROTO ... ssl3_get_record:wrong version number'))).toBe('tls');
        expect(classifyProxyError(new Error('certificate has expired'))).toBe('tls');
    });
});

describe('ProxyHealthChecker.checkEndpoint', () => {
    it('routes an http:// target through a local forward proxy (happy path)', async () => {
        const originPort = await startOrigin();
        const proxyPort = await startForwardProxy();
        const checker = new ProxyHealthChecker();

        const result = await checker.checkEndpoint(endpoint(proxyPort), {
            targetUrl: `http://127.0.0.1:${originPort}/echo?format=json`,
        });

        expect(result.ok).toBe(true);
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        expect(result.error).toBeUndefined();
    });

    it('sends Proxy-Authorization when credentials are set', async () => {
        const originPort = await startOrigin();
        let seenAuth: string | undefined;
        const proxyPort = await startForwardProxy(req => {
            seenAuth = req.headers['proxy-authorization'];
        });
        const checker = new ProxyHealthChecker();

        const result = await checker.checkEndpoint(
            endpoint(proxyPort, { username: 'alice', password: 's3cret' }),
            { targetUrl: `http://127.0.0.1:${originPort}/` },
        );

        expect(result.ok).toBe(true);
        expect(seenAuth).toBe(`Basic ${Buffer.from('alice:s3cret', 'utf8').toString('base64')}`);
    });

    it('classifies a dead endpoint as connect-refused', async () => {
        const checker = new ProxyHealthChecker();
        const result = await checker.checkEndpoint(endpoint(await closedPort()), {
            targetUrl: 'http://127.0.0.1:1/',
        });
        expect(result.ok).toBe(false);
        expect(result.latencyMs).toBeNull();
        expect(result.error).toBe('connect-refused');
    });

    it('classifies a 407 forward response as auth', async () => {
        const proxyPort = await listen(
            register(
                http.createServer((_req, res) => {
                    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="test"' });
                    res.end();
                }),
            ),
        );
        const checker = new ProxyHealthChecker();
        const result = await checker.checkEndpoint(endpoint(proxyPort), { targetUrl: 'http://127.0.0.1:1/' });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('auth');
    });

    it('classifies a silent proxy as timeout', async () => {
        const silentPort = await startSilentServer();
        const checker = new ProxyHealthChecker();
        const result = await checker.checkEndpoint(endpoint(silentPort), {
            targetUrl: 'http://127.0.0.1:1/',
            timeoutMs: 300,
        });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('timeout');
    });

    it('classifies socks endpoints as unsupported-protocol without touching the network', async () => {
        const checker = new ProxyHealthChecker();
        // Port 1: if the checker DID attempt a connection it would be refused,
        // so 'unsupported-protocol' proves it returned before any I/O.
        const result = await checker.checkEndpoint(endpoint(1, { protocol: 'socks5' }), { timeoutMs: 300 });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('unsupported-protocol');
    });

    it('classifies a CONNECT 407 (https target path) as auth', async () => {
        // Raw TCP proxy that answers every CONNECT with 407 — exercises the
        // CONNECT tunnel code path without any external network.
        const proxyPort = await listen(
            register(
                net.createServer(socket => {
                    let buf = '';
                    socket.on('data', chunk => {
                        buf += chunk.toString('latin1');
                        if (buf.includes('\r\n\r\n')) {
                            socket.end(
                                'HTTP/1.1 407 Proxy Authentication Required\r\n' +
                                    'Proxy-Authenticate: Basic realm="test"\r\n\r\n',
                            );
                        }
                    });
                }),
            ),
        );
        const checker = new ProxyHealthChecker();
        const result = await checker.checkEndpoint(endpoint(proxyPort), {
            targetUrl: 'https://example.invalid/',
            timeoutMs: 2000,
        });
        expect(result.ok).toBe(false);
        expect(result.error).toBe('auth');
    });
});

describe('ProxyHealthChecker.checkProfile', () => {
    it('returns per-endpoint results in input order', async () => {
        const originPort = await startOrigin();
        const proxyPort = await startForwardProxy();
        const dead = await closedPort();
        const checker = new ProxyHealthChecker();

        const endpoints = [
            endpoint(proxyPort),
            endpoint(dead),
            endpoint(1, { protocol: 'socks5' }),
        ];
        const results = await checker.checkProfile(endpoints, 2, {
            targetUrl: `http://127.0.0.1:${originPort}/`,
            timeoutMs: 2000,
        });

        expect(results).toHaveLength(3);
        expect(results[0]?.ok).toBe(true);
        expect(results[1]).toMatchObject({ ok: false, error: 'connect-refused' });
        expect(results[2]).toMatchObject({ ok: false, error: 'unsupported-protocol' });
    });

    it('bounds concurrency', async () => {
        // Four silent endpoints, each held until the 250ms deadline: with a
        // concurrency cap of 2 the wall-clock time must be >= 2 rounds.
        const ports = await Promise.all([startSilentServer(), startSilentServer(), startSilentServer(), startSilentServer()]);

        class CountingChecker extends ProxyHealthChecker {
            active = 0;
            maxActive = 0;
            override async checkEndpoint(ep: ProxyEndpointInput, opts = {}) {
                this.active++;
                this.maxActive = Math.max(this.maxActive, this.active);
                try {
                    return await super.checkEndpoint(ep, opts);
                } finally {
                    this.active--;
                }
            }
        }
        const checker = new CountingChecker();
        const started = Date.now();
        const results = await checker.checkProfile(ports.map(p => endpoint(p)), 2, {
            targetUrl: 'http://127.0.0.1:1/',
            timeoutMs: 250,
        });

        expect(results).toHaveLength(4);
        expect(results.every(r => r.error === 'timeout')).toBe(true);
        expect(checker.maxActive).toBe(2);
        expect(Date.now() - started).toBeGreaterThanOrEqual(450); // ~2 x 250ms rounds
    });
});
