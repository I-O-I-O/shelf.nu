ALTER TABLE "IoioWriteOperation"
ADD COLUMN "fileSha256" TEXT,
ADD COLUMN "proposalSha256" TEXT;

CREATE UNIQUE INDEX "IoioWriteOperation_organizationId_proposalSha256_key"
ON "IoioWriteOperation"("organizationId", "proposalSha256");

CREATE INDEX "IoioWriteOperation_organizationId_fileSha256_status_idx"
ON "IoioWriteOperation"("organizationId", "fileSha256", "status");
