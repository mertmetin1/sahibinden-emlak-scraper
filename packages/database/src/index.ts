/**
 * @sahibindenbot/database — public API.
 *
 * Only package allowed to import @prisma/client. Consumers use:
 *   - createDatabaseClient() for wiring (repos.listings / repos.runs / repos.scans)
 *   - PrismaOutputRepository for the engine's OutputRepository port
 *   - pure helpers (decideOutcome, computeLatestPriceChangePercent, mappers)
 *     for tests and reuse
 */
export * from './repositories/interfaces.js';
export { decideOutcome, isPriceChange } from './repositories/outcome.js';
export type { PricePoint } from './repositories/outcome.js';
export { computeLatestPriceChangePercent, computePriceChanged } from './repositories/derived.js';
export type { PriceHistoryPoint } from './repositories/derived.js';
export {
    DEFAULT_SOURCE,
    mapCategoryListing,
    mapDetailListing,
    parseIsoDate,
    parseTrInt,
    parseTurkishDate,
    splitCategoryLocation,
} from './repositories/mappers.js';
export type { CategorySnapshot, DetailSellerSnapshot, DetailSnapshot } from './repositories/mappers.js';
export { PrismaListingRepository } from './repositories/prisma-listing-repository.js';
export { PrismaRunRepository } from './repositories/prisma-run-repository.js';
export { PrismaScanRepository } from './repositories/prisma-scan-repository.js';
export { PrismaProxyProfileRepository } from './repositories/prisma-proxy-profile-repository.js';
export { PrismaCookieProfileRepository } from './repositories/prisma-cookie-profile-repository.js';
export { PrismaSessionPolicyRepository } from './repositories/prisma-session-policy-repository.js';
export { PrismaOutputRepository } from './adapters/prisma-output-repository.js';
export { createDatabaseClient } from './client.js';
export type { DatabaseClient, DatabaseRepositories } from './client.js';
