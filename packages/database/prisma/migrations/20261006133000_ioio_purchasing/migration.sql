CREATE TYPE "PurchasePriority" AS ENUM ('HIGH', 'MEDIUM', 'LATER');
CREATE TYPE "PurchaseRequestStatus" AS ENUM ('PLANNED', 'RESERVED', 'PURCHASED', 'CANCELLED');

CREATE TABLE "AnnualBudget" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "academicYear" VARCHAR(9) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" "Currency" NOT NULL DEFAULT 'SEK',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnnualBudget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnnualBudget_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "PurchaseBudgetAdjustment" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "previousAmount" DECIMAL(14,2) NOT NULL,
    "newAmount" DECIMAL(14,2) NOT NULL,
    "reason" VARCHAR(1000),
    "changedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseBudgetAdjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseBudgetAdjustment_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "AnnualBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchaseBudgetAdjustment_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "PurchaseRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "title" VARCHAR(240) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "estimatedCost" DECIMAL(14,2),
    "priority" "PurchasePriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "PurchaseRequestStatus" NOT NULL DEFAULT 'PLANNED',
    "requestedByUserId" TEXT NOT NULL,
    "note" VARCHAR(2000),
    "link" VARCHAR(2048),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PurchaseRequest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchaseRequest_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "AnnualBudget"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchaseRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "purchaseRequestId" TEXT,
    "vendor" VARCHAR(240),
    "purchaseDate" DATE NOT NULL,
    "actualTotal" DECIMAL(14,2) NOT NULL,
    "note" VARCHAR(2000),
    "receiptPath" TEXT,
    "receiptOriginalName" VARCHAR(255),
    "receiptMimeType" VARCHAR(100),
    "receiptSize" INTEGER,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Purchase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Purchase_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "AnnualBudget"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Purchase_purchaseRequestId_fkey" FOREIGN KEY ("purchaseRequestId") REFERENCES "PurchaseRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Purchase_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "PurchaseItem" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "name" VARCHAR(240) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "lineTotal" DECIMAL(14,2),
    "linkedAssetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseItem_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchaseItem_linkedAssetId_fkey" FOREIGN KEY ("linkedAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "PurchaseCorrection" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "previousTotal" DECIMAL(14,2) NOT NULL,
    "newTotal" DECIMAL(14,2) NOT NULL,
    "reason" VARCHAR(1000),
    "changedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseCorrection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseCorrection_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchaseCorrection_changedByUserId_fkey" FOREIGN KEY ("changedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "PurchaseReceiptDraft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "uploadedByUserId" TEXT NOT NULL,
    "receiptPath" TEXT NOT NULL,
    "originalName" VARCHAR(255) NOT NULL,
    "mimeType" VARCHAR(100) NOT NULL,
    "size" INTEGER NOT NULL,
    "extractedData" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PurchaseReceiptDraft_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PurchaseReceiptDraft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PurchaseReceiptDraft_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "AnnualBudget_organizationId_academicYear_key" ON "AnnualBudget"("organizationId", "academicYear");
CREATE INDEX "AnnualBudget_organizationId_academicYear_idx" ON "AnnualBudget"("organizationId", "academicYear");
CREATE INDEX "PurchaseBudgetAdjustment_budgetId_createdAt_idx" ON "PurchaseBudgetAdjustment"("budgetId", "createdAt");
CREATE INDEX "PurchaseRequest_organizationId_budgetId_status_priority_idx" ON "PurchaseRequest"("organizationId", "budgetId", "status", "priority");
CREATE INDEX "PurchaseRequest_requestedByUserId_idx" ON "PurchaseRequest"("requestedByUserId");
CREATE UNIQUE INDEX "Purchase_purchaseRequestId_key" ON "Purchase"("purchaseRequestId");
CREATE INDEX "Purchase_organizationId_budgetId_purchaseDate_idx" ON "Purchase"("organizationId", "budgetId", "purchaseDate");
CREATE INDEX "Purchase_createdByUserId_idx" ON "Purchase"("createdByUserId");
CREATE INDEX "PurchaseItem_purchaseId_idx" ON "PurchaseItem"("purchaseId");
CREATE INDEX "PurchaseItem_linkedAssetId_idx" ON "PurchaseItem"("linkedAssetId");
CREATE INDEX "PurchaseCorrection_purchaseId_createdAt_idx" ON "PurchaseCorrection"("purchaseId", "createdAt");
CREATE INDEX "PurchaseReceiptDraft_organizationId_uploadedByUserId_expiresAt_idx" ON "PurchaseReceiptDraft"("organizationId", "uploadedByUserId", "expiresAt");


ALTER TABLE "Purchase"
ADD COLUMN "removedFromPurchasedAt" TIMESTAMPTZ(3);


ALTER TABLE "AnnualBudget"
ADD COLUMN "accountingResetAt" TIMESTAMPTZ(3);
