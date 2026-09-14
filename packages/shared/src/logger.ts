import { pino, type Logger } from 'pino';
import type { RuntimeLogger } from './types.js';

/** Paths that must never appear in logs (defense in depth on top of call-site discipline). */
const REDACT_PATHS = [
    'password',
    'token',
    'cookie',
    'cookies',
    'sessionCookies',
    'setCookie',
    'authorization',
    'proxyAuth',
    '*.password',
    '*.token',
    '*.cookie',
    '*.cookies',
    '*.sessionCookies',
    'data.cookies',
    'data.cookie',
    'data.password',
    'data.token',
];

export function createLogger(name: string, level: string = 'info'): Logger {
    return pino({
        name,
        level,
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    });
}

/** Adapts a pino Logger to the RuntimeLogger port. */
export function toRuntimeLogger(logger: Logger): RuntimeLogger {
    return {
        info: (msg, data) => logger.info(data ?? {}, msg),
        warn: (msg, data) => logger.warn(data ?? {}, msg),
        error: (msg, data) => logger.error(data ?? {}, msg),
        debug: (msg, data) => logger.debug(data ?? {}, msg),
    };
}
