-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('ACTIVE', 'STALE', 'REMOVED');

-- CreateEnum
CREATE TYPE "SellerType" AS ENUM ('OWNER', 'REAL_ESTATE_OFFICE', 'CONSTRUCTION_COMPANY', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ScanRunStatus" AS ENUM ('QUEUED', 'STARTING', 'RUNNING', 'CANCELLING', 'CANCELLED', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "ScanTrigger" AS ENUM ('MANUAL', 'SCHEDULE', 'TEST', 'RETRY');

-- CreateEnum
CREATE TYPE "RunListingOutcome" AS ENUM ('INSERTED', 'UPDATED', 'PRICE_CHANGED', 'UNCHANGED');

-- CreateEnum
CREATE TYPE "ProxyStrategy" AS ENUM ('ROUND_ROBIN', 'SESSION_STICKY');

-- CreateEnum
CREATE TYPE "ProxyHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNHEALTHY', 'DISABLED');

-- CreateEnum
CREATE TYPE "CookieValidationStatus" AS ENUM ('UNKNOWN', 'VALID', 'EXPIRED', 'INVALID');

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'sahibinden.com',
    "sourceListingId" TEXT NOT NULL,
    "canonicalUrl" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "ListingStatus" NOT NULL DEFAULT 'ACTIVE',
    "price" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'TL',
    "pricePerSquareMeter" INTEGER,
    "listingType" TEXT,
    "propertyCategory" TEXT,
    "propertySubtype" TEXT,
    "grossAreaM2" INTEGER,
    "netAreaM2" INTEGER,
    "rooms" TEXT,
    "buildingAge" TEXT,
    "floor" TEXT,
    "totalFloors" TEXT,
    "heating" TEXT,
    "bathroomCount" TEXT,
    "balcony" TEXT,
    "furnished" TEXT,
    "usageStatus" TEXT,
    "insideSite" TEXT,
    "siteName" TEXT,
    "dues" TEXT,
    "deposit" TEXT,
    "deedStatus" TEXT,
    "creditEligible" TEXT,
    "exchangeEligible" TEXT,
    "province" TEXT,
    "district" TEXT,
    "neighborhood" TEXT,
    "locationRaw" TEXT NOT NULL DEFAULT '',
    "listingDate" TIMESTAMP(3),
    "listingDateRaw" TEXT,
    "updatedDate" TIMESTAMP(3),
    "updatedDateRaw" TEXT,
    "publicContactPhone" TEXT,
    "videoUrl" TEXT,
    "virtualTourUrl" TEXT,
    "sellerId" TEXT,
    "sellerType" TEXT,
    "missedRunCount" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "firstSeenRunId" TEXT,
    "lastSeenRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingImage" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingAttribute" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ListingAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingPriceHistory" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "pricePerSquareMeter" INTEGER,
    "runId" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingPriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingSeenHistory" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ListingSeenHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seller" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'sahibinden.com',
    "type" "SellerType" NOT NULL DEFAULT 'UNKNOWN',
    "typeEvidence" TEXT,
    "displayName" TEXT,
    "officeName" TEXT,
    "profileUrl" TEXT NOT NULL DEFAULT '',
    "publicContactPhone" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Seller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "startUrls" JSONB NOT NULL,
    "schedule" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Istanbul',
    "maxItems" INTEGER,
    "maxPages" INTEGER,
    "includeDetails" BOOLEAN NOT NULL DEFAULT false,
    "incrementalMode" BOOLEAN NOT NULL DEFAULT false,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 3,
    "navigationTimeoutSeconds" INTEGER NOT NULL DEFAULT 90,
    "requestHandlerTimeoutSeconds" INTEGER NOT NULL DEFAULT 180,
    "maxRequestRetries" INTEGER NOT NULL DEFAULT 8,
    "delayMinMs" INTEGER NOT NULL DEFAULT 2000,
    "delayMaxMs" INTEGER NOT NULL DEFAULT 5000,
    "browserMode" TEXT NOT NULL DEFAULT 'cdp',
    "cdpUrl" TEXT,
    "proxyProfileId" TEXT,
    "cookieProfileId" TEXT,
    "sessionPolicyId" TEXT,
    "debugMode" BOOLEAN NOT NULL DEFAULT false,
    "storeRawHtml" BOOLEAN NOT NULL DEFAULT false,
    "storeScreenshotsOnFailure" BOOLEAN NOT NULL DEFAULT false,
    "staleDetectionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "staleAfterSuccessfulRuns" INTEGER NOT NULL DEFAULT 3,
    "allowedDomains" JSONB NOT NULL DEFAULT '["sahibinden.com", "www.sahibinden.com"]',
    "humanInTheLoop" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScanDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanRun" (
    "id" TEXT NOT NULL,
    "scanDefinitionId" TEXT NOT NULL,
    "status" "ScanRunStatus" NOT NULL DEFAULT 'QUEUED',
    "trigger" "ScanTrigger" NOT NULL DEFAULT 'MANUAL',
    "configurationSnapshot" JSONB NOT NULL,
    "pagesVisited" INTEGER NOT NULL DEFAULT 0,
    "categoryPagesVisited" INTEGER NOT NULL DEFAULT 0,
    "detailPagesVisited" INTEGER NOT NULL DEFAULT 0,
    "itemsDiscovered" INTEGER NOT NULL DEFAULT 0,
    "itemsInserted" INTEGER NOT NULL DEFAULT 0,
    "itemsUpdated" INTEGER NOT NULL DEFAULT 0,
    "pricesChanged" INTEGER NOT NULL DEFAULT 0,
    "failedRequests" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "heartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanRunEvent" (
    "id" BIGSERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanRunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScanRunListing" (
    "runId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "outcome" "RunListingOutcome" NOT NULL,

    CONSTRAINT "ScanRunListing_pkey" PRIMARY KEY ("runId","listingId")
);

-- CreateTable
CREATE TABLE "ProxyProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "strategy" "ProxyStrategy" NOT NULL DEFAULT 'ROUND_ROBIN',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProxyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProxyEndpoint" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'http',
    "usernameEncrypted" TEXT,
    "passwordEncrypted" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "country" TEXT,
    "notes" TEXT NOT NULL DEFAULT '',
    "lastCheckedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "healthStatus" "ProxyHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "quarantinedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProxyEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CookieProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "encryptedCookieJson" TEXT NOT NULL,
    "domainSummary" TEXT NOT NULL DEFAULT '',
    "cookieCount" INTEGER NOT NULL DEFAULT 0,
    "expirySummary" TEXT NOT NULL DEFAULT '',
    "lastValidatedAt" TIMESTAMP(3),
    "validationStatus" "CookieValidationStatus" NOT NULL DEFAULT 'UNKNOWN',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CookieProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "poolSize" INTEGER NOT NULL DEFAULT 10,
    "maxUsageCount" INTEGER NOT NULL DEFAULT 50,
    "maxAgeMinutes" INTEGER NOT NULL DEFAULT 60,
    "persistCookiesPerSession" BOOLEAN NOT NULL DEFAULT true,
    "proxyAffinity" BOOLEAN NOT NULL DEFAULT true,
    "retireOnNetworkFailures" BOOLEAN NOT NULL DEFAULT true,
    "failureThreshold" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Listing_status_idx" ON "Listing"("status");

-- CreateIndex
CREATE INDEX "Listing_province_district_idx" ON "Listing"("province", "district");

-- CreateIndex
CREATE INDEX "Listing_sellerType_idx" ON "Listing"("sellerType");

-- CreateIndex
CREATE INDEX "Listing_lastSeenAt_idx" ON "Listing"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_source_sourceListingId_key" ON "Listing"("source", "sourceListingId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingImage_listingId_url_key" ON "ListingImage"("listingId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "ListingAttribute_listingId_key_key" ON "ListingAttribute"("listingId", "key");

-- CreateIndex
CREATE INDEX "ListingPriceHistory_listingId_changedAt_idx" ON "ListingPriceHistory"("listingId", "changedAt");

-- CreateIndex
CREATE INDEX "ListingSeenHistory_listingId_idx" ON "ListingSeenHistory"("listingId");

-- CreateIndex
CREATE INDEX "ListingSeenHistory_runId_idx" ON "ListingSeenHistory"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "Seller_source_profileUrl_key" ON "Seller"("source", "profileUrl");

-- CreateIndex
CREATE INDEX "ScanRun_scanDefinitionId_createdAt_idx" ON "ScanRun"("scanDefinitionId", "createdAt");

-- CreateIndex
CREATE INDEX "ScanRun_status_idx" ON "ScanRun"("status");

-- CreateIndex
CREATE INDEX "ScanRunEvent_runId_id_idx" ON "ScanRunEvent"("runId", "id");

-- CreateIndex
CREATE INDEX "ScanRunListing_listingId_idx" ON "ScanRunListing"("listingId");

-- CreateIndex
CREATE INDEX "ProxyEndpoint_profileId_healthStatus_idx" ON "ProxyEndpoint"("profileId", "healthStatus");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingImage" ADD CONSTRAINT "ListingImage_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingAttribute" ADD CONSTRAINT "ListingAttribute_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingPriceHistory" ADD CONSTRAINT "ListingPriceHistory_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingSeenHistory" ADD CONSTRAINT "ListingSeenHistory_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanDefinition" ADD CONSTRAINT "ScanDefinition_proxyProfileId_fkey" FOREIGN KEY ("proxyProfileId") REFERENCES "ProxyProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanDefinition" ADD CONSTRAINT "ScanDefinition_cookieProfileId_fkey" FOREIGN KEY ("cookieProfileId") REFERENCES "CookieProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanDefinition" ADD CONSTRAINT "ScanDefinition_sessionPolicyId_fkey" FOREIGN KEY ("sessionPolicyId") REFERENCES "SessionPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanRun" ADD CONSTRAINT "ScanRun_scanDefinitionId_fkey" FOREIGN KEY ("scanDefinitionId") REFERENCES "ScanDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanRunEvent" ADD CONSTRAINT "ScanRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ScanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanRunListing" ADD CONSTRAINT "ScanRunListing_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ScanRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScanRunListing" ADD CONSTRAINT "ScanRunListing_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProxyEndpoint" ADD CONSTRAINT "ProxyEndpoint_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ProxyProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

