/**
 * Pure unit tests for the profile repositories' DB-free logic:
 * - parseProxyEndpointLine / parseProxyImportText (conventional bulk formats)
 * - maskProxyImportLine (credentials never echoed in failure records)
 * - applyHealthSuccess / applyHealthFailure (status transition matrix +
 *   quarantine timing)
 *
 * No database involved — these exercise the exported pure functions only.
 */
import { describe, expect, it } from 'vitest';
import {
    applyHealthFailure,
    applyHealthSuccess,
    maskProxyImportLine,
    parseProxyEndpointLine,
    parseProxyImportText,
    PROXY_DEGRADED_THRESHOLD,
    PROXY_QUARANTINE_MS,
    PROXY_UNHEALTHY_THRESHOLD,
    type EndpointHealthState,
} from '../prisma-proxy-profile-repository.js';

const NOW = new Date('2026-09-14T12:00:00Z');

function state(overrides: Partial<EndpointHealthState> = {}): EndpointHealthState {
    return { healthStatus: 'UNKNOWN', consecutiveFailures: 0, latencyMs: null, quarantinedUntil: null, ...overrides };
}

// ---------------------------------------------------------------------------
// parseProxyEndpointLine
// ---------------------------------------------------------------------------

describe('parseProxyEndpointLine', () => {
    it('parses protocol://user:pass@host:port', () => {
        expect(parseProxyEndpointLine('http://user:pass@proxy.example.com:8080')).toEqual({
            protocol: 'http',
            host: 'proxy.example.com',
            port: 8080,
            username: 'user',
            password: 'pass',
        });
        expect(parseProxyEndpointLine('socks5://u:p@10.0.0.1:1080')).toEqual({
            protocol: 'socks5',
            host: '10.0.0.1',
            port: 1080,
            username: 'u',
            password: 'p',
        });
    });

    it('parses protocol://host:port (no credentials)', () => {
        expect(parseProxyEndpointLine('http://1.2.3.4:3128')).toEqual({ protocol: 'http', host: '1.2.3.4', port: 3128 });
        expect(parseProxyEndpointLine('https://proxy.example.com:8443')).toEqual({
            protocol: 'https',
            host: 'proxy.example.com',
            port: 8443,
        });
    });

    it('parses host:port:user:pass (protocol defaults to http, password may contain colons)', () => {
        expect(parseProxyEndpointLine('1.2.3.4:3128:user:pass')).toEqual({
            protocol: 'http',
            host: '1.2.3.4',
            port: 3128,
            username: 'user',
            password: 'pass',
        });
        expect(parseProxyEndpointLine('1.2.3.4:3128:user:p:a:s:s')).toEqual({
            protocol: 'http',
            host: '1.2.3.4',
            port: 3128,
            username: 'user',
            password: 'p:a:s:s',
        });
    });

    it('parses host:port (protocol defaults to http)', () => {
        expect(parseProxyEndpointLine('1.2.3.4:3128')).toEqual({ protocol: 'http', host: '1.2.3.4', port: 3128 });
    });

    it('keeps an explicitly typed default port (http://host:80 stays 80)', () => {
        expect(parseProxyEndpointLine('http://user:pass@host:80')).toMatchObject({ host: 'host', port: 80 });
    });

    it('percent-decodes URL credentials', () => {
        expect(parseProxyEndpointLine('http://u%40ser:p%40ss@host:8080')).toMatchObject({
            username: 'u@ser',
            password: 'p@ss',
        });
    });

    it('normalizes protocol case and suffixes', () => {
        expect(parseProxyEndpointLine('HTTP://host:8080')).toMatchObject({ protocol: 'http' });
        expect(parseProxyEndpointLine('Socks5://host:1080')).toMatchObject({ protocol: 'socks5' });
    });

    it('rejects bad lines with secret-free messages', () => {
        expect(() => parseProxyEndpointLine('')).toThrow(/empty/);
        expect(() => parseProxyEndpointLine('ftp://u:p@host:21')).toThrow(/unsupported protocol/);
        expect(() => parseProxyEndpointLine('http://host')).toThrow(/malformed proxy URL/);
        expect(() => parseProxyEndpointLine('host:notaport')).toThrow(/port must be an integer/);
        expect(() => parseProxyEndpointLine('host:99999')).toThrow(/port must be an integer/);
        expect(() => parseProxyEndpointLine('host:0')).toThrow(/port must be an integer/);
        expect(() => parseProxyEndpointLine('a:b:c')).toThrow(/expected host:port/);
        expect(() => parseProxyEndpointLine('host:8080::pass')).toThrow(/empty username/);
        expect(() => parseProxyEndpointLine(':8080')).toThrow(/host is required/);
    });
});

