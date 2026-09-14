/**
 * Pins the label-routing decision: the router is the guarantee that a DETAIL
 * request never executes category parsing logic (and vice versa), and that
 * unknown/missing labels fail loudly with UNSUPPORTED_LABEL instead of being
 * silently treated as category pages.
 */
import { describe, expect, it } from 'vitest';
import { CrawlError } from '@sahibindenbot/shared';
import { routeLabel } from './router.js';

describe('routeLabel', () => {
    it("routes 'CATEGORY' to the category handler", () => {
        expect(routeLabel('CATEGORY')).toBe('CATEGORY');
    });

    it("routes 'DETAIL' to the detail handler (never category logic)", () => {
        expect(routeLabel('DETAIL')).toBe('DETAIL');
    });

    it('throws CrawlError UNSUPPORTED_LABEL for garbage labels', () => {
        for (const garbage of ['category', 'Detail', 'FOO', '', '0', 'null']) {
            let thrown: unknown;
            try {
                routeLabel(garbage);
            } catch (err) {
                thrown = err;
            }
            expect(thrown).toBeInstanceOf(CrawlError);
            expect((thrown as CrawlError).code).toBe('UNSUPPORTED_LABEL');
        }
    });

    it('throws CrawlError UNSUPPORTED_LABEL for undefined / null / non-strings', () => {
        for (const missing of [undefined, null, 42, {}, ['CATEGORY']]) {
            let thrown: unknown;
            try {
                routeLabel(missing);
            } catch (err) {
                thrown = err;
            }
            expect(thrown).toBeInstanceOf(CrawlError);
            expect((thrown as CrawlError).code).toBe('UNSUPPORTED_LABEL');
        }
    });

    it('tags the error message with the [UNSUPPORTED_LABEL] code (survives Crawlee serialization)', () => {
        expect(() => routeLabel('garbage')).toThrowError(/\[UNSUPPORTED_LABEL\]/);
    });
});
