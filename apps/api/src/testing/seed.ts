/**
 * Test seeding helpers — create scans/runs/listings through the REPOSITORIES
 * (the same write paths the worker uses) and register rows for cleanup.
 */
import { randomUUID } from 'node:crypto';
import type { ListingDetail, SellerType } from '@sahibindenbot/shared';
import type { TestAppContext } from './test-app.js';
import { uniqueName } from './test-app.js';

export function shortId(): string {
    return randomUUID().slice(0, 8);
}

/** Scan row straight from the repository (no queue interaction). */
export async function seedScan(ctx: TestAppContext, overrides: Record<string, unknown> = {}): Promise<string> {
    const scan = await ctx.app.db.repos.scans.create({
        name: uniqueName('seed-scan'),
        startUrls: ['https://www.sahibinden.com/satilik-daire/adana-seyhan'],
        ...overrides,
    });
    ctx.track.scanIds.push(scan.id);
    return scan.id;
}

/** Run row (QUEUED, empty snapshot) — no BullMQ job is enqueued. */
export async function seedRun(ctx: TestAppContext, scanId: string): Promise<string> {
    const run = await ctx.app.db.repos.runs.createRun(scanId, 'MANUAL', { seed: true });
    return run.id;
}

export interface DetailOverrides extends Partial<ListingDetail> {
    sellerType?: SellerType;
}

/** Minimal valid ListingDetail; every field overridable. */
export function makeDetail(sourceListingId: string, overrides: DetailOverrides = {}): ListingDetail {
    return {
        listingId: sourceListingId,
        canonicalUrl: `https://www.sahibinden.com/ilan/${sourceListingId}`,
        source: 'sahibinden.com',
        sourceUrl: `https://www.sahibinden.com/ilan/${sourceListingId}`,
        scrapedAt: new Date().toISOString(),
        title: `Listing ${sourceListingId}`,
        description: `Description for ${sourceListingId}`,
        price: 1_000_000,
        currency: 'TL',
        priceRaw: '1.000.000 TL',
        pricePerSquareMeter: 10_000,
        listingType: 'SALE',
        propertyCategory: 'Konut',
        propertySubtype: 'Daire',
        grossAreaM2: 100,
        netAreaM2: 90,
        rooms: '2+1',
        buildingAge: '5',
        floor: '3',
        totalFloors: '10',
        heating: 'Kombi (Doğalgaz)',
        bathroomCount: '1',
        balcony: 'Var',
        furnished: 'Hayır',
        usageStatus: 'Boş',
        insideSite: 'Hayır',
        siteName: null,
        dues: null,
        deposit: null,
        deedStatus: null,
        creditEligible: null,
        exchangeEligible: null,
        province: 'İstanbul',
        district: 'Kadıköy',
        neighborhood: 'Moda',
        locationRaw: 'İstanbul / Kadıköy / Moda',
        listingDate: null,
        listingDateRaw: null,
        updatedDate: null,
        updatedDateRaw: null,
        sellerType: 'OWNER',
        sellerTypeEvidence: 'Sahibinden',
        sellerDisplayName: `Seller ${sourceListingId}`,
        officeName: null,
        // Distinct profile URL per listing → distinct seller rows.
        sellerProfileUrl: `https://www.sahibinden.com/uye/${sourceListingId}`,
        publicContactPhone: null,
        images: [],
        videoUrl: null,
        virtualTourUrl: null,
        attributesRaw: {},
        unavailable: false,
        ...overrides,
    };
}

/** Upserts a detail listing via the repository and tracks listing + seller rows. */
export async function seedDetailListing(
    ctx: TestAppContext,
    runId: string,
    sourceListingId: string,
    overrides: DetailOverrides = {},
): Promise<string> {
    const result = await ctx.app.db.repos.listings.upsertDetailListing(makeDetail(sourceListingId, overrides), runId);
    ctx.track.listingIds.push(result.listingId);
    const row = await ctx.app.db.prisma.listing.findUnique({ where: { id: result.listingId }, select: { sellerId: true } });
    if (row?.sellerId != null && !ctx.track.sellerIds.includes(row.sellerId)) {
        ctx.track.sellerIds.push(row.sellerId);
    }
    return result.listingId;
}
