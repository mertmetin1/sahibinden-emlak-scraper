import { readFile } from 'node:fs/promises';
import { crawlConfigSchema } from './schema.js';
import type { CrawlConfig } from '@sahibindenbot/shared';

export { crawlConfigSchema, cookieParamSchema, type ParsedCrawlConfig } from './schema.js';

/** Loads a JSON config file and validates it into a typed CrawlConfig. */
export async function loadConfig(configPath: string): Promise<CrawlConfig> {
    let raw: string;
    try {
        raw = await readFile(configPath, 'utf8');
    } catch (err) {
        throw new Error(`Config file not readable: ${configPath} (${(err as Error).message})`);
    }

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        throw new Error(`Config file is not valid JSON: ${configPath} (${(err as Error).message})`);
    }

    const parsed = crawlConfigSchema.safeParse(json);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map(i => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n');
        throw new Error(`Invalid crawl config:\n${issues}`);
    }

    // ParsedCrawlConfig is structurally identical to CrawlConfig (all defaults applied).
    return parsed.data as CrawlConfig;
}
