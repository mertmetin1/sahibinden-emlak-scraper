import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
        testTimeout: 120_000, // fixture-server crawl tests drive a real browser
        hookTimeout: 60_000,
        pool: 'forks',
        maxWorkers: 2, // browser-based tests must not starve each other
    },
});
