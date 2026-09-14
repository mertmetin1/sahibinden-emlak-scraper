/**
 * Meta test: the scraper engine must be fully de-Apified (Phase 1 goal —
 * local-first runtime with injected ports replacing Actor.* services).
 *
 * Comments are stripped before scanning because the engine's docstrings
 * legitimately REFERENCE the Apify concepts being replaced (e.g. "replaces
 * `Actor.pushData`", "No Apify. No stealth."). The strip is intentionally
 * naive (block comments first, then // line comments): it can over-strip
 * inside string literals containing "//", which only ever hides text AFTER
 * such a string on the same line — an acceptable trade-off documented here,
 * and no engine source line mixes a URL string with an import statement.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ENGINE_SRC = path.resolve(__dirname, '../../packages/scraper-engine/src');

/** Naive comment strip: block comments, then line comments. */
function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

async function collectTsFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...(await collectTsFiles(full)));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

/** Patterns that must never appear in engine code (comments excluded). */
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
    { label: "from 'apify'", pattern: /from\s+'apify'/ },
    { label: 'from "apify"', pattern: /from\s+"apify"/ },
    { label: "from 'apify/…' (subpath)", pattern: /from\s+'apify\// },
    { label: 'from "apify/…" (subpath)', pattern: /from\s+"apify\// },
    { label: "require('apify')", pattern: /require\(\s*'apify'\s*\)/ },
    { label: 'require("apify")', pattern: /require\(\s*"apify"\s*\)/ },
    { label: 'Actor.* usage', pattern: /\bActor\./ },
];

describe('scraper-engine is Apify-free', () => {
    it('finds engine sources to scan', async () => {
        const files = await collectTsFiles(ENGINE_SRC);
        expect(files.length).toBeGreaterThan(0);
    });

    it('no engine .ts file imports apify or uses Actor.* (comments stripped)', async () => {
        const files = await collectTsFiles(ENGINE_SRC);
        const violations: string[] = [];

        for (const file of files) {
            const stripped = stripComments(await readFile(file, 'utf8'));
            for (const { label, pattern } of FORBIDDEN) {
                if (pattern.test(stripped)) {
                    violations.push(`${path.relative(ENGINE_SRC, file)}: ${label}`);
                }
            }
        }

        expect(violations).toEqual([]);
    });
});
