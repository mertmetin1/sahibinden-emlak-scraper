/**
 * Playwright global setup: seeds ScanRunEvent journal rows for the seeded
 * demo run (see seed-run-events.ts for the rationale). Runs through tsx in a
 * child process so the Prisma/ESM chain loads exactly like the app's own
 * scripts, independent of Playwright's module loader.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

export default function globalSetup(): void {
    // Single-string command: pnpm is a .cmd shim on Windows and needs a shell.
    const script = path.join('tests', 'e2e-ui', 'seed-run-events.ts');
    const result = spawnSync(`pnpm exec tsx "${script}"`, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: true,
        env: process.env,
    });
    if (result.status !== 0) {
        throw new Error(`[e2e-seed] seed-run-events exited with code ${String(result.status)}`);
    }
}
