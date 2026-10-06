-- Durable coordination for the single Milestone 11 IOIO assistant write.
-- These tables hold workflow/audit state only; Shelf remains the inventory
-- system of record and no inventory model is duplicated here.
CREATE TABLE "IoioWriteOperation" (
    "id" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'IOIO_ASSISTANT',
    "status" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "assetId" TEXT,
    "kitId" TEXT,
    "locationId" TEXT,
    "quantity" INTEGER,
    "selectedAssetIds" JSONB,
    "bookingId" TEXT,
    "bookingAssetId" TEXT,
    "from" TIMESTAMP(3),
    "to" TIMESTAMP(3),
    "resultReportId" TEXT,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "IoioWriteOperation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IoioRateLimitBucket" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IoioRateLimitBucket_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IoioWriteOperation_idempotencyKey_key"
  ON "IoioWriteOperation"("idempotencyKey");
CREATE INDEX "IoioWriteOperation_organizationId_operationType_createdAt_idx"
  ON "IoioWriteOperation"("organizationId", "operationType", "createdAt");
CREATE INDEX "IoioWriteOperation_userId_operationType_createdAt_idx"
  ON "IoioWriteOperation"("userId", "operationType", "createdAt");

CREATE INDEX "IoioWriteOperation_bookingId_idx"
  ON "IoioWriteOperation"("bookingId");

CREATE UNIQUE INDEX "IoioRateLimitBucket_key_key"
  ON "IoioRateLimitBucket"("key");
CREATE INDEX "IoioRateLimitBucket_organizationId_operationType_windowStartedAt_idx"
  ON "IoioRateLimitBucket"("organizationId", "operationType", "windowStartedAt");
CREATE INDEX "IoioRateLimitBucket_userId_operationType_windowStartedAt_idx"
  ON "IoioRateLimitBucket"("userId", "operationType", "windowStartedAt");

ALTER TABLE "IoioWriteOperation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "IoioRateLimitBucket" ENABLE ROW LEVEL SECURITY;
