/**
 * Pure mapping helpers: shared contract types -> persistence field sets.
 *
 * No @prisma/client imports here — the returned shapes are plain data the
 * Prisma repository feeds into create/update calls.
 *
 * NOTE: the small Turkish number/date parsers below intentionally duplicate
 * parser-sahibinden logic. The dependency rules (ARCHITECTURE §2.2) forbid
 * database -> parser-sahibinden imports, and category rows arrive with raw
 * Turkish strings ("14 Eylül 2026", "4.749.000 TL") that must be normalized
 * at the persistence boundary.
 */
import type { CategoryListing, ListingDetail } from '@sahibindenbot/shared';

/** Default Listing.source — matches the Prisma column default. */
export const DEFAULT_SOURCE = 'sahibinden.com';

// ---------------------------------------------------------------------------
// Turkish raw-string normalization (local, minimal — see header note)
// ---------------------------------------------------------------------------

/**
 * Integer extraction from Turkish-formatted strings: dots are thousands
 * separators, everything non-numeric is dropped.
 * "4.749.000 TL" -> 4749000 · "59.363 TL/m²" -> 59363 · "80" -> 80.
 * Integer-only by design: m² and TL/m² are integral on the site.
 */
export function parseTrInt(raw: string | null | undefined): number | null {
    if (!raw) return null;
    const digits = raw.replace(/[^\d-]/g, '');
    if (digits === '' || digits === '-') return null;
    const n = Number.parseInt(digits, 10);
    return Number.isFinite(n) ? n : null;
}

const TR_MONTHS: Readonly<Record<string, number>> = {
    ocak: 0,
    şubat: 1,
    mart: 2,
    nisan: 3,
    mayıs: 4,
    haziran: 5,
    temmuz: 6,
    ağustos: 7,
    eylül: 8,
    ekim: 9,
    kasım: 10,
    aralık: 11,
};

/** "14 Eylül 2026" -> Date (UTC midnight). Null when unparseable. */
export function parseTurkishDate(raw: string | null | undefined): Date | null {
    if (!raw) return null;
    const match = /^(\d{1,2})\s+(\S+)\s+(\d{4})$/.exec(raw.trim().toLocaleLowerCase('tr-TR'));
    if (!match) return null;
    const day = Number(match[1]);
    const month = TR_MONTHS[match[2] ?? ''];
    const year = Number(match[3]);
    if (month === undefined || !Number.isInteger(day) || day < 1 || day > 31) return null;
    return new Date(Date.UTC(year, month, day));
}

