/**
 * Engine-facing adapter: implements shared's OutputRepository port over the
 * ListingRepository, so the scraper engine persists to Postgres without ever
 * importing @prisma/client (it only sees the shared port).
 *
 * - Per-item upsert inside try/catch: one failing item NEVER crashes the batch;
 *   failures are classified 'DATABASE' and surfaced via getErrors().
 * - Outcome tallies are flushed into ScanRun counters after each batch:
 *   INSERTED -> itemsInserted, UPDATED -> itemsUpdated,
 *   PRICE_CHANGED -> pricesChanged (counted separately from itemsUpdated —
 *   mutated total = inserted + updated + pricesChanged), UNCHANGED -> none.
 * - finalize() is a no-op: every item is already committed in its own
 *   transaction (no buffered state to flush).
 */
import type { CategoryListing, ListingDetail, OutputRepository } from '@sahibindenbot/shared';
import type {
    ListingOutcome,
    ListingRepository,
    OutcomeCounts,
    RunRepository,
    UpsertItemError,
} from '../repositories/interfaces.js';

export class PrismaOutputRepository implements OutputRepository {
    private readonly errors: UpsertItemError[] = [];
    private readonly totals: OutcomeCounts = { inserted: 0, updated: 0, priceChanged: 0, unchanged: 0 };

    /**
     * NOTE: the task sketch showed (listingRepo, runId); the RunRepository is
     * required here because the adapter owns run-counter increments, so the
     * constructor takes (listingRepo, runRepo, runId).
     */
    constructor(
        private readonly listings: ListingRepository,
        private readonly runs: RunRepository,
        private readonly runId: string,
    ) {}

    async upsertListings(items: CategoryListing[]): Promise<void> {
        const batch: OutcomeCounts = { inserted: 0, updated: 0, priceChanged: 0, unchanged: 0 };
        for (const item of items) {
            try {
                const { outcome } = await this.listings.upsertCategoryListing(item, this.runId);
                tallyOutcome(batch, outcome);
            } catch (err) {
                this.errors.push(classifyItemError(item?.id ?? null, err));
            }
        }
        this.mergeInto(this.totals, batch);
        await this.flushCounters(batch);
    }

    async upsertDetails(items: ListingDetail[]): Promise<void> {
        const batch: OutcomeCounts = { inserted: 0, updated: 0, priceChanged: 0, unchanged: 0 };
        for (const item of items) {
            try {
                const { outcome } = await this.listings.upsertDetailListing(item, this.runId);
                tallyOutcome(batch, outcome);
            } catch (err) {
                this.errors.push(classifyItemError(item?.listingId ?? null, err));
            }
        }
        this.mergeInto(this.totals, batch);
        await this.flushCounters(batch);
    }

    /** No-op: persistence is transactional per item — nothing buffered. */
    async finalize(): Promise<void> {
        // intentionally empty
    }

    /** Per-item failures collected across all batches (classified 'DATABASE'). */
    getErrors(): readonly UpsertItemError[] {
        return this.errors;
    }

    /** Cumulative outcome tallies across all batches (pre run-counter mapping). */
    getOutcomeCounts(): OutcomeCounts {
        return { ...this.totals };
    }

    private async flushCounters(batch: OutcomeCounts): Promise<void> {
        try {
            if (batch.inserted > 0) await this.runs.incrementCounter(this.runId, 'itemsInserted', batch.inserted);
            if (batch.updated > 0) await this.runs.incrementCounter(this.runId, 'itemsUpdated', batch.updated);
            if (batch.priceChanged > 0) await this.runs.incrementCounter(this.runId, 'pricesChanged', batch.priceChanged);
        } catch (err) {
            // Counter flush failure must not crash the crawl either.
            this.errors.push(classifyItemError(null, err));
        }
    }

    private mergeInto(target: OutcomeCounts, batch: OutcomeCounts): void {
        target.inserted += batch.inserted;
        target.updated += batch.updated;
        target.priceChanged += batch.priceChanged;
        target.unchanged += batch.unchanged;
    }
}

function tallyOutcome(counts: OutcomeCounts, outcome: ListingOutcome): void {
    switch (outcome) {
        case 'INSERTED':
            counts.inserted += 1;
            break;
        case 'UPDATED':
            counts.updated += 1;
            break;
        case 'PRICE_CHANGED':
            counts.priceChanged += 1;
            break;
        case 'UNCHANGED':
            counts.unchanged += 1;
            break;
    }
}

function classifyItemError(sourceListingId: string | null, err: unknown): UpsertItemError {
    const message = err instanceof Error ? err.message : String(err);
    return { sourceListingId, code: 'DATABASE', message };
}
