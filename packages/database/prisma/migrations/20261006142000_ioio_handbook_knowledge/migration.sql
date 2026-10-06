-- IOIO Handbook: human-facing published articles, immutable versions,
-- traceable sources, canonical inventory links, and pending observations.
-- This additive migration is intentionally not applied by the development agent.

CREATE TYPE "HandbookArticleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "HandbookObservationStatus" AS ENUM ('PENDING_REVIEW', 'REVIEWED', 'DISMISSED');
CREATE TYPE "HandbookSourceKind" AS ENUM ('EXTERNAL_REFERENCE', 'UPLOADED_DOCUMENT', 'LEGACY_MATERIAL', 'STAFF_CONTRIBUTION');

ALTER TYPE "ActivityEntity" ADD VALUE IF NOT EXISTS 'HANDBOOK_ARTICLE';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'IOIO_HANDBOOK_ARTICLE_PUBLISHED';
ALTER TYPE "ActivityAction" ADD VALUE IF NOT EXISTS 'IOIO_HANDBOOK_OBSERVATION_SUBMITTED';

CREATE TABLE "HandbookArticle" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "HandbookArticleStatus" NOT NULL DEFAULT 'DRAFT',
    "draftTitle" VARCHAR(180) NOT NULL,
    "draftSummary" VARCHAR(700) NOT NULL DEFAULT '',
    "draftContent" TEXT NOT NULL,
    "draftSection" VARCHAR(80) NOT NULL DEFAULT 'General',
    "draftAssetModelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "draftKitIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "draftSourceUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "publishedVersionId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HandbookArticle_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HandbookArticleVersion" (
    "id" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "title" VARCHAR(180) NOT NULL,
    "summary" VARCHAR(700) NOT NULL DEFAULT '',
    "content" TEXT NOT NULL,
    "section" VARCHAR(80) NOT NULL,
    "publishedByUserId" TEXT NOT NULL,
    "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HandbookArticleVersion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HandbookArticleAssetModel" (
    "versionId" TEXT NOT NULL,
    "assetModelId" TEXT NOT NULL,
    CONSTRAINT "HandbookArticleAssetModel_pkey" PRIMARY KEY ("versionId", "assetModelId")
);

CREATE TABLE "HandbookArticleKit" (
    "versionId" TEXT NOT NULL,
    "kitId" TEXT NOT NULL,
    CONSTRAINT "HandbookArticleKit_pkey" PRIMARY KEY ("versionId", "kitId")
);

CREATE TABLE "HandbookSource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "HandbookSourceKind" NOT NULL DEFAULT 'EXTERNAL_REFERENCE',
    "title" VARCHAR(240) NOT NULL,
    "url" VARCHAR(500),
    "storageObjectPath" TEXT,
    "contentType" TEXT,
    "extractedText" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HandbookSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HandbookVersionSource" (
    "versionId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    CONSTRAINT "HandbookVersionSource_pkey" PRIMARY KEY ("versionId", "sourceId")
);

CREATE TABLE "HandbookObservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contributorUserId" TEXT NOT NULL,
    "status" "HandbookObservationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "title" VARCHAR(180) NOT NULL,
    "content" VARCHAR(4000) NOT NULL,
    "articleId" TEXT,
    "assetModelId" TEXT,
    "kitId" TEXT,
    "conversationId" TEXT,
    "messageId" TEXT,
    "reviewedByUserId" TEXT,
    "reviewedAt" TIMESTAMPTZ(3),
    "publishedVersionId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HandbookObservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HandbookArticle_publishedVersionId_key" ON "HandbookArticle"("publishedVersionId");
CREATE UNIQUE INDEX "HandbookArticle_organizationId_slug_key" ON "HandbookArticle"("organizationId", "slug");
CREATE INDEX "HandbookArticle_organizationId_status_updatedAt_idx" ON "HandbookArticle"("organizationId", "status", "updatedAt");
CREATE UNIQUE INDEX "HandbookArticleVersion_articleId_versionNumber_key" ON "HandbookArticleVersion"("articleId", "versionNumber");
CREATE INDEX "HandbookArticleVersion_articleId_publishedAt_idx" ON "HandbookArticleVersion"("articleId", "publishedAt" DESC);
CREATE INDEX "HandbookArticleAssetModel_assetModelId_idx" ON "HandbookArticleAssetModel"("assetModelId");
CREATE INDEX "HandbookArticleKit_kitId_idx" ON "HandbookArticleKit"("kitId");
CREATE UNIQUE INDEX "HandbookSource_organizationId_url_key" ON "HandbookSource"("organizationId", "url");
CREATE INDEX "HandbookSource_organizationId_kind_createdAt_idx" ON "HandbookSource"("organizationId", "kind", "createdAt");
CREATE INDEX "HandbookVersionSource_sourceId_idx" ON "HandbookVersionSource"("sourceId");
CREATE INDEX "HandbookObservation_organizationId_status_createdAt_idx" ON "HandbookObservation"("organizationId", "status", "createdAt" DESC);
CREATE INDEX "HandbookObservation_articleId_createdAt_idx" ON "HandbookObservation"("articleId", "createdAt" DESC);
CREATE INDEX "HandbookObservation_assetModelId_createdAt_idx" ON "HandbookObservation"("assetModelId", "createdAt" DESC);
CREATE INDEX "HandbookObservation_kitId_createdAt_idx" ON "HandbookObservation"("kitId", "createdAt" DESC);

ALTER TABLE "HandbookArticle" ADD CONSTRAINT "HandbookArticle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookArticleVersion" ADD CONSTRAINT "HandbookArticleVersion_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "HandbookArticle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookArticle" ADD CONSTRAINT "HandbookArticle_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "HandbookArticleVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookArticleAssetModel" ADD CONSTRAINT "HandbookArticleAssetModel_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "HandbookArticleVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookArticleAssetModel" ADD CONSTRAINT "HandbookArticleAssetModel_assetModelId_fkey" FOREIGN KEY ("assetModelId") REFERENCES "AssetModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookArticleKit" ADD CONSTRAINT "HandbookArticleKit_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "HandbookArticleVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookArticleKit" ADD CONSTRAINT "HandbookArticleKit_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookSource" ADD CONSTRAINT "HandbookSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookVersionSource" ADD CONSTRAINT "HandbookVersionSource_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "HandbookArticleVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookVersionSource" ADD CONSTRAINT "HandbookVersionSource_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "HandbookSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookObservation" ADD CONSTRAINT "HandbookObservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HandbookObservation" ADD CONSTRAINT "HandbookObservation_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "HandbookArticle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookObservation" ADD CONSTRAINT "HandbookObservation_assetModelId_fkey" FOREIGN KEY ("assetModelId") REFERENCES "AssetModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookObservation" ADD CONSTRAINT "HandbookObservation_kitId_fkey" FOREIGN KEY ("kitId") REFERENCES "Kit"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HandbookObservation" ADD CONSTRAINT "HandbookObservation_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "HandbookArticleVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
