/**
 * Detail-page parser — in-browser extraction half.
 *
 *   (a) `extractDetailRawInPage` — runs INSIDE the browser via
 *       `page.evaluate(extractDetailRawInPage)` (no arguments; the engine
 *       calls it exactly like that). It must stay FULLY self-contained:
 *       page.evaluate serializes the function source, so nothing outside the
 *       function body is reachable.
 *
 *       CONSTRAINT — no inner functions of any kind (declarations, arrows,
 *       function expressions): the production crawl runtime (`pnpm crawl`)
 *       transforms modules with tsx/esbuild `keepNames`, which injects a
 *       `__name(...)` helper call for EVERY nested function — and `__name`
 *       does not exist in the page, breaking serialization. The upstream
 *       category extractor is flat for the same reason. Shared logic is
 *       therefore expressed as LOOPS OVER PRE-COLLECTED ELEMENT ARRAYS
 *       ("text slots") instead of helper calls.
 *
 *   (b) `isUnavailableDetailHtml` — pure Node-side string check for
 *       removed-listing notice pages (used by the engine BEFORE extraction).
 *
 * `buildCssContentMap` and `resolveObfuscatedText` are additionally exported
 * as standalone functions (same logic as the inlined loops) for consumers
 * that post-process saved HTML with their own DOM; detail-fixtures.test.ts
 * pins them to the same fixture truths as the in-page extractor.
 *
 * The node-side normalizer (`normalizeDetail`) lives in detail-normalize.ts.
 * Selector evidence: see src/selectors/index.ts (SELECTOR_VERSION registry).
 *
 * LEGAL BOUNDARY (ADR-0002 / BASELINE_CONTRACT §4): phone numbers are read
 * ONLY from already-rendered DOM (visible text — including CSS-:before
 * content the page itself renders — or `data-opened` attributes of
 * already-rendered elements). No reveal mechanism is ever clicked, held, or
 * invoked. Masked renderings (`*`-containing, e.g. `data-encrypted`) are
 * recorded for provenance but never surface as `publicContactPhone`.
 */
import { trLower } from './tr-text.js';

// ---------------------------------------------------------------------------
// Raw shapes (all JSON-serializable — they cross page.evaluate's boundary)
// ---------------------------------------------------------------------------

/** One label/value pair from the property info list, in display order. */
export interface RawDetailAttribute {
    /** Label as displayed, whitespace-normalized (e.g. 'Oda Sayısı'). */
    label: string;
    /** Value as displayed, whitespace-normalized ('' when rendered empty). */
    value: string;
}

/** Raw seller signals; classification happens node-side with evidence. */
export interface RawSellerInfo {
    /** Office/store name from the store card or sticky header (null for individuals). */
    officeName: string | null;
    /** Store profile URL (e.g. https://<store>.sahibinden.com). */
    officeProfileUrl: string | null;
    /** Agent name within an office block (.user-info-agent h3 / sticky mirror). */
    agentName: string | null;
    /** Individual owner name (CSS-obfuscation resolved), null for offices. */
    individualName: string | null;
    /** 'Hesap açma tarihi …' / registration text when rendered (informational). */
    registrationText: string | null;
    /** True when a store/office block selector matched. */
    hasStoreCard: boolean;
    /** True when an individual-owner block selector matched. */
    hasIndividualBlock: boolean;
    /** Which seller selectors matched (drives sellerTypeEvidence strings). */
    evidenceSelectors: string[];
}

/**
 * One phone candidate with full provenance. `visibleText` is the rendered
 * text (CSS-obfuscation resolved); `dataOpened`/`dataEncrypted` are the raw
 * attribute values (or, for the individual phone block, the resolved masked
 * CSS rendering under `dataEncrypted`). Values containing '*' are masked and
 * are filtered out node-side — they never become `publicContactPhone`.
 */
export interface RawPhoneCandidate {
    /** Extraction site: 'sticky-header-phone' | 'user-info-phones' | 'phoneInfoPart'. */
    source: string;
    /** Rendered label ('Cep', 'İş', …) when present. */
    label: string | null;
    visibleText: string | null;
    dataOpened: string | null;
    dataEncrypted: string | null;
}

