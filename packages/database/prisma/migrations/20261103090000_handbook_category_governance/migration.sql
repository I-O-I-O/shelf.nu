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

ALTER TABLE "HandbookArticle"
    ALTER COLUMN "draftSection" SET DEFAULT '';

ALTER TABLE "HandbookArticleVersion"
    ALTER COLUMN "section" SET DEFAULT '';
