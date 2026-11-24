-- Keep the prior Asset Category link intact for existing data. New Handbook
-- category selections use HandbookCategory exclusively.
ALTER TABLE "HandbookArticle"
    ADD COLUMN "handbookCategoryId" TEXT;

ALTER TABLE "HandbookObservation"
    ADD COLUMN "handbookCategoryId" TEXT,
    ADD COLUMN "proposedCategoryName" VARCHAR(80);

CREATE INDEX "HandbookArticle_handbookCategoryId_idx"
    ON "HandbookArticle"("handbookCategoryId");

CREATE INDEX "HandbookObservation_handbookCategoryId_idx"
    ON "HandbookObservation"("handbookCategoryId");

ALTER TABLE "HandbookArticle"
    ADD CONSTRAINT "HandbookArticle_handbookCategoryId_fkey"
        FOREIGN KEY ("handbookCategoryId") REFERENCES "HandbookCategory"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HandbookObservation"
    ADD CONSTRAINT "HandbookObservation_handbookCategoryId_fkey"
        FOREIGN KEY ("handbookCategoryId") REFERENCES "HandbookCategory"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
