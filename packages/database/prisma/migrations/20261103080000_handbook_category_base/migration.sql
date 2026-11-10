CREATE TABLE "HandbookCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HandbookCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HandbookCategory_organizationId_slug_key"
    ON "HandbookCategory"("organizationId", "slug");

CREATE INDEX "HandbookCategory_organizationId_name_idx"
    ON "HandbookCategory"("organizationId", "name");

ALTER TABLE "HandbookCategory"
    ADD CONSTRAINT "HandbookCategory_organizationId_fkey"
    FOREIGN KEY ("organizationId")
    REFERENCES "Organization"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
