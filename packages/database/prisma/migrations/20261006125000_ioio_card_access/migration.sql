-- CreateEnum
CREATE TYPE "CardAccessRequestStatus" AS ENUM ('WAITING_FOR_SUBMISSION', 'SUBMITTED', 'APPROVED', 'NEEDS_ATTENTION', 'CANCELLED');

-- CreateTable
CREATE TABLE "CardAccessBatch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "sentById" TEXT,
    "recipientId" TEXT,
    "recipientEmail" TEXT,
    "recipientName" TEXT,
    "sentAt" TIMESTAMP(3),
    "itRecipientEmail" TEXT,
    "itSentAt" TIMESTAMP(3),
    "itSentById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardAccessBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CardAccessRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "cardNumber" TEXT NOT NULL,
    "status" "CardAccessRequestStatus" NOT NULL DEFAULT 'WAITING_FOR_SUBMISSION',
    "consentConfirmedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardAccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardAccessBatch_organizationId_createdAt_idx" ON "CardAccessBatch"("organizationId", "createdAt");
CREATE INDEX "CardAccessBatch_recipientId_idx" ON "CardAccessBatch"("recipientId");
CREATE INDEX "CardAccessBatch_itSentById_idx" ON "CardAccessBatch"("itSentById");
CREATE INDEX "CardAccessRequest_organizationId_status_idx" ON "CardAccessRequest"("organizationId", "status");
CREATE INDEX "CardAccessRequest_organizationId_applicantId_status_idx" ON "CardAccessRequest"("organizationId", "applicantId", "status");
CREATE UNIQUE INDEX "CardAccessRequest_active_applicant_unique"
    ON "CardAccessRequest"("organizationId", "applicantId")
    WHERE "status" IN ('WAITING_FOR_SUBMISSION', 'SUBMITTED', 'NEEDS_ATTENTION');
CREATE TABLE "CardAccessBatchRequest" (
    "batchId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardAccessBatchRequest_pkey" PRIMARY KEY ("batchId", "requestId")
);
CREATE INDEX "CardAccessBatchRequest_requestId_idx" ON "CardAccessBatchRequest"("requestId");

-- AddForeignKey
ALTER TABLE "CardAccessBatch" ADD CONSTRAINT "CardAccessBatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardAccessBatch" ADD CONSTRAINT "CardAccessBatch_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CardAccessBatch" ADD CONSTRAINT "CardAccessBatch_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CardAccessBatch" ADD CONSTRAINT "CardAccessBatch_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CardAccessBatch" ADD CONSTRAINT "CardAccessBatch_itSentById_fkey" FOREIGN KEY ("itSentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CardAccessRequest" ADD CONSTRAINT "CardAccessRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardAccessRequest" ADD CONSTRAINT "CardAccessRequest_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardAccessBatchRequest" ADD CONSTRAINT "CardAccessBatchRequest_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "CardAccessBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CardAccessBatchRequest" ADD CONSTRAINT "CardAccessBatchRequest_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "CardAccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
