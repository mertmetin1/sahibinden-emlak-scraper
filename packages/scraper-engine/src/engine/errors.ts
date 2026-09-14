/**
 * Typed error classification — replaces upstream's stringly errors, where every
 * failure (challenge, login wall, selector break, network) followed the same
 * retry path and was only distinguishable by message text.
 */
import { CrawlError, type CrawlErrorCode } from '@sahibindenbot/shared';

/**
 * Creates a CrawlError whose message carries a `[CODE]` tag. Crawlee serializes
 * thrown errors into `request.errorMessages` (strings) across retries; the tag
 * lets `classifyError` recover the exact code from those strings later.
 */
export function crawlError(code: CrawlErrorCode, message: string, cause?: unknown): CrawlError {
    return new CrawlError(code, `[${code}] ${message}`, cause);
}

const CODE_TAG = /\[([A-Z_]+)\]/;

const KNOWN_CODES: ReadonlySet<string> = new Set([
    'NETWORK',
    'TIMEOUT',
    'AUTH_REQUIRED',
    'INVALID_PAGE',
    'PARSER_CHANGED',
    'PROXY_ERROR',
    'RATE_LIMIT',
    'DATABASE',
    'CANCELLED',
    'UNSUPPORTED_LABEL',
    'UNKNOWN',
]);

/** Maps any thrown value to a CrawlErrorCode. Never throws. */
export function classifyError(err: unknown): CrawlErrorCode {
    if (err instanceof CrawlError) return err.code;

    const msg = err instanceof Error ? err.message : String(err);

    // Exact code recovery from a crawlError() tag (survives Crawlee serialization).
    const tag = msg.match(CODE_TAG)?.[1];
    if (tag && KNOWN_CODES.has(tag)) return tag as CrawlErrorCode;

    // Heuristics for third-party errors (puppeteer/crawlee/network stack).
    const m = msg.toLowerCase();
    if (m.includes('mandatory login') || m.includes('auth_required')) return 'AUTH_REQUIRED';
    if (m.includes('no listing') || m.includes('parser_changed')) return 'PARSER_CHANGED';
    if (m.includes('unsupported_label')) return 'UNSUPPORTED_LABEL';
    if (
        m.includes('challenge') ||
        m.includes('perimeterx') ||
        m.includes('cloudflare') ||
        m.includes('blocked with status') ||
        m.includes('429') ||
        m.includes('rate_limit')
    ) {
        return 'RATE_LIMIT';
    }
    if (m.includes('cancelled') || m.includes('canceled')) return 'CANCELLED';
    if (m.includes('timeout') || m.includes('timed out')) return 'TIMEOUT';
    if (m.includes('proxy')) return 'PROXY_ERROR';
    if (
        m.includes('net::') ||
        m.includes('err_') ||
        m.includes('econn') ||
        m.includes('enotfound') ||
        m.includes('socket hang up')
    ) {
        return 'NETWORK';
    }
    return 'UNKNOWN';
}

/** Classifies a failed request from its Crawlee-collected error messages. */
export function classifyErrorMessages(messages: readonly string[] | undefined): CrawlErrorCode {
    const last = messages?.[messages.length - 1];
    return last ? classifyError(last) : 'UNKNOWN';
}