/** ISO string -> Date, null on null/invalid input. */
export function parseIsoDate(raw: string | null | undefined): Date | null {
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Category-row location strings carry NO province — shapes observed in the
 * wild: "Beylikdüzü / Gürpınar" (district / neighborhood), "Esenyurt"
 * (district only), occasionally glued ("KadıköyKoşuyolu" — kept as district,
 * unparseable). Province stays null until a detail page provides it.
 */
export function splitCategoryLocation(locationRaw: string): { district: string | null; neighborhood: string | null } {
    const parts = locationRaw
        .split('/')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    if (parts.length === 0) return { district: null, neighborhood: null };
    return { district: parts[0] ?? null, neighborhood: parts[1] ?? null };
}

// ---------------------------------------------------------------------------
// CategoryListing -> Listing snapshot
// ---------------------------------------------------------------------------

/**
 * Scalar fields a CATEGORY observation may refresh. Update policy:
 *  - null values are never written (a sparse row must not erase data);
 *  - grossAreaM2 / pricePerSquareMeter / district / neighborhood are
 *    FILL-ONLY (category-derived guesses; detail crawls are authoritative
 *    and are never overwritten once present);
 *  - title / price / currency / dates / locationRaw always update (fresh
 *    category observations are the freshest data for those).
 */
export interface CategorySnapshot {
    sourceListingId: string;
    canonicalUrl: string;
    title: string;
    price: number | null;
    currency: string;
    pricePerSquareMeter: number | null;
    grossAreaM2: number | null;
    locationRaw: string;
    district: string | null;
    neighborhood: string | null;
    listingDate: Date | null;
    listingDateRaw: string | null;
    coverImageUrl: string | null;
}

/** Null when the row has no usable identity (id null/empty) — caller records an item error. */
export function mapCategoryListing(item: CategoryListing): CategorySnapshot | null {
    if (item.id === null || item.id.trim() === '') return null;
    const location = splitCategoryLocation(item.location);
    return {
        sourceListingId: item.id,
        canonicalUrl: item.url,
        title: item.title,
        price: item.price,
        currency: item.price_currency || 'TL',
        pricePerSquareMeter: parseTrInt(item.price_per_sqm),
        // Category "area" is the site-advertised m², conventionally brüt.
        grossAreaM2: parseTrInt(item.area),
        locationRaw: item.location,
        district: location.district,
        neighborhood: location.neighborhood,
        listingDate: parseTurkishDate(item.date),
        listingDateRaw: item.date !== '' ? item.date : null,
        coverImageUrl: item.image,
    };
}

// ---------------------------------------------------------------------------
// ListingDetail -> Listing snapshot (with category merge)
// ---------------------------------------------------------------------------

export interface DetailSellerSnapshot {
    /** Null profileUrl maps to the '' sentinel at the DB boundary. */
    profileUrl: string | null;
    type: string;
    typeEvidence: string | null;
    displayName: string | null;
    officeName: string | null;
    publicContactPhone: string | null;
}

export interface DetailSnapshot {
    source: string;
    sourceListingId: string;
    canonicalUrl: string;
    title: string;
    description: string;
    price: number | null;
    currency: string;
    pricePerSquareMeter: number | null;
    listingType: string | null;
    propertyCategory: string | null;
    propertySubtype: string | null;
    grossAreaM2: number | null;
    netAreaM2: number | null;
    rooms: string | null;
    buildingAge: string | null;
    floor: string | null;
    totalFloors: string | null;
    heating: string | null;
    bathroomCount: string | null;
    balcony: string | null;
    furnished: string | null;
    usageStatus: string | null;
    insideSite: string | null;
    siteName: string | null;
    dues: string | null;
    deposit: string | null;
    deedStatus: string | null;
    creditEligible: string | null;
    exchangeEligible: string | null;
    province: string | null;
    district: string | null;
    neighborhood: string | null;
    locationRaw: string;
    listingDate: Date | null;
    listingDateRaw: string | null;
    updatedDate: Date | null;
    updatedDateRaw: string | null;
    publicContactPhone: string | null;
    videoUrl: string | null;
    virtualTourUrl: string | null;
    /** Denormalized SellerType string for the Listing row. */
    sellerType: string;
    /** Null when the page carries no seller signal at all. */
    seller: DetailSellerSnapshot | null;
    images: Array<{ url: string; position: number; isPrimary: boolean }>;
    attributes: Array<{ key: string; value: string }>;
}

/**
 * Maps a detail record, merging category-row fields in wherever the detail
 * field is null (detail.category is the discovery row carried by the engine).
 * Null when the detail has no usable identity (listingId null/empty).
 */
export function mapDetailListing(detail: ListingDetail): DetailSnapshot | null {
    if (detail.listingId === null || detail.listingId.trim() === '') return null;
    const category = detail.category ? mapCategoryListing(detail.category) : null;

    const hasSellerSignal =
        detail.sellerProfileUrl !== null ||
        detail.sellerDisplayName !== null ||
        detail.officeName !== null ||
        detail.publicContactPhone !== null;

    const images =
        detail.images.length > 0
            ? detail.images.map((img) => ({ url: img.url, position: img.position, isPrimary: img.isPrimary }))
            : // Detail gallery empty — fall back to the category cover image, if any.
              category?.coverImageUrl
              ? [{ url: category.coverImageUrl, position: 0, isPrimary: true }]
              : [];

    return {
        source: detail.source || DEFAULT_SOURCE,
        sourceListingId: detail.listingId,
        canonicalUrl: detail.canonicalUrl || category?.canonicalUrl || detail.sourceUrl,
        title: detail.title || category?.title || '',
        description: detail.description,
        price: detail.price ?? category?.price ?? null,
        currency: detail.currency || category?.currency || 'TL',
        pricePerSquareMeter: detail.pricePerSquareMeter ?? category?.pricePerSquareMeter ?? null,
        listingType: detail.listingType,
        propertyCategory: detail.propertyCategory,
        propertySubtype: detail.propertySubtype,
        grossAreaM2: detail.grossAreaM2 ?? category?.grossAreaM2 ?? null,
        netAreaM2: detail.netAreaM2,
        rooms: detail.rooms,
        buildingAge: detail.buildingAge,
        floor: detail.floor,
        totalFloors: detail.totalFloors,
        heating: detail.heating,
        bathroomCount: detail.bathroomCount,
        balcony: detail.balcony,
        furnished: detail.furnished,
        usageStatus: detail.usageStatus,
        insideSite: detail.insideSite,
        siteName: detail.siteName,
        dues: detail.dues,
        deposit: detail.deposit,
        deedStatus: detail.deedStatus,
        creditEligible: detail.creditEligible,
        exchangeEligible: detail.exchangeEligible,
        province: detail.province,
        district: detail.district ?? category?.district ?? null,
        neighborhood: detail.neighborhood ?? category?.neighborhood ?? null,
        locationRaw: detail.locationRaw || category?.locationRaw || '',
        listingDate: parseIsoDate(detail.listingDate) ?? category?.listingDate ?? null,
        listingDateRaw: detail.listingDateRaw ?? category?.listingDateRaw ?? null,
        updatedDate: parseIsoDate(detail.updatedDate),
        updatedDateRaw: detail.updatedDateRaw,
        publicContactPhone: detail.publicContactPhone,
        videoUrl: detail.videoUrl,
        virtualTourUrl: detail.virtualTourUrl,
        sellerType: detail.sellerType,
        seller: hasSellerSignal
            ? {
                  profileUrl: detail.sellerProfileUrl,
                  type: detail.sellerType,
                  typeEvidence: detail.sellerTypeEvidence,
                  displayName: detail.sellerDisplayName,
                  officeName: detail.officeName,
                  publicContactPhone: detail.publicContactPhone,
              }
            : null,
        images,
        attributes: Object.entries(detail.attributesRaw).map(([key, value]) => ({ key, value })),
    };
}
