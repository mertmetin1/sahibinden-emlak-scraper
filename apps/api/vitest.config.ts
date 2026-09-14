import { defineConfig } from 'vitest/config';

/**
 * Package-local config so `pnpm --filter @sahibindenbot/api test` works
 * standalone. The repo-root config (used by root `pnpm test`) already
 * includes apps/** — both paths run the same colocated tests.
 *
 * fileParallelism: false — the DB-backed test files share the single
 * `sahibindenbot_test` database; sequential files keep cleanup deterministic
 * when this package is tested on its own. (Root runs use maxWorkers: 2 and
 * stay green because every file tracks and deletes only its own rows.)
 */
export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        testTimeout: 60_000,
        hookTimeout: 60_000,
        pool: 'forks',
        fileParallelism: false,
    },
});