// ---------------------------------------------------------------------------
// parseProxyImportText
// ---------------------------------------------------------------------------

describe('parseProxyImportText', () => {
    it('skips comments and empty lines, imports all four formats', () => {
        const text = [
            '# my proxy list',
            '',
            'http://user:pass@proxy.example.com:8080',
            'socks5://10.0.0.1:1080',
            '   ',
            '1.2.3.4:3128:user:pass',
            '5.6.7.8:8080',
            '# trailing comment',
        ].join('\r\n');
        const { endpoints, failed } = parseProxyImportText(text);
        expect(failed).toEqual([]);
        expect(endpoints).toHaveLength(4);
        expect(endpoints.map((e) => e.port)).toEqual([8080, 1080, 3128, 8080]);
    });

    it('collects bad lines without throwing', () => {
        const text = ['http://good:8080', 'garbage line', 'host:99999'].join('\n');
        const { endpoints, failed } = parseProxyImportText(text);
        expect(endpoints).toHaveLength(1);
        expect(failed).toHaveLength(2);
        expect(failed[0]?.error).toBeTruthy();
        expect(failed[1]?.error).toMatch(/port/);
    });

    it('masks credentials in failure records (zero plaintext secrets)', () => {
        const text = ['http://user:secretpass@host:notaport', '9.9.9.9:notaport:user:secretpass'].join('\n');
        const { failed } = parseProxyImportText(text);
        expect(failed).toHaveLength(2);
        for (const failure of failed) {
            expect(failure.line).not.toContain('secretpass');
            expect(failure.line).not.toContain('user');
        }
        expect(failed[0]?.line).toContain('host'); // host kept for identification
        expect(failed[1]?.line).toBe('9.9.9.9:notaport:***');
    });
});

describe('maskProxyImportLine', () => {
    it('redacts URL-format lines via redactProxyUrl', () => {
        expect(maskProxyImportLine('http://user:pass@host:8080')).toBe('http://host:8080');
        expect(maskProxyImportLine('socks5://u:p@10.0.0.1:1080')).toBe('socks5://10.0.0.1:1080');
    });

    it('masks colon-format lines beyond host:port', () => {
        expect(maskProxyImportLine('1.2.3.4:3128:user:pass')).toBe('1.2.3.4:3128:***');
        expect(maskProxyImportLine('1.2.3.4:3128')).toBe('1.2.3.4:3128');
    });
});

// ---------------------------------------------------------------------------
// Health transition matrix
// ---------------------------------------------------------------------------