/** Raw detail-page payload as scraped inside the browser, before normalization. */
export interface RawDetailPage {
    /** location.href at extraction time (informational; ctx.url is authoritative). */
    pageUrl: string;
    title: string | null;
    /** Visible price text, e.g. '4.575.000 TL' (hidden-input fallback documented in selectors). */
    priceText: string | null;
    descriptionText: string | null;
    /** span.classifiedId[data-classifiedid] attribute (text fallback). */
    listingId: string | null;
    canonicalUrl: string | null;
    /** EVERY label/value pair of ul.classifiedInfoList, in display order. */
    attributes: RawDetailAttribute[];
    /** Category breadcrumb (Emlak > Konut > Satılık > Daire > …). */
    breadcrumb: string[];
    /** Address breadcrumb parts (province / district / neighborhood…), in order. */
    addressParts: string[];
    seller: RawSellerInfo;
    phones: RawPhoneCandidate[];
    /** Unique listing photo URLs in gallery display order (display size, x5_). */
    images: string[];
    /** JSON-LD VideoObject embedUrl when present. */
    videoUrl: string | null;
    /** Active virtual-tour link URL when present (passive link → null). */
    virtualTourUrl: string | null;
    /** True when the page is a removed-listing notice (no info list + notice text). */
    unavailable: boolean;
    /** The notice needle that matched (evidence), null otherwise. */
    unavailableText: string | null;
}

// ---------------------------------------------------------------------------
// Standalone CSS-obfuscation helpers (exported per spec; the in-page
// extractor inlines the SAME logic — see the keepNames constraint above).
// ---------------------------------------------------------------------------

/**
 * Builds a class→content map from all <style> tags under `root`, covering
 * sahibinden's CSS-:before obfuscation (BASELINE_CONTRACT §4):
 *   `<style>.css<uuid>:before {content: 'Test Y.';}</style><span class="css<uuid>"></span>`
 * and the attribute-referencing variant:
 *   `.css<uuid>:before {content: attr(data-content);}`
 * Literal contents are stored verbatim; attribute references are stored as
 * the literal string 'attr(<name>)' (re-parsed by resolveObfuscatedText).
 * Only classes starting with 'css' are collected — that prefix is the
 * obfuscation generator's signature and keeps unrelated `content:` rules out.
 */
export function buildCssContentMap(root: ParentNode): Record<string, string> {
    const map: Record<string, string> = {};
    const re = /\.(css[\w-]+)\s*::?before\s*\{[^{}]*?content\s*:\s*(?:"([^"]*)"|'([^']*)'|(attr\(\s*[\w-]+\s*\)))/g;
    const styles = root.querySelectorAll('style');
    for (const styleEl of styles) {
        const css = styleEl.textContent || '';
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(css)) !== null) {
            const className = m[1];
            if (!className) continue;
            const value = m[2] ?? m[3] ?? m[4];
            if (value !== undefined && !(className in map)) {
                map[className] = value;
            }
        }
    }
    return map;
}

/**
 * Resolves the rendered text of an element whose text is delivered via a
 * CSS-:before content rule: looks up each of the element's classes in
 * `cssMap`; literal contents are returned directly, 'attr(<name>)' entries
 * read the named attribute off the element. Returns null when the element is
 * not CSS-obfuscated (caller falls back to regular text extraction).
 */
