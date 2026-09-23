/**
 * Same-tab browsing helpers: scroll, dwell, move, click, goBack.
 *
 * This is pacing and real input — not fingerprint spoofing, not header
 * forging, not challenge solving (ADR-0002). Chrome still sends its own
 * headers; we just stop using `page.goto(listingUrl)` like a crawler.
 */
import type { ElementHandle, Page } from 'puppeteer';
import { randomDelay } from '../utils.js';

const LISTING_TITLE_LINK = 'td.searchResultsTitleValue a.classifiedTitle';

/** Live scans use multi-second delays; fixture tests use 10ms. */
export function isHumanPacing(delayMinMs: number): boolean {
    return delayMinMs >= 500;
}

function randInt(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Look at the page the way a person does: move the pointer, wheel a bit,
 * then sit on it. Tiny configured delays skip the motion (e2e).
 */
export type LookAroundKind = 'list' | 'detail' | 'list-return';

export async function lookAround(
    page: Page,
    opts: { delayMinMs: number; delayMaxMs: number; kind: LookAroundKind },
): Promise<void> {
    if (!isHumanPacing(opts.delayMinMs)) {
        await randomDelay(opts.delayMinMs, Math.max(opts.delayMaxMs, opts.delayMinMs));
        return;
    }

    const brief = opts.kind === 'list-return';

    try {
        const size = await page.evaluate(() => ({
            w: window.innerWidth || 1200,
            h: window.innerHeight || 800,
        }));
        await page.mouse.move(randInt(48, Math.max(80, size.w / 3)), randInt(90, Math.max(120, size.h / 3)), {
            steps: randInt(brief ? 4 : 6, brief ? 10 : 16),
        });
        const wheels = brief ? randInt(0, 1) : opts.kind === 'list' ? randInt(1, 3) : randInt(1, 2);
        for (let i = 0; i < wheels; i++) {
            await page.mouse.wheel({ deltaY: randInt(160, 480) });
            await randomDelay(180, 650);
        }
        if (!brief && Math.random() < 0.35) {
            await page.mouse.wheel({ deltaY: -randInt(60, 200) });
            await randomDelay(160, 480);
        }
    } catch {
        // Headless / detached window — still dwell below.
    }

    if (brief) {
        await randomDelay(450, Math.min(1_600, Math.max(800, opts.delayMinMs)));
        return;
    }

    const min = opts.kind === 'detail' ? Math.max(opts.delayMinMs, 1_200) : opts.delayMinMs;
    const max = opts.kind === 'detail' ? Math.max(opts.delayMaxMs, 2_800) : opts.delayMaxMs;
    await randomDelay(min, max);
}

export async function clickElementLikeHuman(page: Page, el: ElementHandle<Element>): Promise<void> {
    await el.evaluate(node => {
        node.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
    await randomDelay(120, 480);
    const box = await el.boundingBox();
    if (!box || box.width < 2 || box.height < 2) {
        await el.click({ delay: randInt(40, 120) });
        return;
    }
    const x = box.x + box.width * (0.25 + Math.random() * 0.5);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);
    await page.mouse.move(x, y, { steps: randInt(8, 18) });
    await randomDelay(70, 220);
    await page.mouse.click(x, y, { delay: randInt(35, 95) });
}

export async function findListingTitleLink(
    page: Page,
    item: { id: string | null; url: string },
): Promise<ElementHandle<Element> | null> {
    if (item.id) {
        const byId = await page.$(`tr.searchResultsItem[data-id="${item.id}"] ${LISTING_TITLE_LINK}`);
        if (byId) return byId;
    }
    const links = await page.$$(LISTING_TITLE_LINK);
    for (const link of links) {
        const href = await link.evaluate(a => (a as HTMLAnchorElement).href);
        const left = href.split('?')[0];
        const right = item.url.split('?')[0];
        if (href === item.url || left === right) return link;
        await link.dispose().catch(() => undefined);
    }
    return null;
}

export async function goBackLikeHuman(page: Page, timeoutMs: number): Promise<boolean> {
    try {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: timeoutMs }),
            page.goBack({ waitUntil: 'load', timeout: timeoutMs }),
        ]);
        return true;
    } catch {
        return false;
    }
}
