/**
 * Prisma implementation of ListingRepository.
 *
 * Write paths (category + detail) share one shape:
 *   1. resolve identity (source, sourceListingId)
 *   2. one $transaction per item: upsert listing, price-history on real
 *      change, seen-history + run-link journal on EVERY observation
 *   3. per-item failures are caught by the batch wrappers, classified
 *      'DATABASE', and collected — a bad item never poisons the batch.
 *
 * Staleness policy lives in applySuccessfulRunStaleness(); REMOVED is only
 * ever set via markRemoved() (explicit site signal), never from absence.
 */
import { CrawlError } from '@sahibindenbot/shared';
import type { CategoryListing, ListingDetail } from '@sahibindenbot/shared';
import { Prisma } from '@prisma/client';
import type { Listing, PrismaClient, SellerType as PrismaSellerType } from '@prisma/client';
import { computeLatestPriceChangePercent, computePriceChanged } from './derived.js';
import type {
    BatchUpsertResult,
    ListingDetailRecord,
    ListingFilters,
    ListingFacets,
    ListingListResult,
    ListingRepository,
    ListingSort,
    ListingSortField,
    OutcomeCounts,
    UpsertItemError,
    UpsertSuccess,
} from './interfaces.js';
import { DEFAULT_SOURCE, mapCategoryListing, mapDetailListing } from './mappers.js';
import type { DetailSellerSnapshot, DetailSnapshot } from './mappers.js';
import { decideOutcome } from './outcome.js';
import {
    toAttributeRecord,
    toImageRecord,
    toListingRecord,
    toPriceHistoryRecord,
    toRunLinkRecord,
    toSeenRecord,
    toSellerRecord,
} from './prisma-mappers.js';

/**
 * Mutable scalar Listing fields, typed exactly as the columns are. Optional
 * props carry only the fields a given write path refreshes; structurally
 * assignable to Prisma.ListingUpdateInput (plain scalars, no operations).
 */
interface ListingMutableData {
    canonicalUrl?: string;
    title?: string;
    description?: string;
    price?: number | null;
    currency?: string;
    pricePerSquareMeter?: number | null;
    listingType?: string | null;
    propertyCategory?: string | null;
    propertySubtype?: string | null;
    grossAreaM2?: number | null;
    netAreaM2?: number | null;
    rooms?: string | null;
    buildingAge?: string | null;
    floor?: string | null;
    totalFloors?: string | null;
    heating?: string | null;
    bathroomCount?: string | null;
    balcony?: string | null;
    furnished?: string | null;
    usageStatus?: string | null;
    insideSite?: string | null;
    siteName?: string | null;
    dues?: string | null;
    deposit?: string | null;
    deedStatus?: string | null;
    creditEligible?: string | null;
    exchangeEligible?: string | null;
    province?: string | null;
    district?: string | null;
    neighborhood?: string | null;
    locationRaw?: string;
    listingDate?: Date | null;
    listingDateRaw?: string | null;
    updatedDate?: Date | null;
    updatedDateRaw?: string | null;
    publicContactPhone?: string | null;
    videoUrl?: string | null;
    virtualTourUrl?: string | null;
    sellerId?: string | null;
    sellerType?: string | null;
}

/** Field-by-field compare of an existing row against a mutable payload (dates by time). */
function mutableFieldsChanged(existing: Listing, data: ListingMutableData): boolean {
    // Justified cast: generic key lookup over a generated model type.
    const prev = existing as unknown as Record<string, unknown>;
    for (const [key, next] of Object.entries(data)) {
        const before = prev[key];
        if (before instanceof Date || next instanceof Date) {
            const beforeTime = before instanceof Date ? before.getTime() : null;
            const nextTime = next instanceof Date ? next.getTime() : null;
            if (beforeTime !== nextTime) return true;
        } else if (before !== next) {
            return true;
        }
    }
    return false;
}

/** shared SellerType / denormalized strings mirror the Prisma enum 1:1 (justified cast). */
const asSellerType = (value: string): PrismaSellerType => value as PrismaSellerType;

function toItemError(sourceListingId: string | null, err: unknown): UpsertItemError {
    const message = err instanceof Error ? err.message : String(err);
    return { sourceListingId, code: 'DATABASE', message };
}