export function resolveObfuscatedText(el: Element, cssMap: Record<string, string>): string | null {
    if (!el || !el.classList) return null;
    for (const cls of el.classList) {
        if (Object.prototype.hasOwnProperty.call(cssMap, cls)) {
            const raw = cssMap[cls];
            if (raw === undefined) continue;
            const attrMatch = /^attr\(\s*([\w-]+)\s*\)$/.exec(raw);
            const resolved = attrMatch ? el.getAttribute(attrMatch[1] ?? '') : raw;
            if (resolved !== null && String(resolved).trim() !== '') {
                return String(resolved).trim();
            }
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Unavailable-page detection (node-side, raw HTML string)
// ---------------------------------------------------------------------------

/**
 * Removed-listing notice needles, pre-folded with trLower semantics.
 * Verified phrasing family: '…yayından kaldırılmıştır', '…artık yayında
 * değil…', '…yayında değildir', '…ilan bulunamadı…'. The synthesized fixture
 * fixtures/html/detail-unavailable.html pins the first two.
 */
export const UNAVAILABLE_NOTICE_NEEDLES: readonly string[] = [
    'yayından kaldırıl',
    'artık yayında değil',
    'yayında değildir',
    'ilan bulunamadı',
];

/**
 * True when `html` is a removed/unavailable-listing notice page: a notice
 * phrase is present AND the page carries no listing markup (the
 * `classifiedInfoList` attribute table). The markup guard prevents false
 * positives from listing descriptions that merely mention such phrases.
 * Pure string matching — never throws.
 */
export function isUnavailableDetailHtml(html: string): boolean {
    if (!html) return false;
    if (html.includes('classifiedInfoList')) return false;
    const folded = trLower(html);
    return UNAVAILABLE_NOTICE_NEEDLES.some(needle => folded.includes(needle));
}

// ---------------------------------------------------------------------------
// In-page extractor (SELF-CONTAINED + FLAT — see header for the constraints)
// ---------------------------------------------------------------------------

/**
 * Extracts the raw detail-page payload. EXECUTED INSIDE THE BROWSER via
 * `page.evaluate(extractDetailRawInPage)`. Selectors are inlined (the
 * versioned registry in selectors/index.ts documents the same selectors with
 * fixture evidence).
 *
 * Robustness contract: every field extraction is individually guarded — a
 * missing/malformed block yields null/empty, never a thrown extraction.
 */
export function extractDetailRawInPage(): RawDetailPage {
    // ----- shared inline state -----

    // class→content map from all <style> tags (CSS-:before obfuscation,
    // BASELINE_CONTRACT §4). Inline copy of the exported buildCssContentMap.
    const cssMap: Record<string, string> = {};
    {
        const re = /\.(css[\w-]+)\s*::?before\s*\{[^{}]*?content\s*:\s*(?:"([^"]*)"|'([^']*)'|(attr\(\s*[\w-]+\s*\)))/g;
        const styles = document.querySelectorAll('style');
        for (const styleEl of styles) {
            const css = styleEl.textContent || '';
            re.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = re.exec(css)) !== null) {
                const className = m[1];
                if (!className) continue;
                const value = m[2] ?? m[3] ?? m[4];
                if (value !== undefined && !(className in cssMap)) {
                    cssMap[className] = value;
                }
            }
        }
    }

    /**
     * TEXT SLOTS: elements whose rendered text we need are collected into
     * `textSlots` and resolved by ONE shared loop below (no inner functions —
     * see the keepNames constraint in the file header). Resolution rule per
     * element (same logic as the exported resolveObfuscatedText + a visible
     * text fallback):
     *   1. the element's own classes in cssMap → literal content / attr(name);
     *   2. first css-classed descendant resolved the same way;
     *   3. iterative visible-text walk (skips STYLE/SCRIPT/NOSCRIPT subtrees).
     * Result: whitespace-collapsed string, '' when nothing rendered.
     */
    const textSlots: Array<Element | null> = [];
    const SLOT = {
        title: 0,
        price: 1,
        storeName: 2,
        stickyStoreName: 3,
        storeInfoGroup: 4,
        agentName: 5,
        stickyAgentName: 6,
        individualArea: 7,
        stickyIndividual: 8,
        registration: 9,
        stickyPhone: 10,
    } as const;

    const titleEl = document.querySelector('.classifiedDetailTitle h1') ?? document.querySelector('h1');
    const priceEl =
        document.querySelector('.classifiedInfo h3 span.classified-price-wrapper') ??
        document.querySelector('span.classified-price-wrapper');
    const storeNameEl = document.querySelector('.user-info-store-name a');
    const stickyStoreNameEl = document.querySelector('.sticky-header-store-name a');
    const storeInfoGroupEl = document.querySelector('.store-info-group .store-name-wrapper h5');
    const agentEl = document.querySelector('.user-info-agent h3');
    const stickyAgentEl = document.querySelector('.sticky-header-name');
    const individualAreaEl = document.querySelector('.classifiedUserBox.classified-owner-info .username-info-area');
    const stickyIndividualEl = document.querySelector('.sticky-header-indivudial-name'); // [sic] upstream typo
    const registrationEl =
        document.querySelector('.classifiedUserBox .userRegistrationDate') ??
        document.querySelector('.sticky-header-registration-date');
    const stickyPhoneEl = document.querySelector(
        '.sticky-header-phone [data-opened], .sticky-header-phone [data-encrypted]',
    );

    textSlots.push(
        titleEl,
        priceEl,
        storeNameEl,
        stickyStoreNameEl,
        storeInfoGroupEl,
        agentEl,
        stickyAgentEl,
        individualAreaEl,
        stickyIndividualEl,
        registrationEl,
        stickyPhoneEl,
    );

    // Phone-list elements (main office list + individual block) join the same
    // resolution pass; their labels are plain text and read directly.
    // (No .map() arrows — keepNames injects __name into those too.)
    const phoneListGroups = Array.from(document.querySelectorAll('.user-info-phones .dl-group'));
    const phoneListValueEls: Array<Element | null> = [];
    for (const g of phoneListGroups) phoneListValueEls.push(g.querySelector('dd'));
    const individualPhoneLis = Array.from(document.querySelectorAll('#phoneInfoPart li'));
    const individualPrettyEls: Array<Element | null> = [];
    const individualEncryptedEls: Array<Element | null> = [];
    for (const li of individualPhoneLis) {
        individualPrettyEls.push(li.querySelector('.pretty-phone-part'));
        individualEncryptedEls.push(li.querySelector('.encrypted-phone-part'));
    }

    const PHONE_LIST_BASE = textSlots.length;
    for (const el of phoneListValueEls) textSlots.push(el);
    const INDIVIDUAL_PRETTY_BASE = textSlots.length;
    for (const el of individualPrettyEls) textSlots.push(el);
    const INDIVIDUAL_ENCRYPTED_BASE = textSlots.length;
    for (const el of individualEncryptedEls) textSlots.push(el);

    // ----- the one shared resolution loop -----
    const slotTexts: string[] = [];
    for (const el of textSlots) {
        let resolved: string | null = null;
        if (el) {
            // (1)+(2): the element itself, then css-classed descendants.
            const candidates: Element[] = [el, ...Array.from(el.querySelectorAll('[class*="css"]'))];
            for (const cand of candidates) {
                for (const cls of Array.from(cand.classList)) {
                    if (Object.prototype.hasOwnProperty.call(cssMap, cls)) {
                        const raw = cssMap[cls];
                        if (raw === undefined) continue;
                        const attrMatch = /^attr\(\s*([\w-]+)\s*\)$/.exec(raw);
                        const v = attrMatch ? cand.getAttribute(attrMatch[1] ?? '') : raw;
                        if (v !== null && String(v).trim() !== '') {
                            resolved = String(v).trim();
                            break;
                        }
                    }
                }
                if (resolved !== null) break;
            }
            // (3): visible-text fallback — iterative walk, no recursion.
            if (resolved === null) {
                let visible = '';
                const stack: Node[] = [el];
                while (stack.length > 0) {
                    const node = stack.pop();
                    if (!node) break;
                    if (node.nodeType === 3) {
                        visible += node.nodeValue ?? '';
                        continue;
                    }
                    if (node.nodeType !== 1) continue;
                    const tag = (node as Element).tagName;
                    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT') continue;
                    for (let i = node.childNodes.length - 1; i >= 0; i--) {
                        const child = node.childNodes[i];
                        if (child) stack.push(child);
                    }
                }
                resolved = visible;
            }
        }
        slotTexts.push((resolved ?? '').replace(/\s+/g, ' ').trim());
    }
    // '' → null normalization, as data (an arrow helper would be __name-injected).
    const slotTextOrNull: Array<string | null> = [];
    for (const t of slotTexts) slotTextOrNull.push(t !== '' ? t : null);

    // ----- unavailable (removed listing) detection -----
    // The attribute table is the page's data core — only when it is ABSENT do
    // we scan for notice text (guards against description false-positives).
    const infoListItems = document.querySelectorAll('ul.classifiedInfoList li');
    let unavailable = false;
    let unavailableText: string | null = null;
    if (infoListItems.length === 0) {
        const body = document.body as HTMLElement | null;
        const bodyText = (body ? body.innerText || body.textContent || '' : '')
            .replace(/İ/g, 'i')
            .replace(/I/g, 'ı')
            .toLowerCase()
            .replace(/\s+/g, ' ');
        const needles = ['yayından kaldırıl', 'artık yayında değil', 'yayında değildir', 'ilan bulunamadı'];
        for (const needle of needles) {
            if (bodyText.includes(needle)) {
                unavailable = true;
                unavailableText = needle;
                break;
            }
        }
    }

    // ----- title / price / description -----
    const title = (slotTextOrNull[SLOT.title] ?? null);

    let priceText = (slotTextOrNull[SLOT.price] ?? null);
    if (!priceText) {
        // Hidden input mirroring the displayed price (documented fallback).
        const favPrice = document.querySelector('#favoriteClassifiedPrice') as HTMLInputElement | null;
        const v = favPrice?.value?.trim();
        if (v) priceText = v;
    }

    // #classifiedDescription by ID only — the .classifiedDescription CLASS
    // also marks the #classifiedProperties feature list; never select by class.
    let descriptionText: string | null = null;
    const descEl = document.querySelector('#classifiedDescription') as HTMLElement | null;
    if (descEl) {
        const t = (descEl.innerText || descEl.textContent || '').replace(/\s+/g, ' ').trim();
        descriptionText = t !== '' ? t : null;
    }

    // ----- attribute list: EVERY label/value pair, display order preserved -----
    const attributes: RawDetailAttribute[] = [];
    for (const li of infoListItems) {
        try {
            const labelEl = li.querySelector('strong');
            if (!labelEl) continue;
            const label = (labelEl.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (!label) continue;
            const valueEl = li.querySelector('span');
            let value = '';
            if (valueEl) {
                // values are plain text in all observed fixtures; resolve
                // css-obfuscation anyway (generic-first extraction).
                let resolvedValue: string | null = null;
                for (const cls of Array.from(valueEl.classList)) {
                    if (Object.prototype.hasOwnProperty.call(cssMap, cls)) {
                        const raw = cssMap[cls];
                        if (raw === undefined) continue;
                        const attrMatch = /^attr\(\s*([\w-]+)\s*\)$/.exec(raw);
                        const v = attrMatch ? valueEl.getAttribute(attrMatch[1] ?? '') : raw;
                        if (v !== null && String(v).trim() !== '') {
                            resolvedValue = String(v).trim();
                            break;
                        }
                    }
                }
                value = (resolvedValue ?? valueEl.textContent ?? '').replace(/\s+/g, ' ').trim();
            }
            attributes.push({ label, value });
        } catch {
            // Isolated per-pair failure: skip the pair, keep the page.
        }
    }

    // ----- category breadcrumb (DIRECT child anchor only — each li.bc-item
    //       also embeds a .bc-tooltip full of sibling-category links) -----
    const breadcrumb: string[] = [];
    for (const li of document.querySelectorAll('.search-result-bc li.bc-item')) {
        try {
            const span = li.querySelector(':scope > a span') ?? li.querySelector('a span');
            const t = (span?.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (t) breadcrumb.push(t);
        } catch {
            // skip item
        }
    }

    // ----- address breadcrumb (province / district / neighborhood) -----
    const addressParts: string[] = [];
    const addrScoped = document.querySelectorAll('.classifiedInfo h2 a[data-click-label^="Adres Breadcrumb"]');
    const addrAnchors = addrScoped.length > 0 ? addrScoped : document.querySelectorAll('a[data-click-label^="Adres Breadcrumb"]');
    for (const a of addrAnchors) {
        try {
            const t = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (t) addressParts.push(t);
        } catch {
            // skip part
        }
    }

    // ----- listing id (data-classifiedid preferred; digits-only text fallback) -----
    let listingId: string | null = null;
    const idEl = document.querySelector('span.classifiedId[data-classifiedid]') ?? document.querySelector('#classifiedId');
    if (idEl) {
        listingId = idEl.getAttribute('data-classifiedid');
        if (!listingId) {
            const t = (idEl.textContent ?? '').replace(/\s+/g, ' ').trim();
            if (/^\d{6,}$/.test(t)) listingId = t;
        }
    }

    // ----- canonical URL (og:url fallback) -----
    const canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    const ogUrlEl = document.querySelector('meta[property="og:url"]') as HTMLMetaElement | null;
    const canonicalUrl = canonicalEl?.href || ogUrlEl?.content || null;

    // ----- seller blocks (evidence selectors recorded for node-side classification) -----
    const seller: RawSellerInfo = {
        officeName: null,
        officeProfileUrl: null,
        agentName: null,
        individualName: null,
        registrationText: null,
        hasStoreCard: false,
        hasIndividualBlock: false,
        evidenceSelectors: [],
    };
    try {
        if (document.querySelector('.user-info-store-card')) seller.evidenceSelectors.push('.user-info-store-card');
        if (stickyStoreNameEl) seller.evidenceSelectors.push('.sticky-header-store-name');
        if (storeInfoGroupEl) seller.evidenceSelectors.push('.store-info-group');
        seller.hasStoreCard = seller.evidenceSelectors.length > 0;

        seller.officeName =
            (slotTextOrNull[SLOT.storeName] ?? null) ??
            (slotTextOrNull[SLOT.stickyStoreName] ?? null) ??
            (slotTextOrNull[SLOT.storeInfoGroup] ?? null);

        // Store profile URL: the anchor's absolutized href; an origin-only URL
        // is returned WITHOUT the trailing slash the URL constructor adds (the
        // authored store URL is 'https://<store>.sahibinden.com').
        const storeHrefEl = (storeNameEl ?? stickyStoreNameEl) as HTMLAnchorElement | null;
        if (storeHrefEl) {
            const href = storeHrefEl.href || '';
            if (href !== '') {
                let profileUrl = href;
                try {
                    const u = new URL(href);
                    if (u.pathname === '/' && u.search === '' && u.hash === '') profileUrl = u.origin;
                } catch {
                    // malformed URL — keep as-is
                }
                seller.officeProfileUrl = profileUrl;
            }
        }

        seller.agentName = (slotTextOrNull[SLOT.agentName] ?? null) ?? (slotTextOrNull[SLOT.stickyAgentName] ?? null);

        const individualBox = document.querySelector('.classifiedUserBox.classified-owner-info');
        if (individualBox) seller.evidenceSelectors.push('.classifiedUserBox.classified-owner-info');
        if (stickyIndividualEl) seller.evidenceSelectors.push('.sticky-header-indivudial-name');
        seller.hasIndividualBlock = individualBox !== null || stickyIndividualEl !== null;

        seller.individualName =
            (slotTextOrNull[SLOT.individualArea] ?? null) ?? (slotTextOrNull[SLOT.stickyIndividual] ?? null);
        seller.registrationText = (slotTextOrNull[SLOT.registration] ?? null);
    } catch {
        // Seller extraction failure must never fail the page.
    }

    // ----- phones (rendered DOM only — NEVER any reveal interaction) -----
    const phones: RawPhoneCandidate[] = [];
    try {
        if (stickyPhoneEl) {
            phones.push({
                source: 'sticky-header-phone',
                label: null,
                visibleText: (slotTextOrNull[SLOT.stickyPhone] ?? null),
                dataOpened: stickyPhoneEl.getAttribute('data-opened'),
                dataEncrypted: stickyPhoneEl.getAttribute('data-encrypted'),
            });
        }

        for (let i = 0; i < phoneListGroups.length; i++) {
            try {
                const group = phoneListGroups[i];
                const dt = group?.querySelector('dt');
                const dd = group?.querySelector('dd');
                const label = (dt?.textContent ?? '').replace(/\s+/g, ' ').trim();
                const openedHost = dd?.querySelector('[data-opened]') ?? (dd?.hasAttribute('data-opened') ? dd : null);
                const encryptedHost =
                    dd?.querySelector('[data-encrypted]') ?? (dd?.hasAttribute('data-encrypted') ? dd : null);
                phones.push({
                    source: 'user-info-phones',
                    label: label !== '' ? label : null,
                    visibleText: (slotTextOrNull[PHONE_LIST_BASE + i] ?? null),
                    dataOpened: openedHost?.getAttribute('data-opened') ?? null,
                    dataEncrypted: encryptedHost?.getAttribute('data-encrypted') ?? null,
                });
            } catch {
                // skip group
            }
        }

        for (let i = 0; i < individualPhoneLis.length; i++) {
            try {
                const li = individualPhoneLis[i];
                const strongEl = li?.querySelector('strong');
                const label = (strongEl?.textContent ?? '').replace(/\s+/g, ' ').trim();
                const openedHost = li?.querySelector('[data-opened]');
                const encryptedAttrHost = li?.querySelector('[data-encrypted]');
                phones.push({
                    source: 'phoneInfoPart',
                    label: label !== '' ? label : null,
                    visibleText: (slotTextOrNull[INDIVIDUAL_PRETTY_BASE + i] ?? null),
                    dataOpened: openedHost?.getAttribute('data-opened') ?? null,
                    // The masked CSS rendering is recorded as provenance under
                    // dataEncrypted — it contains '*' and is never a public phone.
                    dataEncrypted:
                        (slotTextOrNull[INDIVIDUAL_ENCRYPTED_BASE + i] ?? null) ?? encryptedAttrHost?.getAttribute('data-encrypted') ?? null,
                });
            } catch {
                // skip li
            }
        }
    } catch {
        // Phone extraction failure must never fail the page.
    }

    // ----- gallery images (display order; deduped; photo hosts only) -----
    const images: string[] = [];
    const seenImages = new Set<string>();
    try {
        // Main gallery: first img has a real src; lazy imgs carry data-src
        // (their src is a blank placeholder — filtered below). Most imgs are
        // <label><picture><img>, some are direct <label><img> children
        // (detail-sample-1.html:3451) — hence `label img`, not `picture img`.
        // Thumbnail strip and og:image are fallbacks only.
        const imageEls: Array<HTMLImageElement | null> = [
            ...Array.from(document.querySelectorAll('.classifiedDetailPhotos .classifiedDetailMainPhoto label img')),
        ] as Array<HTMLImageElement | null>;
        if (imageEls.length === 0) {
            imageEls.push(
                ...(Array.from(document.querySelectorAll('.classifiedDetailThumbList img')) as HTMLImageElement[]),
            );
        }
        for (const el of imageEls) {
            if (!el) continue;
            const candidates = [el.getAttribute('data-src'), el.getAttribute('src')];
            for (const c of candidates) {
                const url = (c ?? '').trim();
                if (url === '') continue;
                if (url.includes('assets/images/blank')) continue; // lazy-load placeholder
                if (!url.includes('shbdn.com/photos/') && !/image\d*\.sahibinden\.com/.test(url)) continue;
                if (seenImages.has(url)) continue;
                seenImages.add(url);
                images.push(url);
                break; // first usable URL per element
            }
        }
        if (images.length === 0) {
            const ogImage = document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
            const url = (ogImage?.content ?? '').trim();
            if (url !== '' && (url.includes('shbdn.com/photos/') || /image\d*\.sahibinden\.com/.test(url))) {
                images.push(url);
            }
        }
    } catch {
        // Image extraction failure must never fail the page.
    }

    // ----- video (JSON-LD VideoObject embedUrl) -----
    let videoUrl: string | null = null;
    try {
        for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
            try {
                const parsed: unknown = JSON.parse(s.textContent || '');
                const candidates = Array.isArray(parsed) ? parsed : [parsed];
                for (const c of candidates) {
                    if (c && typeof c === 'object' && (c as Record<string, unknown>)['@type'] === 'VideoObject') {
                        const embed = (c as Record<string, unknown>)['embedUrl'];
                        if (typeof embed === 'string' && embed.trim() !== '') {
                            videoUrl = embed.trim();
                            break;
                        }
                    }
                }
            } catch {
                // malformed JSON-LD block — ignore
            }
            if (videoUrl) break;
        }
    } catch {
        // Video extraction failure must never fail the page.
    }

    // ----- virtual tour (only an ACTIVE link yields a URL; passive → null) -----
    let virtualTourUrl: string | null = null;
    try {
        const vtEl = document.querySelector('a#virtual-tour:not(.passive)') as HTMLAnchorElement | null;
        if (vtEl) {
            virtualTourUrl = vtEl.href || vtEl.getAttribute('data-url') || null;
        }
    } catch {
        // ignore
    }

    return {
        pageUrl: typeof location !== 'undefined' ? location.href : '',
        title,
        priceText,
        descriptionText,
        listingId,
        canonicalUrl,
        attributes,
        breadcrumb,
        addressParts,
        seller,
        phones,
        images,
        videoUrl,
        virtualTourUrl,
        unavailable,
        unavailableText,
    };
}