describe('applyHealthSuccess', () => {
    it('UNKNOWN → HEALTHY, streak reset, first latency sample stored directly', () => {
        const next = applyHealthSuccess(state(), 250);
        expect(next).toMatchObject({ healthStatus: 'HEALTHY', consecutiveFailures: 0, latencyMs: 250, quarantinedUntil: null });
    });

    it('folds latency into an exponential moving average (α=0.3)', () => {
        const next = applyHealthSuccess(state({ healthStatus: 'HEALTHY', latencyMs: 100 }), 200);
        expect(next.latencyMs).toBe(130); // 100*0.7 + 200*0.3
    });

    it('DEGRADED/UNHEALTHY → HEALTHY and clears any quarantine', () => {
        const quarantined = new Date(NOW.getTime() + PROXY_QUARANTINE_MS);
        for (const healthStatus of ['DEGRADED', 'UNHEALTHY'] as const) {
            const next = applyHealthSuccess(
                state({ healthStatus, consecutiveFailures: 4, quarantinedUntil: quarantined, latencyMs: 100 }),
                100,
            );
            expect(next.healthStatus).toBe('HEALTHY');
            expect(next.consecutiveFailures).toBe(0);
            expect(next.quarantinedUntil).toBeNull();
            expect(next.quarantineArmed).toBe(false);
        }
    });

    it('DISABLED stays DISABLED (operator-owned) but streak/latency still update', () => {
        const next = applyHealthSuccess(state({ healthStatus: 'DISABLED', consecutiveFailures: 3, latencyMs: 100 }), 200);
        expect(next.healthStatus).toBe('DISABLED');
        expect(next.consecutiveFailures).toBe(0);
        expect(next.latencyMs).toBe(130);
    });
});

describe('applyHealthFailure', () => {
    it('first consecutive failure keeps the current status (no quarantine)', () => {
        const fromHealthy = applyHealthFailure(state({ healthStatus: 'HEALTHY' }), NOW);
        expect(fromHealthy).toMatchObject({ healthStatus: 'HEALTHY', consecutiveFailures: 1, quarantineArmed: false });
        const fromUnknown = applyHealthFailure(state({ healthStatus: 'UNKNOWN' }), NOW);
        expect(fromUnknown).toMatchObject({ healthStatus: 'UNKNOWN', consecutiveFailures: 1 });
    });

    it(`streak ${PROXY_DEGRADED_THRESHOLD} → DEGRADED; still DEGRADED one below the unhealthy threshold`, () => {
        const second = applyHealthFailure(state({ healthStatus: 'HEALTHY', consecutiveFailures: 1 }), NOW);
        expect(second).toMatchObject({ healthStatus: 'DEGRADED', consecutiveFailures: 2, quarantineArmed: false });
        const third = applyHealthFailure(state({ healthStatus: 'DEGRADED', consecutiveFailures: 2 }), NOW);
        expect(third).toMatchObject({ healthStatus: 'DEGRADED', consecutiveFailures: 3, quarantineArmed: false });
    });

    it(`streak ${PROXY_UNHEALTHY_THRESHOLD} → UNHEALTHY and quarantined for exactly 15 minutes`, () => {
        const next = applyHealthFailure(state({ healthStatus: 'DEGRADED', consecutiveFailures: 3 }), NOW);
        expect(next.healthStatus).toBe('UNHEALTHY');
        expect(next.consecutiveFailures).toBe(4);
        expect(next.quarantineArmed).toBe(true);
        expect(next.quarantinedUntil?.getTime()).toBe(NOW.getTime() + PROXY_QUARANTINE_MS);
        expect(PROXY_QUARANTINE_MS).toBe(15 * 60 * 1000);
    });

    it('re-arms the quarantine window on every further failure while unhealthy', () => {
        const later = new Date(NOW.getTime() + 5 * 60 * 1000);
        const next = applyHealthFailure(
            state({ healthStatus: 'UNHEALTHY', consecutiveFailures: 4, quarantinedUntil: new Date(NOW.getTime() + PROXY_QUARANTINE_MS) }),
            later,
        );
        expect(next.quarantinedUntil?.getTime()).toBe(later.getTime() + PROXY_QUARANTINE_MS);
        expect(next.quarantineArmed).toBe(true);
    });

    it('failure does not touch latencyMs', () => {
        const next = applyHealthFailure(state({ healthStatus: 'HEALTHY', latencyMs: 321 }), NOW);
        expect(next.latencyMs).toBe(321);
    });

    it('DISABLED endpoints never degrade or quarantine via health checks', () => {
        const next = applyHealthFailure(state({ healthStatus: 'DISABLED', consecutiveFailures: 3 }), NOW);
        expect(next).toMatchObject({ healthStatus: 'DISABLED', consecutiveFailures: 4, quarantinedUntil: null, quarantineArmed: false });
    });
});
