CREATE TYPE "HandbookRevisionStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED');
CREATE TYPE "HandbookFindingType" AS ENUM ('DUPLICATE', 'CONFLICT', 'POSSIBLY_STALE', 'MISSING_STRUCTURE', 'BROKEN_LINK');
CREATE TYPE "HandbookFindingStatus" AS ENUM ('OPEN', 'DISMISSED', 'RESOLVED');

CREATE TABLE "HandbookCategory" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HandbookCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HandbookTopic" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HandbookTopic_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "HandbookArticleVersion"
    ADD COLUMN "authorUserId" TEXT,
    ADD COLUMN "categoryId" TEXT,
    ADD COLUMN "topicId" TEXT,
    ADD COLUMN "articleType" VARCHAR(40) NOT NULL DEFAULT 'Guide',
    ADD COLUMN "locationId" TEXT,
    ADD COLUMN "videoUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE TABLE "HandbookRevision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "status" "HandbookRevisionStatus" NOT NULL DEFAULT 'DRAFT',
    "title" VARCHAR(180) NOT NULL,
    "summary" VARCHAR(700) NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "section" VARCHAR(80) NOT NULL DEFAULT 'General',
    "categoryId" TEXT,
    "topicId" TEXT,
    "articleType" VARCHAR(40) NOT NULL DEFAULT 'Guide',
    "locationId" TEXT,
    "videoUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "assetModelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "kitIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sourceUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "authorUserId" TEXT NOT NULL,
    "submittedAt" TIMESTAMPTZ(3),
    "reviewedAt" TIMESTAMPTZ(3),
    "reviewedByUserId" TEXT,
    "reviewNotes" TEXT,
    "aiReview" JSONB,
    "publishedVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HandbookRevision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HandbookFinding" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "type" "HandbookFindingType" NOT NULL,
    "status" "HandbookFindingStatus" NOT NULL DEFAULT 'OPEN',
    "articleId" TEXT,
    "relatedArticleId" TEXT,
    "revisionId" TEXT,
    "title" VARCHAR(240) NOT NULL,
    "details" TEXT NOT NULL,
    "staffDecision" VARCHAR(40),
    "createdByUserId" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HandbookFinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HandbookCategory_organizationId_slug_key" ON "HandbookCategory"("organizationId", "slug");
CREATE INDEX "HandbookCategory_organizationId_name_idx" ON "HandbookCategory"("organizationId", "name");
CREATE UNIQUE INDEX "HandbookTopic_categoryId_slug_key" ON "HandbookTopic"("categoryId", "slug");
CREATE INDEX "HandbookTopic_organizationId_name_idx" ON "HandbookTopic"("organizationId", "name");
CREATE UNIQUE INDEX "HandbookRevision_publishedVersionId_key" ON "HandbookRevision"("publishedVersionId");
CREATE UNIQUE INDEX "HandbookRevision_articleId_revisionNumber_key" ON "HandbookRevision"("articleId", "revisionNumber");
CREATE INDEX "HandbookRevision_organizationId_status_submittedAt_idx" ON "HandbookRevision"("organizationId", "status", "submittedAt" DESC);
CREATE INDEX "HandbookRevision_articleId_revisionNumber_idx" ON "HandbookRevision"("articleId", "revisionNumber" DESC);
CREATE INDEX "HandbookRevision_authorUserId_status_updatedAt_idx" ON "HandbookRevision"("authorUserId", "status", "updatedAt" DESC);
CREATE INDEX "HandbookFinding_organizationId_status_type_createdAt_idx" ON "HandbookFinding"("organizationId", "status", "type", "createdAt" DESC);
CREATE INDEX "HandbookFinding_articleId_relatedArticleId_type_idx" ON "HandbookFinding"("articleId", "relatedArticleId", "type");
CREATE INDEX "HandbookArticleVersion_categoryId_topicId_idx" ON "HandbookArticleVersion"("categoryId", "topicId");
CREATE INDEX "HandbookArticleVersion_locationId_idx" ON "HandbookArticleVersion"("locationId");

-- Preserve the existing published section taxonomy as initial categories.
INSERT INTO "HandbookCategory" ("id", "organizationId", "name", "slug", "updatedAt")
SELECT DISTINCT substr(md5(a."organizationId" || ':' || v."section"), 1, 25), a."organizationId", v."section",
       regexp_replace(lower(v."section"), '[^a-z0-9]+', '-', 'g'), CURRENT_TIMESTAMP
