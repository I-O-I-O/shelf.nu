-- Deterministic child work records for the IOIO staff inventory importer.
-- The composite foreign key keeps every ledger row in its parent's organization.
CREATE UNIQUE INDEX "IoioWriteOperation_id_organizationId_key"
  ON "IoioWriteOperation"("id", "organizationId");

CREATE TABLE "IoioImportItem" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "rowKey" TEXT NOT NULL,
    "unitIndex" INTEGER,
    "identityKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "expectedPrior" JSONB,
    "writtenState" JSONB,
    "targetAssetId" TEXT,
    "targetKitId" TEXT,
    "qrId" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "heartbeatAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IoioImportItem_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IoioImportItem_operationId_organizationId_fkey"
      FOREIGN KEY ("operationId", "organizationId")
      REFERENCES "IoioWriteOperation"("id", "organizationId")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "IoioImportItem_idempotencyKey_key"
  ON "IoioImportItem"("idempotencyKey");
CREATE UNIQUE INDEX "IoioImportItem_operationId_identityKey_key"
  ON "IoioImportItem"("operationId", "identityKey");
CREATE UNIQUE INDEX "IoioImportItem_targetAssetId_key"
  ON "IoioImportItem"("targetAssetId");
CREATE UNIQUE INDEX "IoioImportItem_qrId_key"
  ON "IoioImportItem"("qrId");
CREATE INDEX "IoioImportItem_operationId_status_idx"
  ON "IoioImportItem"("operationId", "status");
CREATE INDEX "IoioImportItem_organizationId_status_idx"
  ON "IoioImportItem"("organizationId", "status");
CREATE INDEX "IoioImportItem_status_heartbeatAt_idx"
  ON "IoioImportItem"("status", "heartbeatAt");

ALTER TABLE "IoioImportItem" ENABLE ROW LEVEL SECURITY;