function emptyCounts(): OutcomeCounts {
    return { inserted: 0, updated: 0, priceChanged: 0, unchanged: 0 };
}

function tally(counts: OutcomeCounts, outcome: UpsertSuccess['outcome']): void {
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

/** configurationSnapshot.incrementalMode === true (absent/false = full scan). */
function isIncrementalSnapshot(snapshot: unknown): boolean {
    return (
        typeof snapshot === 'object' &&
        snapshot !== null &&
        (snapshot as Record<string, unknown>).incrementalMode === true
    );
}

const SORTABLE_NULLABLE: ReadonlySet<ListingSortField> = new Set(['price', 'pricePerSquareMeter', 'listingDate']);

const FACET_COLUMNS = [
    'province',
    'district',
    'neighborhood',
    'listingType',
    'propertyCategory',
    'propertySubtype',
    'rooms',
    'heating',
    'buildingAge',
    'floor',
    'bathroomCount',
    'balcony',
    'furnished',
    'usageStatus',
    'insideSite',
    'creditEligible',
    'exchangeEligible',
] as const;

type FacetColumn = (typeof FACET_COLUMNS)[number];

function eqI(value: string): Prisma.StringFilter {
    return { equals: value, mode: 'insensitive' };
}

function listingWhere(filters: ListingFilters, omit: ReadonlySet<string> = new Set()): Prisma.ListingWhereInput {
    const use = (key: keyof ListingFilters): boolean => filters[key] !== undefined && !omit.has(key);
    const where: Prisma.ListingWhereInput = {};
    if (use('status')) where.status = filters.status;
    if (use('province') && filters.province !== undefined) where.province = eqI(filters.province);
    if (use('district') && filters.district !== undefined) where.district = eqI(filters.district);
    if (use('neighborhood') && filters.neighborhood !== undefined) where.neighborhood = eqI(filters.neighborhood);
    if (use('sellerType')) where.sellerType = filters.sellerType;
    if (use('listingType') && filters.listingType !== undefined) where.listingType = eqI(filters.listingType);
    if (use('propertyCategory') && filters.propertyCategory !== undefined) {
        where.propertyCategory = eqI(filters.propertyCategory);
    }
    if (use('propertySubtype') && filters.propertySubtype !== undefined) {
        where.propertySubtype = eqI(filters.propertySubtype);
    }
    if (use('priceMin') || use('priceMax')) {
        where.price = {
            ...(use('priceMin') ? { gte: filters.priceMin } : {}),
            ...(use('priceMax') ? { lte: filters.priceMax } : {}),
        };
    }
    if (use('m2Min') || use('m2Max')) {
        where.grossAreaM2 = {
            ...(use('m2Min') ? { gte: filters.m2Min } : {}),
            ...(use('m2Max') ? { lte: filters.m2Max } : {}),
        };
    }
    if (use('rooms') && filters.rooms !== undefined) where.rooms = eqI(filters.rooms);
    if (use('heating') && filters.heating !== undefined) where.heating = eqI(filters.heating);
    if (use('buildingAge') && filters.buildingAge !== undefined) where.buildingAge = eqI(filters.buildingAge);
    if (use('floor') && filters.floor !== undefined) where.floor = eqI(filters.floor);
    if (use('bathroomCount') && filters.bathroomCount !== undefined) where.bathroomCount = eqI(filters.bathroomCount);
    if (use('balcony') && filters.balcony !== undefined) where.balcony = eqI(filters.balcony);
    if (use('furnished') && filters.furnished !== undefined) where.furnished = eqI(filters.furnished);
    if (use('usageStatus') && filters.usageStatus !== undefined) where.usageStatus = eqI(filters.usageStatus);
    if (use('insideSite') && filters.insideSite !== undefined) where.insideSite = eqI(filters.insideSite);
    if (use('creditEligible') && filters.creditEligible !== undefined) where.creditEligible = eqI(filters.creditEligible);
    if (use('exchangeEligible') && filters.exchangeEligible !== undefined) {
        where.exchangeEligible = eqI(filters.exchangeEligible);
    }
    if (use('siteName') && filters.siteName !== undefined) {
        where.siteName = { contains: filters.siteName, mode: 'insensitive' };
    }
    if (use('firstSeenFrom') && filters.firstSeenFrom !== undefined) {
        where.firstSeenAt = { gte: filters.firstSeenFrom };
    }
    if (use('lastSeenBefore') && filters.lastSeenBefore !== undefined) {
        where.lastSeenAt = { lt: filters.lastSeenBefore };
    }
    if (use('priceChanged') && filters.priceChanged === true) where.priceHistory = { some: {} };
    if (use('scanId') && filters.scanId !== undefined) {
        where.runLinks = { some: { run: { scanDefinitionId: filters.scanId } } };
    }
    if (use('search') && filters.search !== undefined && filters.search.trim() !== '') {
        const s = filters.search.trim();
        where.OR = [
            { sourceListingId: { contains: s } },
            { title: { contains: s, mode: 'insensitive' } },
            { description: { contains: s, mode: 'insensitive' } },
            { seller: { is: { displayName: { contains: s, mode: 'insensitive' } } } },
            { seller: { is: { officeName: { contains: s, mode: 'insensitive' } } } },
        ];
    }
    return where;
}

export class PrismaListingRepository implements ListingRepository {
    constructor(private readonly prisma: PrismaClient) {}

    // ------------------------------------------------------------------
    // Category path
    // ------------------------------------------------------------------

    async upsertCategoryListing(item: CategoryListing, runId: string): Promise<UpsertSuccess> {
        const snap = mapCategoryListing(item);
        if (snap === null) {
            throw new CrawlError('DATABASE', 'category listing has no usable id (null/empty) — cannot upsert');
        }
        try {
            return await this.prisma.$transaction(async (tx) => {
                const now = new Date();
                const identity = { source: DEFAULT_SOURCE, sourceListingId: snap.sourceListingId };
                const existing = await tx.listing.findUnique({
                    where: { source_sourceListingId: identity },
                });

                // Category rows refresh only non-null fields — a sparse row
                // must never erase detail-provided data.
                const mutable: ListingMutableData = {
                    canonicalUrl: snap.canonicalUrl,
                    title: snap.title,
                    currency: snap.currency,
                    locationRaw: snap.locationRaw,
                };
                if (snap.price !== null) mutable.price = snap.price;
                if (snap.pricePerSquareMeter !== null) mutable.pricePerSquareMeter = snap.pricePerSquareMeter;
                if (snap.grossAreaM2 !== null) mutable.grossAreaM2 = snap.grossAreaM2;
                if (snap.district !== null) mutable.district = snap.district;
                if (snap.neighborhood !== null) mutable.neighborhood = snap.neighborhood;
                if (snap.listingDate !== null) mutable.listingDate = snap.listingDate;
                if (snap.listingDateRaw !== null) mutable.listingDateRaw = snap.listingDateRaw;

                let listingId: string;
                let outcome: UpsertSuccess['outcome'];

                if (existing === null) {
                    // Unchecked input: mutable carries the scalar FK sellerId,
                    // which the checked CreateInput only exposes via connect.
                    // Required columns are re-asserted after the spread (the
                    // optional-prop spread types them `| undefined`).
                    const createData: Prisma.ListingUncheckedCreateInput = {
                        ...identity,
                        ...mutable,
                        canonicalUrl: snap.canonicalUrl,
                        title: snap.title,
                        currency: snap.currency,
                        locationRaw: snap.locationRaw,
                        status: 'ACTIVE',
                        missedRunCount: 0,
                        firstSeenAt: now,
                        lastSeenAt: now,
                        firstSeenRunId: runId,
                        lastSeenRunId: runId,
                    };
                    const created = await tx.listing.create({ data: createData });
                    listingId = created.id;
                    outcome = 'INSERTED';
                } else {
                    // Fill-only policy: category-DERIVED guesses never overwrite
                    // values a detail crawl already provided (detail is
                    // authoritative for area/m²/location parts). Fresh category
                    // data (title, price, dates) always updates.
                    if (existing.grossAreaM2 !== null) delete mutable.grossAreaM2;
                    if (existing.pricePerSquareMeter !== null) delete mutable.pricePerSquareMeter;
                    if (existing.district !== null) delete mutable.district;
                    if (existing.neighborhood !== null) delete mutable.neighborhood;
                    const changed = mutableFieldsChanged(existing, mutable);
                    outcome = decideOutcome(
                        { price: existing.price, currency: existing.currency },
                        { price: snap.price, currency: snap.currency },
                        changed,
                    );
                    const updateData: Prisma.ListingUncheckedUpdateInput = {
                        ...mutable,
                        // every observation resurrects + re-stamps
                        status: 'ACTIVE',
                        missedRunCount: 0,
                        lastSeenAt: now,
                        lastSeenRunId: runId,
                    };
                    await tx.listing.update({ where: { id: existing.id }, data: updateData });
                    listingId = existing.id;
                    if (outcome === 'PRICE_CHANGED' && snap.price !== null) {
                        await tx.listingPriceHistory.create({
                            data: {
                                listingId,
                                price: snap.price,
                                currency: snap.currency,
                                pricePerSquareMeter: snap.pricePerSquareMeter,
                                runId,
                            },
                        });
                    }
                }

                if (snap.coverImageUrl !== null) {
                    await tx.listingImage.upsert({
                        where: { listingId_url: { listingId, url: snap.coverImageUrl } },
                        create: { listingId, url: snap.coverImageUrl, position: 0, isPrimary: true, firstSeenAt: now, lastSeenAt: now },
                        // existing row: refresh sighting only — detail crawls own position/isPrimary
                        update: { lastSeenAt: now },
                    });
                }

                await writeObservation(tx, runId, listingId, outcome, now);
                return { sourceListingId: snap.sourceListingId, listingId, outcome };
            });
        } catch (err) {
            throw wrapDbError(err, `category upsert failed for listing ${snap.sourceListingId}`);
        }
    }

    async upsertCategoryListings(items: CategoryListing[], runId: string): Promise<BatchUpsertResult> {
        const results: UpsertSuccess[] = [];
        const errors: UpsertItemError[] = [];
        const counts = emptyCounts();
        for (const item of items) {
            try {
                const success = await this.upsertCategoryListing(item, runId);
                results.push(success);
                tally(counts, success.outcome);
            } catch (err) {
                errors.push(toItemError(item?.id ?? null, err));
            }
        }
        return { results, errors, counts };
    }

    // ------------------------------------------------------------------
    // Detail path
    // ------------------------------------------------------------------

    async upsertDetailListing(detail: ListingDetail, runId: string): Promise<UpsertSuccess> {
        const snap = mapDetailListing(detail);
        if (snap === null) {
            throw new CrawlError('DATABASE', 'detail record has no usable listingId (null/empty) — cannot upsert');
        }
        try {
            return await this.prisma.$transaction(async (tx) => {
                const now = new Date();
                const identity = { source: snap.source, sourceListingId: snap.sourceListingId };
                const existing = await tx.listing.findUnique({
                    where: { source_sourceListingId: identity },
                });

                // Explicit unavailability signal -> REMOVED immediately (never
                // inferred from absence; see applySuccessfulRunStaleness).
                if (detail.unavailable) {
                    return await this.handleUnavailable(tx, identity, snap, existing, runId, now);
                }

                const sellerId = snap.seller !== null ? await this.upsertSeller(tx, snap.source, snap.seller, now) : null;

                // Detail is the authoritative full snapshot: overwrite every
                // mapped field (category-merged values fill detail nulls).
                const mutable: ListingMutableData = {
                    canonicalUrl: snap.canonicalUrl,
                    title: snap.title,
                    description: snap.description,
                    price: snap.price,
                    currency: snap.currency,
                    pricePerSquareMeter: snap.pricePerSquareMeter,
                    listingType: snap.listingType,
                    propertyCategory: snap.propertyCategory,
                    propertySubtype: snap.propertySubtype,
                    grossAreaM2: snap.grossAreaM2,
                    netAreaM2: snap.netAreaM2,
                    rooms: snap.rooms,
                    buildingAge: snap.buildingAge,
                    floor: snap.floor,
                    totalFloors: snap.totalFloors,
                    heating: snap.heating,
                    bathroomCount: snap.bathroomCount,
                    balcony: snap.balcony,
                    furnished: snap.furnished,
                    usageStatus: snap.usageStatus,
                    insideSite: snap.insideSite,
                    siteName: snap.siteName,
                    dues: snap.dues,
                    deposit: snap.deposit,
                    deedStatus: snap.deedStatus,
                    creditEligible: snap.creditEligible,
                    exchangeEligible: snap.exchangeEligible,
                    province: snap.province,
                    district: snap.district,
                    neighborhood: snap.neighborhood,
                    locationRaw: snap.locationRaw,
                    listingDate: snap.listingDate,
                    listingDateRaw: snap.listingDateRaw,
                    updatedDate: snap.updatedDate,
                    updatedDateRaw: snap.updatedDateRaw,
                    publicContactPhone: snap.publicContactPhone,
                    videoUrl: snap.videoUrl,
                    virtualTourUrl: snap.virtualTourUrl,
                    // denormalized mirror, kept in sync with Seller.type on every detail write
                    sellerType: snap.sellerType,
                };
                if (sellerId !== null) mutable.sellerId = sellerId;

                let listingId: string;
                let outcome: UpsertSuccess['outcome'];

                if (existing === null) {
                    const createData: Prisma.ListingUncheckedCreateInput = {
                        ...identity,
                        ...mutable,
                        // required columns re-asserted (optional-prop spread types them `| undefined`)
                        canonicalUrl: snap.canonicalUrl,
                        title: snap.title,
                        description: snap.description,
                        currency: snap.currency,
                        locationRaw: snap.locationRaw,
                        status: 'ACTIVE',
                        missedRunCount: 0,
                        firstSeenAt: now,
                        lastSeenAt: now,
                        firstSeenRunId: runId,
                        lastSeenRunId: runId,
                    };
                    const created = await tx.listing.create({ data: createData });
                    listingId = created.id;
                    outcome = 'INSERTED';
                } else {
                    const changed = mutableFieldsChanged(existing, mutable);
                    outcome = decideOutcome(
                        { price: existing.price, currency: existing.currency },
                        { price: snap.price, currency: snap.currency },
                        changed,
                    );
                    const updateData: Prisma.ListingUncheckedUpdateInput = {
                        ...mutable,
                        status: 'ACTIVE',
                        missedRunCount: 0,
                        lastSeenAt: now,
                        lastSeenRunId: runId,
                    };
                    await tx.listing.update({ where: { id: existing.id }, data: updateData });
                    listingId = existing.id;
                    if (outcome === 'PRICE_CHANGED' && snap.price !== null) {
                        await tx.listingPriceHistory.create({
                            data: {
                                listingId,
                                price: snap.price,
                                currency: snap.currency,
                                pricePerSquareMeter: snap.pricePerSquareMeter,
                                runId,
                            },
                        });
                    }
                }

                // Replace-refresh images: upsert each by (listingId, url),
                // refreshing position/isPrimary/lastSeenAt.
                for (const image of snap.images) {
                    await tx.listingImage.upsert({
                        where: { listingId_url: { listingId, url: image.url } },
                        create: {
                            listingId,
                            url: image.url,
                            position: image.position,
                            isPrimary: image.isPrimary,
                            firstSeenAt: now,
                            lastSeenAt: now,
                        },
                        update: { position: image.position, isPrimary: image.isPrimary, lastSeenAt: now },
                    });
                }

                // Refresh attributes: upsert each key, updating value + lastSeenAt.
                for (const attribute of snap.attributes) {
                    await tx.listingAttribute.upsert({
                        where: { listingId_key: { listingId, key: attribute.key } },
                        create: { listingId, key: attribute.key, value: attribute.value, firstSeenAt: now, lastSeenAt: now },
                        update: { value: attribute.value, lastSeenAt: now },
                    });
                }

                await writeObservation(tx, runId, listingId, outcome, now);
                return { sourceListingId: snap.sourceListingId, listingId, outcome };
            });
        } catch (err) {
            throw wrapDbError(err, `detail upsert failed for listing ${snap.sourceListingId}`);
        }
    }

    async upsertDetailListings(details: ListingDetail[], runId: string): Promise<BatchUpsertResult> {
        const results: UpsertSuccess[] = [];
        const errors: UpsertItemError[] = [];
        const counts = emptyCounts();
        for (const detail of details) {
            try {
                const success = await this.upsertDetailListing(detail, runId);
                results.push(success);
                tally(counts, success.outcome);
            } catch (err) {
                errors.push(toItemError(detail?.listingId ?? null, err));
            }
        }
        return { results, errors, counts };
    }

    // ------------------------------------------------------------------
    // Observations / removal / staleness
    // ------------------------------------------------------------------

    async markRunObservations(
        runId: string,
        pairs: Array<{ listingId: string; outcome: UpsertSuccess['outcome'] }>,
    ): Promise<void> {
        try {
            await this.prisma.$transaction(async (tx) => {
                for (const pair of pairs) {
                    await tx.scanRunListing.upsert({
                        where: { runId_listingId: { runId, listingId: pair.listingId } },
                        create: { runId, listingId: pair.listingId, outcome: pair.outcome },
                        update: { outcome: pair.outcome },
                    });
                }
                await tx.listingSeenHistory.createMany({
                    data: pairs.map((pair) => ({ runId, listingId: pair.listingId })),
                });
            });
        } catch (err) {
            throw wrapDbError(err, `markRunObservations failed for run ${runId}`);
        }
    }

    async markRemoved(listingId: string): Promise<boolean> {
        try {
            const result = await this.prisma.listing.updateMany({
                where: { id: listingId, status: { not: 'REMOVED' } },
                data: { status: 'REMOVED' },
            });
            return result.count > 0;
        } catch (err) {
            throw wrapDbError(err, `markRemoved failed for listing ${listingId}`);
        }
    }

    async deleteByIds(ids: string[]): Promise<number> {
        const unique = [...new Set(ids.filter((id) => id.length > 0))];
        if (unique.length === 0) return 0;
        try {
            const result = await this.prisma.listing.deleteMany({ where: { id: { in: unique } } });
            return result.count;
        } catch (err) {
            throw wrapDbError(err, `deleteByIds failed for ${unique.length} ids`);
        }
    }

    async applySuccessfulRunStaleness(
        scanDefinitionId: string,
        runId: string,
    ): Promise<{ staleMarked: number; resurrected: number }> {
        try {
            const scan = await this.prisma.scanDefinition.findUnique({
                where: { id: scanDefinitionId },
                select: { staleDetectionEnabled: true, staleAfterSuccessfulRuns: true },
            });
            if (scan === null || !scan.staleDetectionEnabled) return { staleMarked: 0, resurrected: 0 };

            const run = await this.prisma.scanRun.findUnique({
                where: { id: runId },
                select: { scanDefinitionId: true, status: true, configurationSnapshot: true },
            });
            // Only THIS scan's non-incremental SUCCEEDED runs count.
            if (run === null || run.scanDefinitionId !== scanDefinitionId) return { staleMarked: 0, resurrected: 0 };
            if (run.status !== 'SUCCEEDED' || isIncrementalSnapshot(run.configurationSnapshot)) {
                return { staleMarked: 0, resurrected: 0 };
            }

            const presentLinks = await this.prisma.scanRunListing.findMany({
                where: { runId },
                select: { listingId: true },
            });
            const present = new Set(presentLinks.map((link) => link.listingId));

            // Resurrection backstop — the upsert paths already resurrect on
            // observation, so this is normally a no-op.
            const resurrected = await this.prisma.listing.updateMany({
                where: { id: { in: [...present] }, status: 'STALE' },
                data: { status: 'ACTIVE', missedRunCount: 0 },
            });

            // Expected = seen by ANY previous SUCCEEDED non-incremental run of this scan.
            const previousRuns = await this.prisma.scanRun.findMany({
                where: { scanDefinitionId, status: 'SUCCEEDED', id: { not: runId } },
                select: { id: true, configurationSnapshot: true },
            });
            const previousRunIds = previousRuns
                .filter((candidate) => !isIncrementalSnapshot(candidate.configurationSnapshot))
                .map((candidate) => candidate.id);

            let expected = new Set<string>();
            if (previousRunIds.length > 0) {
                const previousLinks = await this.prisma.scanRunListing.findMany({
                    where: { runId: { in: previousRunIds } },
                    select: { listingId: true },
                });
                expected = new Set(previousLinks.map((link) => link.listingId));
            }

            const absent = [...expected].filter((listingId) => !present.has(listingId));
            if (absent.length === 0) return { staleMarked: 0, resurrected: resurrected.count };

            // REMOVED rows are terminal (explicit signal) — never touched here.
            await this.prisma.listing.updateMany({
                where: { id: { in: absent }, status: { not: 'REMOVED' } },
                data: { missedRunCount: { increment: 1 } },
            });
            // Threshold-gated: a single absence NEVER marks stale (default 3).
            const stale = await this.prisma.listing.updateMany({
                where: {
                    id: { in: absent },
                    status: 'ACTIVE',
                    missedRunCount: { gte: scan.staleAfterSuccessfulRuns },
                },
                data: { status: 'STALE' },
            });
            return { staleMarked: stale.count, resurrected: resurrected.count };
        } catch (err) {
            throw wrapDbError(err, `staleness evaluation failed for run ${runId}`);
        }
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    async listWithDerived(
        filters: ListingFilters,
        page: number,
        pageSize: number,
        sort: ListingSort = { field: 'lastSeenAt', direction: 'desc' },
    ): Promise<ListingListResult> {
        const where: Prisma.ListingWhereInput = listingWhere(filters);
        const orderBy: Prisma.ListingOrderByWithRelationInput = SORTABLE_NULLABLE.has(sort.field)
            ? { [sort.field]: { sort: sort.direction, nulls: 'last' } }
            : { [sort.field]: sort.direction };

        const safePage = Math.max(1, page);
        const safePageSize = Math.min(Math.max(1, pageSize), 200);

        const [total, rows] = await this.prisma.$transaction([
            this.prisma.listing.count({ where }),
            this.prisma.listing.findMany({
                where,
                orderBy,
                skip: (safePage - 1) * safePageSize,
                take: safePageSize,
                include: {
                    seller: true,
                    // last 2 price rows feed the derived fields — computed in JS, no raw SQL
                    priceHistory: { orderBy: { changedAt: 'desc' }, take: 2 },
                    // primary image drives the UI thumbnail column
                    images: { where: { isPrimary: true }, take: 1, select: { url: true } },
                },
            }),
        ]);

        return {
            rows: rows.map((row) => {
                const historyPoints = row.priceHistory.map((h) => ({ price: h.price, changedAt: h.changedAt }));
                return {
                    ...toListingRecord(row),
                    seller: row.seller !== null ? toSellerRecord(row.seller) : null,
                    priceChanged: computePriceChanged(row.priceHistory.length),
                    latestPriceChangePercent: computeLatestPriceChangePercent(historyPoints),
                    thumbnailUrl: row.images[0]?.url ?? null,
                };
            }),
            total,
            page: safePage,
            pageSize: safePageSize,
        };
    }

    async listFacets(filters: ListingFilters): Promise<ListingFacets> {
        const empty: ListingFacets = {
            province: [],
            district: [],
            neighborhood: [],
            listingType: [],
            propertyCategory: [],
            propertySubtype: [],
            rooms: [],
            heating: [],
            buildingAge: [],
            floor: [],
            bathroomCount: [],
            balcony: [],
            furnished: [],
            usageStatus: [],
            insideSite: [],
            creditEligible: [],
            exchangeEligible: [],
        };
        const entries = await Promise.all(
            FACET_COLUMNS.map(async (column: FacetColumn) => {
                const where = listingWhere(filters, new Set([column]));
                const groups = await this.prisma.listing.groupBy({
                    by: [column],
                    where: { AND: [where, { [column]: { not: null } }] },
                    _count: { _all: true },
                });
                const values = groups
                    .map((row) => ({
                        value: row[column],
                        count: row._count._all,
                    }))
                    .filter((row): row is { value: string; count: number } => typeof row.value === 'string' && row.value !== '')
                    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, 'tr'))
                    .slice(0, 80)
                    .map((row) => row.value);
                return [column, values] as const;
            }),
        );
        return { ...empty, ...Object.fromEntries(entries) };
    }

    async getById(id: string): Promise<ListingDetailRecord | null> {
        const row = await this.prisma.listing.findUnique({
            where: { id },
            include: {
                seller: true,
                images: { orderBy: [{ position: 'asc' }, { firstSeenAt: 'asc' }] },
                attributes: { orderBy: { key: 'asc' } },
                priceHistory: { orderBy: { changedAt: 'desc' } },
                seenHistory: { orderBy: { seenAt: 'desc' }, take: 50 },
                runLinks: {
                    orderBy: { run: { createdAt: 'desc' } },
                    include: { run: { select: { id: true, scanDefinitionId: true, status: true, createdAt: true } } },
                },
            },
        });
        if (row === null) return null;
        return {
            ...toListingRecord(row),
            seller: row.seller !== null ? toSellerRecord(row.seller) : null,
            images: row.images.map(toImageRecord),
            attributes: row.attributes.map(toAttributeRecord),
            priceHistory: row.priceHistory.map(toPriceHistoryRecord),
            seenHistory: row.seenHistory.map(toSeenRecord),
            runLinks: row.runLinks.map(toRunLinkRecord),
        };
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /** detail.unavailable === true: REMOVED immediately, observation still journaled. */
    private async handleUnavailable(
        tx: Prisma.TransactionClient,
        identity: { source: string; sourceListingId: string },
        snap: DetailSnapshot,
        existing: Listing | null,
        runId: string,
        now: Date,
    ): Promise<UpsertSuccess> {
        let listingId: string;
        let outcome: UpsertSuccess['outcome'];
        if (existing === null) {
            // First sighting is already a removal notice — record a minimal
            // REMOVED row so the signal is not lost (engine normally filters
            // these out before persistence; this path is defensive).
            const created = await tx.listing.create({
                data: {
                    ...identity,
                    canonicalUrl: snap.canonicalUrl,
                    title: snap.title,
                    status: 'REMOVED',
                    missedRunCount: 0,
                    firstSeenAt: now,
                    lastSeenAt: now,
                    firstSeenRunId: runId,
                    lastSeenRunId: runId,
                },
            });
            listingId = created.id;
            outcome = 'INSERTED';
        } else {
            await tx.listing.update({
                where: { id: existing.id },
                data: { status: 'REMOVED', lastSeenAt: now, lastSeenRunId: runId },
            });
            listingId = existing.id;
            outcome = existing.status === 'REMOVED' ? 'UNCHANGED' : 'UPDATED';
        }
        await writeObservation(tx, runId, listingId, outcome, now);
        return { sourceListingId: snap.sourceListingId, listingId, outcome };
    }

    /**
     * Seller identity = (source, profileUrl) with '' as the null sentinel.
     * Name/phone fields on the sentinel row are last-writer-wins (documented
     * in schema.prisma). Returns the seller id.
     */
    private async upsertSeller(
        tx: Prisma.TransactionClient,
        source: string,
        snap: DetailSellerSnapshot,
        now: Date,
    ): Promise<string> {
        const profileUrl = snap.profileUrl ?? '';
        const seller = await tx.seller.upsert({
            where: { source_profileUrl: { source, profileUrl } },
            create: {
                source,
                profileUrl,
                type: asSellerType(snap.type),
                typeEvidence: snap.typeEvidence,
                displayName: snap.displayName,
                officeName: snap.officeName,
                publicContactPhone: snap.publicContactPhone,
                firstSeenAt: now,
                lastSeenAt: now,
            },
            update: {
                type: asSellerType(snap.type),
                // evidence follows the classifier contract (null when UNKNOWN) — null clears
                typeEvidence: snap.typeEvidence,
                // identity fields only overwrite when the page actually carried them
                ...(snap.displayName !== null ? { displayName: snap.displayName } : {}),
                ...(snap.officeName !== null ? { officeName: snap.officeName } : {}),
                ...(snap.publicContactPhone !== null ? { publicContactPhone: snap.publicContactPhone } : {}),
                lastSeenAt: now,
            },
        });
        return seller.id;
    }
}

/** Seen-history + run-link journal — written for EVERY observation. */
async function writeObservation(
    tx: Prisma.TransactionClient,
    runId: string,
    listingId: string,
    outcome: UpsertSuccess['outcome'],
    now: Date,
): Promise<void> {
    await tx.listingSeenHistory.create({ data: { runId, listingId, seenAt: now } });
    await tx.scanRunListing.upsert({
        where: { runId_listingId: { runId, listingId } },
        create: { runId, listingId, outcome },
        update: { outcome },
    });
}

/** All persistence failures cross the boundary as CrawlError('DATABASE'). */
function wrapDbError(err: unknown, context: string): CrawlError {
    if (err instanceof CrawlError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new CrawlError('DATABASE', `${context}: ${message}`, err);
}
