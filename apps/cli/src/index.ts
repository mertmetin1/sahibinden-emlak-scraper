/**
 * sahibinden-bot CLI — local crawler entry point.
 *
 *   pnpm crawl --config ./examples/adana-test.json
 *
 * No Apify. No token. Local config in, local JSON dataset out.
 */
import { loadConfig } from '@sahibindenbot/config';
import { createLogger, toRuntimeLogger, type CrawlEvent, type EventSink } from '@sahibindenbot/shared';
import {
    runCrawl,
    JsonFileOutputRepository,
    FsDebugArtifactStore,
    StaticProxyProvider,
    NullProxyProvider,
    FileSessionProvider,
    StaticSessionProvider,
} from '@sahibindenbot/scraper-engine';
import path from 'node:path';

class ConsoleEventSink implements EventSink {
    emit(event: CrawlEvent): void {
        const data = event.data ? ` ${JSON.stringify(event.data)}` : '';
        process.stdout.write(`[event] ${event.type}${data}\n`);
    }
}

function parseArgs(argv: string[]): { config: string } {
    const idx = argv.indexOf('--config');
    if (idx === -1 || !argv[idx + 1]) {
        process.stderr.write('Usage: pnpm crawl --config <path-to-config.json>\n');
        process.exit(64);
    }
    return { config: argv[idx + 1]! };
}

async function main(): Promise<number> {
    const { config: configPath } = parseArgs(process.argv.slice(2));

    const logger = toRuntimeLogger(createLogger('cli'));
    logger.info('Loading config', { configPath });
    const config = await loadConfig(configPath);

    const runName = `${config.name ?? 'crawl'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const artifactsDir = path.join(config.outputDir, '..', 'artifacts', runName);

    const deps = {
        output: new JsonFileOutputRepository(config.outputDir, runName),
        debugStore: new FsDebugArtifactStore(artifactsDir),
        proxyProvider: config.proxy
            ? new StaticProxyProvider(config.proxy.urls)
            : new NullProxyProvider(),
        sessionProvider: config.sessionCookiesFile
            ? new FileSessionProvider(config.sessionCookiesFile)
            : new StaticSessionProvider([]),
        logger: toRuntimeLogger(createLogger('crawl')),
        events: new ConsoleEventSink(),
    };

    logger.info('Starting crawl', {
        name: config.name,
        startUrls: config.startUrls,
        browserMode: config.browser.mode,
        maxItems: config.maxItems,
        maxPages: config.maxPages,
    });

    const result = await runCrawl(config, deps);

    process.stdout.write(`\n=== Crawl finished ===\n${JSON.stringify(result, null, 2)}\n`);

    switch (result.status) {
        case 'SUCCEEDED': return 0;
        case 'PARTIAL': return 2;
        case 'CANCELLED': return 3;
        default: return 1;
    }
}

main()
    .then(code => process.exit(code))
    .catch(err => {
        process.stderr.write(`Fatal: ${(err as Error).message}\n`);
        process.exit(1);
    });