FROM "HandbookArticleVersion" v
JOIN "HandbookArticle" a ON a."id" = v."articleId"
ON CONFLICT ("organizationId", "slug") DO NOTHING;

INSERT INTO "HandbookCategory" ("id", "organizationId", "name", "slug", "updatedAt")
SELECT DISTINCT substr(md5(a."organizationId" || ':' || a."draftSection"), 1, 25), a."organizationId", a."draftSection",
       regexp_replace(lower(a."draftSection"), '[^a-z0-9]+', '-', 'g'), CURRENT_TIMESTAMP
FROM "HandbookArticle" a
ON CONFLICT ("organizationId", "slug") DO NOTHING;

INSERT INTO "HandbookTopic" ("id", "organizationId", "categoryId", "name", "slug", "updatedAt")
SELECT substr(md5(c."id" || ':general'), 1, 25), c."organizationId", c."id", 'General', 'general', CURRENT_TIMESTAMP
FROM "HandbookCategory" c
ON CONFLICT ("categoryId", "slug") DO NOTHING;

UPDATE "HandbookArticleVersion" v
SET "authorUserId" = v."publishedByUserId",
    "categoryId" = c."id",
    "topicId" = t."id"
FROM "HandbookArticle" a, "HandbookCategory" c, "HandbookTopic" t
WHERE a."id" = v."articleId"
  AND c."organizationId" = a."organizationId"
  AND c."name" = v."section"
  AND t."categoryId" = c."id"
  AND t."slug" = 'general';

-- Preserve the mutable legacy draft as a private draft proposal. Existing
-- published snapshots stay current until this proposal is explicitly approved.
INSERT INTO "HandbookRevision" (
    "id", "organizationId", "articleId", "revisionNumber", "status", "title", "summary", "content", "section",
    "categoryId", "topicId", "authorUserId", "assetModelIds", "kitIds", "sourceUrls", "createdAt", "updatedAt"
)
SELECT substr(md5(a."id" || ':legacy-draft'), 1, 25), a."organizationId", a."id",
       COALESCE((SELECT MAX(v."versionNumber") FROM "HandbookArticleVersion" v WHERE v."articleId" = a."id"), 0) + 1,
       'DRAFT', a."draftTitle", a."draftSummary", a."draftContent", a."draftSection",
       c."id", t."id", a."updatedByUserId", a."draftAssetModelIds", a."draftKitIds", a."draftSourceUrls", a."updatedAt", CURRENT_TIMESTAMP
FROM "HandbookArticle" a
LEFT JOIN "HandbookArticleVersion" current_v ON current_v."id" = a."publishedVersionId"
LEFT JOIN "HandbookCategory" c ON c."organizationId" = a."organizationId" AND c."name" = a."draftSection"
LEFT JOIN "HandbookTopic" t ON t."categoryId" = c."id" AND t."slug" = 'general'
WHERE current_v."id" IS NULL
   OR a."draftTitle" IS DISTINCT FROM current_v."title"
   OR a."draftSummary" IS DISTINCT FROM current_v."summary"
   OR a."draftContent" IS DISTINCT FROM current_v."content"
   OR a."draftSection" IS DISTINCT FROM current_v."section";

ALTER TABLE "HandbookCategory" ADD CONSTRAINT "HandbookCategory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookTopic" ADD CONSTRAINT "HandbookTopic_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookTopic" ADD CONSTRAINT "HandbookTopic_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "HandbookCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookArticleVersion" ADD CONSTRAINT "HandbookArticleVersion_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "HandbookCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookArticleVersion" ADD CONSTRAINT "HandbookArticleVersion_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "HandbookTopic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookArticleVersion" ADD CONSTRAINT "HandbookArticleVersion_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookRevision" ADD CONSTRAINT "HandbookRevision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookRevision" ADD CONSTRAINT "HandbookRevision_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "HandbookArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookRevision" ADD CONSTRAINT "HandbookRevision_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "HandbookCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookRevision" ADD CONSTRAINT "HandbookRevision_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "HandbookTopic"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookRevision" ADD CONSTRAINT "HandbookRevision_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookRevision" ADD CONSTRAINT "HandbookRevision_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "HandbookArticleVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookFinding" ADD CONSTRAINT "HandbookFinding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookFinding" ADD CONSTRAINT "HandbookFinding_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "HandbookArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookFinding" ADD CONSTRAINT "HandbookFinding_relatedArticleId_fkey" FOREIGN KEY ("relatedArticleId") REFERENCES "HandbookArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookFinding" ADD CONSTRAINT "HandbookFinding_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "HandbookRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;
