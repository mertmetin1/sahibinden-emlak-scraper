import { describe, expect, it } from 'vitest';
import { detectChallengeKind, isUnusualAccessHtml } from './challenge.js';
import { isListingDetailUrl, isUnusualAccessUrl, proxyHopCooldownMs, proxyRotationAvailable, resumeUrlForUnusualAccess, shouldHopProxy, PROXY_HOP_COOLDOWN_MAX_MS, PROXY_HOP_COOLDOWN_MIN_MS } from './unusual-access.js';

describe('isUnusualAccessHtml', () => {
    it('matches the Turkish interstitial copy', () => {
        expect(isUnusualAccessHtml('<p>Olağan dışı erişim tespit ettik.</p>')).toBe(true);
        expect(isUnusualAccessHtml('Olağandışı erişim tespit edildi')).toBe(true);
        expect(isUnusualAccessHtml('Unusual access detected')).toBe(true);
        expect(isUnusualAccessHtml('<a href="/olagan-disi-kullanim">engellendi</a>')).toBe(true);
    });

    it('does not match a normal listing page', () => {
        expect(isUnusualAccessHtml('<tr class="searchResultsItem">ilan</tr>')).toBe(false);
        expect(isUnusualAccessHtml('Just a moment')).toBe(false);
    });
});

describe('detectChallengeKind', () => {
    it('classifies unusual-access before generic CF', () => {
        expect(detectChallengeKind('Olağan dışı erişim tespit ettik challenge-platform')).toBe('unusual-access');
    });
});

describe('resumeUrlForUnusualAccess', () => {
    const list = 'https://www.sahibinden.com/satilik/adana-seyhan?pagingOffset=140';

    it('keeps the list URL with pagingOffset', () => {
        expect(resumeUrlForUnusualAccess(list, list)).toBe(list);
    });

    it('does not resume from a detail URL', () => {
        expect(
            resumeUrlForUnusualAccess(
                'https://www.sahibinden.com/ilan/emlak-konut-satilik-foo-123/detay',
                list,
            ),
        ).toBe(list);
    });

    it('does not resume from login/tloading', () => {
        expect(resumeUrlForUnusualAccess('https://www.sahibinden.com/giris', list)).toBe(list);
        expect(isListingDetailUrl('https://www.sahibinden.com/ilan/x-1/detay')).toBe(true);
        expect(isUnusualAccessUrl('https://www.sahibinden.com/olagan-disi-kullanim')).toBe(true);
        expect(
            isUnusualAccessUrl(
                'https://www.sahibinden.com/ilan/emlak-konut-satilik-olagan-disi-fiyat-123/detay',
            ),
        ).toBe(false);
        expect(
            resumeUrlForUnusualAccess('https://www.sahibinden.com/olagan-disi-kullanim', list),
        ).toBe(list);
    });
});

describe('proxyRotationAvailable', () => {
    it('is only true for managed mode with a proxy config', () => {
        expect(proxyRotationAvailable('managed', true)).toBe(true);
        expect(proxyRotationAvailable('cdp', true)).toBe(false);
        expect(proxyRotationAvailable('managed', false)).toBe(false);
    });
});

describe('shouldHopProxy', () => {
    it('hops every N details, never at zero', () => {
        expect(shouldHopProxy(0, 6)).toBe(false);
        expect(shouldHopProxy(5, 6)).toBe(false);
        expect(shouldHopProxy(6, 6)).toBe(true);
        expect(shouldHopProxy(12, 6)).toBe(true);
    });
});

describe('proxyHopCooldownMs', () => {
    it('stays in the 25–45s band', () => {
        for (let i = 0; i < 20; i += 1) {
            const ms = proxyHopCooldownMs();
            expect(ms).toBeGreaterThanOrEqual(PROXY_HOP_COOLDOWN_MIN_MS);
            expect(ms).toBeLessThanOrEqual(PROXY_HOP_COOLDOWN_MAX_MS);
        }
    });
});
