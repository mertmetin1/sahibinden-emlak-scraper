/**
 * Local JSON dataset sink — replaces `Actor.pushData` + the Apify dataset.
 * Accumulates batches in memory; `finalize()` writes one JSON array file.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CategoryListing, OutputRepository, RuntimeLogger } from '@sahibindenbot/shared';

export class JsonFileOutputRepository implements OutputRepository {
    private readonly items: CategoryListing[] = [];
    /** ID dedup carried over from the CDP experiment (upstream had none). */
    private readonly seenIds = new Set<string>();
    private finalized = false;

    constructor(
        private readonly outputDir: string,
        private readonly runName: string,
        private readonly logger?: RuntimeLogger,
    ) {}

    /** Appends a batch; rows with an already-seen non-null id are dropped. */
    async upsertListings(items: CategoryListing[]): Promise<void> {
        for (const item of items) {
            if (item.id !== null) {
                if (this.seenIds.has(item.id)) continue;
                this.seenIds.add(item.id);
            }
            this.items.push(item);
        }
    }

    /** Number of accumulated (deduped) items — useful for tests/CLIs. */
    get size(): number {
        return this.items.length;
    }

    /** Writes `<outputDir>/<runName>-<ISO-ts>.json`. Idempotent. */
    async finalize(): Promise<void> {
        if (this.finalized) return;
        await mkdir(this.outputDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        // Keep the run name path-safe on every OS (drop control chars too).
        const safeName = this.runName.replace(/[^\w.-]/g, '_');
        const file = path.join(this.outputDir, `${safeName}-${ts}.json`);
        await writeFile(file, JSON.stringify(this.items, null, 2), 'utf8');
        this.finalized = true;
        this.logger?.info('Dataset written', { file, items: this.items.length });
    }
}
