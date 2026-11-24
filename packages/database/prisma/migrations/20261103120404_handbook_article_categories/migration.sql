ALTER TABLE "HandbookArticle"
    ADD COLUMN "categoryId" TEXT,
    ALTER COLUMN "draftSection" DROP NOT NULL,
    ALTER COLUMN "draftSection" DROP DEFAULT;

ALTER TABLE "HandbookArticleVersion"
    ALTER COLUMN "section" DROP NOT NULL,
    ALTER COLUMN "section" DROP DEFAULT;

CREATE INDEX "HandbookArticle_categoryId_idx"
    ON "HandbookArticle"("categoryId");

ALTER TABLE "HandbookArticle"
    ADD CONSTRAINT "HandbookArticle_categoryId_fkey"
        FOREIGN KEY ("categoryId") REFERENCES "Category"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
