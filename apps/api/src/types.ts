/**
 * Derived DTO types for the profile repositories.
 *
 * GAP WORKAROUND: @sahibindenbot/database's package index re-exports the
 * repository CLASSES but not their DTO interfaces (ProxyEndpointRecord,
 * CookieProfileMetadata, … live unexported beside the classes). The boundary
 * rules forbid editing packages/database from here, so these types are
 * derived from the class method signatures instead — always in sync with the
 * repository by construction.
 */
import type { PrismaCookieProfileRepository, PrismaProxyProfileRepository } from '@sahibindenbot/database';

export type ProxyProfileRecordDto = Awaited<ReturnType<PrismaProxyProfileRepository['createProfile']>>;
export type ProxyProfileDetailDto = NonNullable<Awaited<ReturnType<PrismaProxyProfileRepository['getProfile']>>>;
export type ProxyEndpointRecordDto = ProxyProfileDetailDto['endpoints'][number];

export type CookieProfileMetadataDto = Awaited<ReturnType<PrismaCookieProfileRepository['listProfiles']>>[number];
export type CookieProfileDetailDto = NonNullable<Awaited<ReturnType<PrismaCookieProfileRepository['getProfile']>>>;
