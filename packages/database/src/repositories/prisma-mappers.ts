/**
 * Prisma row -> DTO mappers. The ONLY place (besides the repositories) that
 * touches generated model types; everything crossing the package boundary is
 * a plain interface from interfaces.ts.
 */
import type {
    Listing,
    ListingAttribute,
    ListingImage,
    ListingPriceHistory,
    ListingSeenHistory,
    Prisma,
    ScanDefinition,
    ScanRun,
    ScanRunEvent,
    ScanRunListing,
    Seller,
} from '@prisma/client';
import type {
    ListingAttributeRecord,
    ListingImageRecord,
    ListingPriceHistoryRecord,
    ListingRecord,
    ListingRunLinkRecord,
    ListingSeenRecord,
    RunEventRecord,
    RunRecord,
    ScanRecord,
    SellerRecord,
} from './interfaces.js';

export function asStringArray(value: Prisma.JsonValue): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function toListingRecord(row: Listing): ListingRecord {
    return {
        id: row.id,
        source: row.source,
        sourceListingId: row.sourceListingId,
        canonicalUrl: row.canonicalUrl,
        title: row.title,
        description: row.description,
        status: row.status,
        price: row.price,
        currency: row.currency,
        pricePerSquareMeter: row.pricePerSquareMeter,
        listingType: row.listingType,
        propertyCategory: row.propertyCategory,
        propertySubtype: row.propertySubtype,
        grossAreaM2: row.grossAreaM2,
        netAreaM2: row.netAreaM2,
        rooms: row.rooms,
        buildingAge: row.buildingAge,
        floor: row.floor,
        totalFloors: row.totalFloors,
        heating: row.heating,
        bathroomCount: row.bathroomCount,
        balcony: row.balcony,
        furnished: row.furnished,
        usageStatus: row.usageStatus,
        insideSite: row.insideSite,
        siteName: row.siteName,
        dues: row.dues,
        deposit: row.deposit,
        deedStatus: row.deedStatus,
        creditEligible: row.creditEligible,
        exchangeEligible: row.exchangeEligible,
        province: row.province,
        district: row.district,
        neighborhood: row.neighborhood,
        locationRaw: row.locationRaw,
        listingDate: row.listingDate,
        listingDateRaw: row.listingDateRaw,
        updatedDate: row.updatedDate,
        updatedDateRaw: row.updatedDateRaw,
        publicContactPhone: row.publicContactPhone,
        videoUrl: row.videoUrl,
        virtualTourUrl: row.virtualTourUrl,
        sellerId: row.sellerId,
        sellerType: row.sellerType,
        missedRunCount: row.missedRunCount,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        firstSeenRunId: row.firstSeenRunId,
        lastSeenRunId: row.lastSeenRunId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export function toSellerRecord(row: Seller): SellerRecord {
    return {
        id: row.id,
        source: row.source,
        type: row.type,
        typeEvidence: row.typeEvidence,
        displayName: row.displayName,
        officeName: row.officeName,
        // '' sentinel -> null at the boundary (see schema header note)
        profileUrl: row.profileUrl === '' ? null : row.profileUrl,
        publicContactPhone: row.publicContactPhone,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export function toImageRecord(row: ListingImage): ListingImageRecord {
    return {
        id: row.id,
        url: row.url,
        position: row.position,
        isPrimary: row.isPrimary,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
    };
}

export function toAttributeRecord(row: ListingAttribute): ListingAttributeRecord {
    return { id: row.id, key: row.key, value: row.value, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt };
}

export function toPriceHistoryRecord(row: ListingPriceHistory): ListingPriceHistoryRecord {
    return {
        id: row.id,
        price: row.price,
        currency: row.currency,
        pricePerSquareMeter: row.pricePerSquareMeter,
        runId: row.runId,
        changedAt: row.changedAt,
    };
}

export function toSeenRecord(row: ListingSeenHistory): ListingSeenRecord {
    return { id: row.id, runId: row.runId, seenAt: row.seenAt };
}

export function toRunLinkRecord(
    row: ScanRunListing & { run: Pick<ScanRun, 'id' | 'scanDefinitionId' | 'status' | 'createdAt'> },
): ListingRunLinkRecord {
    return {
        runId: row.runId,
        outcome: row.outcome,
        run: {
            id: row.run.id,
            scanDefinitionId: row.run.scanDefinitionId,
            status: row.run.status,
            createdAt: row.run.createdAt,
        },
    };
}

export function toRunRecord(row: ScanRun): RunRecord {
    return {
        id: row.id,
        scanDefinitionId: row.scanDefinitionId,
        status: row.status,
        trigger: row.trigger,
        configurationSnapshot: row.configurationSnapshot,
        counters: {
            pagesVisited: row.pagesVisited,
            categoryPagesVisited: row.categoryPagesVisited,
            detailPagesVisited: row.detailPagesVisited,
            itemsDiscovered: row.itemsDiscovered,
            itemsInserted: row.itemsInserted,
            itemsUpdated: row.itemsUpdated,
            pricesChanged: row.pricesChanged,
            failedRequests: row.failedRequests,
            retryCount: row.retryCount,
        },
        errorSummary: row.errorSummary,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        heartbeatAt: row.heartbeatAt,
        createdAt: row.createdAt,
    };
}

export function toEventRecord(row: ScanRunEvent): RunEventRecord {
    return {
        // BigInt -> decimal string: JSON-safe and directly usable as SSE Last-Event-ID.
        id: row.id.toString(),
        runId: row.runId,
        type: row.type,
        data: row.data,
        createdAt: row.createdAt,
    };
}

export function toScanRecord(row: ScanDefinition): ScanRecord {
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        enabled: row.enabled,
        startUrls: asStringArray(row.startUrls),
        schedule: row.schedule,
        timezone: row.timezone,
        maxItems: row.maxItems,
        maxPages: row.maxPages,
        includeDetails: row.includeDetails,
        incrementalMode: row.incrementalMode,
        maxConcurrency: row.maxConcurrency,
        navigationTimeoutSeconds: row.navigationTimeoutSeconds,
        requestHandlerTimeoutSeconds: row.requestHandlerTimeoutSeconds,
        maxRequestRetries: row.maxRequestRetries,
        delayMinMs: row.delayMinMs,
        delayMaxMs: row.delayMaxMs,
        browserMode: row.browserMode,
        cdpUrl: row.cdpUrl,
        proxyProfileId: row.proxyProfileId,
        cookieProfileId: row.cookieProfileId,
        sessionPolicyId: row.sessionPolicyId,
        debugMode: row.debugMode,
        storeRawHtml: row.storeRawHtml,
        storeScreenshotsOnFailure: row.storeScreenshotsOnFailure,
        staleDetectionEnabled: row.staleDetectionEnabled,
        staleAfterSuccessfulRuns: row.staleAfterSuccessfulRuns,
        allowedDomains: asStringArray(row.allowedDomains),
        humanInTheLoop: row.humanInTheLoop,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}
