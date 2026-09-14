/**
 * Local JSON dataset sink — replaces `Actor.pushData` + the Apify dataset.
 * Accumulates batches in memory; `finalize()` writes one JSON array file per
 * stream (categories always, details only when non-empty).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CategoryListing, ListingDetail, OutputRepository, RuntimeLogger } from '@sahibindenbot/shared';

export class JsonFileOutputRepository implements OutputRepository {
    private readonly items: CategoryListing[] = [];
    /** ID dedup carried over from the CDP experiment (upstream had none). */
    private readonly seenIds = new Set<string>();
    private readonly details: ListingDetail[] = [];
    /** Detail dedup by listingId — same policy as category ids. */
    private readonly seenDetailIds = new Set<string>();
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

    /** Appends detail records; already-seen non-null listingIds are dropped. */
    async upsertDetails(items: ListingDetail[]): Promise<void> {
        for (const item of items) {
            if (item.listingId !== null) {
                if (this.seenDetailIds.has(item.listingId)) continue;
                this.seenDetailIds.add(item.listingId);
            }
            this.details.push(item);
        }
    }

    /** Number of accumulated (deduped) category items — useful for tests/CLIs. */
    get size(): number {
        return this.items.length;
    }

    /** Number of accumulated (deduped) detail records — useful for tests/CLIs. */
    get detailCount(): number {
        return this.details.length;
    }

    /**
     * Writes `<outputDir>/<runName>-<ISO-ts>.json` (categories) and, only when
     * at least one detail was recorded, `<outputDir>/<runName>-details-<ISO-ts>.json`.
     * Both files share the same timestamp so they correlate. Idempotent.
     */
    async finalize(): Promise<void> {
        if (this.finalized) return;
        await mkdir(this.outputDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        // Keep the run name path-safe on every OS (drop control chars too).
        const safeName = this.runName.replace(/[^\w.-]/g, '_');
        const file = path.join(this.outputDir, `${safeName}-${ts}.json`);
        await writeFile(file, JSON.stringify(this.items, null, 2), 'utf8');
        if (this.details.length > 0) {
            const detailsFile = path.join(this.outputDir, `${safeName}-details-${ts}.json`);
            await writeFile(detailsFile, JSON.stringify(this.details, null, 2), 'utf8');
            this.logger?.info('Detail dataset written', { file: detailsFile, items: this.details.length });
        }
        this.finalized = true;
        this.logger?.info('Dataset written', { file, items: this.items.length });
    }
}
