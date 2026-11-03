CREATE TYPE "HandbookCategoryProposalStatus" AS ENUM (
    'DRAFT',
    'PENDING_REVIEW',
    'APPROVED',
    'REPLACED',
    'REJECTED',
    'CANCELLED'
);

ALTER TABLE "HandbookCategory"
    ADD COLUMN "normalizedName" TEXT,
    ADD COLUMN "archivedAt" TIMESTAMPTZ(3);

UPDATE "HandbookCategory"
SET "normalizedName" = lower(
    normalize(
        regexp_replace(btrim("name"), '[[:space:]]+', ' ', 'g'),
        NFKC
    )
);

-- Preserve legacy category rows and historical article references while
-- keeping one active canonical row for each normalized category name.
WITH ranked_categories AS (
    SELECT
        "id",
        row_number() OVER (
            PARTITION BY "organizationId", "normalizedName"
            ORDER BY "createdAt", "id"
        ) AS duplicate_rank
    FROM "HandbookCategory"
)
UPDATE "HandbookCategory" AS category
SET
    "normalizedName" = '__archived_legacy_duplicate__:' || category."id",
    "archivedAt" = COALESCE(category."archivedAt", CURRENT_TIMESTAMP)
FROM ranked_categories
WHERE ranked_categories."id" = category."id"
  AND ranked_categories.duplicate_rank > 1;

ALTER TABLE "HandbookCategory"
    ALTER COLUMN "normalizedName" SET NOT NULL;

CREATE UNIQUE INDEX "HandbookCategory_organizationId_normalizedName_key"
    ON "HandbookCategory"("organizationId", "normalizedName");
CREATE INDEX "HandbookCategory_organizationId_archivedAt_name_idx"
    ON "HandbookCategory"("organizationId", "archivedAt", "name");

CREATE TABLE "HandbookCategoryProposal" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "proposedName" VARCHAR(80) NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "status" "HandbookCategoryProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "resolvedCategoryId" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HandbookCategoryProposal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HandbookCategoryProposal_revisionId_key"
    ON "HandbookCategoryProposal"("revisionId");
CREATE INDEX "HandbookCategoryProposal_organizationId_status_normalizedName_idx"
    ON "HandbookCategoryProposal"("organizationId", "status", "normalizedName");

ALTER TABLE "HandbookCategoryProposal"
    ADD CONSTRAINT "HandbookCategoryProposal_organizationId_fkey"
        FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "HandbookCategoryProposal_revisionId_fkey"
        FOREIGN KEY ("revisionId") REFERENCES "HandbookRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "HandbookCategoryProposal_resolvedCategoryId_fkey"
        FOREIGN KEY ("resolvedCategoryId") REFERENCES "HandbookCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HandbookArticle"
    ALTER COLUMN "draftSection" SET DEFAULT '';
ALTER TABLE "HandbookRevision"
    ALTER COLUMN "section" SET DEFAULT '';
ALTER TABLE "HandbookArticleVersion"
    ALTER COLUMN "section" SET DEFAULT '';
