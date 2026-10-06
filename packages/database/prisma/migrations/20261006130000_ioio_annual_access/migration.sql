-- CreateEnum
CREATE TYPE "AnnualAccessApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'REVOKED');
CREATE TYPE "AnnualAccessApprovalRenewalMode" AS ENUM (
  'ACADEMIC_YEAR',
  'TWELVE_MONTHS',
  'SIX_MONTHS',
  'CUSTOM'
);

-- CreateTable
CREATE TABLE "AnnualAccessApproval" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "approvalYear" INTEGER NOT NULL,
    "status" "AnnualAccessApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "staffComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnnualAccessApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnnualAccessApproval_organizationId_userId_approvalYear_idx" ON "AnnualAccessApproval"("organizationId", "userId", "approvalYear");

-- CreateIndex
CREATE INDEX "AnnualAccessApproval_organizationId_approvalYear_status_idx" ON "AnnualAccessApproval"("organizationId", "approvalYear", "status");

-- CreateIndex
CREATE INDEX "AnnualAccessApproval_organizationId_userId_status_requestedAt_idx"
  ON "AnnualAccessApproval"("organizationId", "userId", "status", "requestedAt");
CREATE INDEX "AnnualAccessApproval_reviewedByUserId_idx" ON "AnnualAccessApproval"("reviewedByUserId");

-- AddForeignKey
ALTER TABLE "AnnualAccessApproval" ADD CONSTRAINT "AnnualAccessApproval_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnualAccessApproval" ADD CONSTRAINT "AnnualAccessApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnualAccessApproval" ADD CONSTRAINT "AnnualAccessApproval_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


ALTER TABLE "Organization"
  ADD COLUMN "accessApprovalRequired" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN "accessApprovalRenewalMode" "AnnualAccessApprovalRenewalMode" NOT NULL DEFAULT 'ACADEMIC_YEAR',
  ADD COLUMN "accessApprovalRenewalMonth" INTEGER NOT NULL DEFAULT 9,
  ADD COLUMN "accessApprovalCustomMonths" INTEGER,
  ADD COLUMN "accessApprovalStudentMessage" VARCHAR(1000),
  ADD COLUMN "accessApprovalUpdatedByUserId" TEXT,
  ADD COLUMN "accessApprovalUpdatedAt" TIMESTAMP(3);

-- Preserve the validity the previous implementation granted: approvals for
-- cycle N remain valid up to the beginning of the September cycle in N + 1.
UPDATE "AnnualAccessApproval"
SET
  "approvedAt" = COALESCE("reviewedAt", "requestedAt"),
  "validUntil" = make_timestamp("approvalYear" + 1, 9, 1, 0, 0, 0) - INTERVAL '1 millisecond'
WHERE "status" = 'APPROVED';

ALTER TABLE "Organization"
  ADD CONSTRAINT "Organization_accessApprovalUpdatedByUserId_fkey"
  FOREIGN KEY ("accessApprovalUpdatedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Organization_accessApprovalUpdatedByUserId_idx"
  ON "Organization"("accessApprovalUpdatedByUserId");



CREATE TABLE "AnnualAccessApprovalNotification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "AnnualAccessApprovalNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AnnualAccessApprovalNotification_approvalId_eventAt_key"
ON "AnnualAccessApprovalNotification"("approvalId", "eventAt");

CREATE INDEX "AnnualAccessApprovalNotification_organizationId_userId_eventAt_idx"
ON "AnnualAccessApprovalNotification"("organizationId", "userId", "eventAt");

CREATE INDEX "AnnualAccessApprovalNotification_organizationId_userId_readAt_idx"
ON "AnnualAccessApprovalNotification"("organizationId", "userId", "readAt");

ALTER TABLE "AnnualAccessApprovalNotification"
ADD CONSTRAINT "AnnualAccessApprovalNotification_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnnualAccessApprovalNotification"
ADD CONSTRAINT "AnnualAccessApprovalNotification_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnnualAccessApprovalNotification"
ADD CONSTRAINT "AnnualAccessApprovalNotification_approvalId_fkey"
FOREIGN KEY ("approvalId") REFERENCES "AnnualAccessApproval"("id") ON DELETE CASCADE ON UPDATE CASCADE;
