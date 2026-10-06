CREATE TABLE "IoioAiGuidelines" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "sections" JSONB NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IoioAiGuidelines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IoioAiGuidelines_organizationId_key"
ON "IoioAiGuidelines"("organizationId");

CREATE INDEX "IoioAiGuidelines_updatedByUserId_idx"
ON "IoioAiGuidelines"("updatedByUserId");

ALTER TABLE "IoioAiGuidelines"
ADD CONSTRAINT "IoioAiGuidelines_organizationId_fkey"
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "IoioAiGuidelines"
ADD CONSTRAINT "IoioAiGuidelines_updatedByUserId_fkey"
FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'IOIO_AI_GUIDELINES_UPDATED';
