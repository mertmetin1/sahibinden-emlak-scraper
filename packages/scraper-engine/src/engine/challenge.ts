/**
 * Challenge DETECTION only — substring signatures ported 1:1 from upstream
 * `src/main.js:97-119`. All automated SOLVING (PX press-and-hold, CF
 * auto-wait-as-solve) is intentionally removed per ADR-0002; detection feeds
 * the human-in-the-loop flow in run-crawl.ts.
 */
import type { ChallengeKind } from '../types.js';

/** Cloudflare / generic interstitial signatures (upstream `isChallengedPage`). */
export function isChallengedPage(html: string): boolean {
    return (
        html.includes('Just a moment') ||
        html.includes('Checking your browser') ||
        html.includes('cf-browser-verification') ||
        html.includes('challenge-platform') ||
        html.includes('Güvenlik doğrulaması gerçekleştirme') ||
        html.includes('Bir dakika lütfen') ||
        html.includes('Uyumsuz tarayıcı eklentisi')
    );
}

/** PerimeterX "press and hold" signatures (upstream `isPxHoldChallenge`). */
export function isPxHoldChallenge(html: string): boolean {
    return (
        html.includes('Basılı Tutun') ||
        html.includes('px-captcha') ||
        html.includes('_pxCaptcha') ||
        html.includes('PerimeterX') ||
        html.includes('Bağlantınız kontrol ediliyor') ||
        html.includes('human-challenge')
    );
}

/**
 * Classifies page HTML. PX is checked first (upstream order: a PX hold page
 * can also contain CF-ish strings). 'login-wall' is URL-based and therefore
 * detected by the caller, not here.
 */
export function detectChallengeKind(html: string): ChallengeKind {
    if (isPxHoldChallenge(html)) return 'perimeterx';
    if (isChallengedPage(html)) return 'cloudflare';
    return 'unknown-block';
}
