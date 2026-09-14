import { z } from 'zod';

const urlString = z.string().url();

export const cookieParamSchema = z.object({
    name: z.string().min(1),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional(),
    expires: z.number().optional(),
    secure: z.boolean().optional(),
    httpOnly: z.boolean().optional(),
    sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});

const browserSchema = z
    .object({
        mode: z.enum(['managed', 'cdp']),
        cdpUrl: urlString.optional(),
        headless: z.boolean().optional(),
    })
    .refine(b => b.mode !== 'cdp' || (typeof b.cdpUrl === 'string' && b.cdpUrl.length > 0), {
        message: 'browser.cdpUrl is required when browser.mode = "cdp"',
        path: ['cdpUrl'],
    });

const proxySchema = z.object({
    urls: z.array(z.string().min(1)).min(1),
});

export const crawlConfigSchema = z.object({
    name: z.string().min(1).optional(),
    startUrls: z.array(urlString).min(1),
    maxItems: z.number().int().min(1).nullable().default(null),
    maxPages: z.number().int().min(1).nullable().default(null),
    includeDetails: z.boolean().default(false),
    maxConcurrency: z.number().int().min(1).max(10).default(3),
    navigationTimeoutSeconds: z.number().int().min(5).max(300).default(90),
    requestHandlerTimeoutSeconds: z.number().int().min(30).max(600).default(180),
    maxRequestRetries: z.number().int().min(0).max(20).default(8),
    delayMinMs: z.number().int().min(0).default(2000),
    delayMaxMs: z.number().int().min(0).default(5000),
    debugMode: z.boolean().default(false),
    storeRawHtml: z.boolean().default(false),
    browser: browserSchema.default({ mode: 'managed', headless: true }),
    proxy: proxySchema.nullable().default(null),
    sessionCookiesFile: z.string().min(1).nullable().default(null),
    allowedDomains: z.array(z.string().min(1)).default(['sahibinden.com', 'www.sahibinden.com']),
    outputDir: z.string().min(1).default('storage/datasets'),
    humanInTheLoop: z.boolean().default(true),
    humanInTheLoopTimeoutSeconds: z.number().int().min(30).max(900).default(180),
})
    .refine(c => c.delayMaxMs >= c.delayMinMs, {
        message: 'delayMaxMs must be >= delayMinMs',
        path: ['delayMaxMs'],
    });

export type ParsedCrawlConfig = z.infer<typeof crawlConfigSchema>;
