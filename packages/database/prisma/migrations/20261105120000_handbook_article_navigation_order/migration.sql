ALTER TABLE "HandbookArticle"
    ADD COLUMN "isStartHere" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

WITH ranked_articles AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "handbookCategoryId"
            ORDER BY "createdAt" ASC, "id" ASC
        )::INTEGER AS article_position
    FROM "HandbookArticle"
)
UPDATE "HandbookArticle" AS article
SET "position" = ranked_articles.article_position
FROM ranked_articles
WHERE article."id" = ranked_articles."id";
