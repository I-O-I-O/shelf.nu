ALTER TABLE "HandbookArticle"
ADD COLUMN "draftAttachmentsInitialized" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "HandbookSource"
ADD COLUMN "draftArticleId" TEXT,
ADD COLUMN "fileSizeBytes" INTEGER;

CREATE INDEX "HandbookSource_draftArticleId_idx"
ON "HandbookSource"("draftArticleId");

ALTER TABLE "HandbookSource"
ADD CONSTRAINT "HandbookSource_draftArticleId_fkey"
FOREIGN KEY ("draftArticleId") REFERENCES "HandbookArticle"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
