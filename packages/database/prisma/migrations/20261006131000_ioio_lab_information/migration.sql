CREATE TABLE "IoioLabInformation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "aboutText" TEXT NOT NULL,
    "borrowingText" TEXT NOT NULL,
    "rulesText" TEXT NOT NULL,
    "returnText" TEXT NOT NULL,
    "helpText" TEXT NOT NULL,
    "taLastReviewedAt" TIMESTAMP(3),
    "taLastReviewedAcademicYear" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IoioLabInformation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IoioLabTA" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IoioLabTA_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IoioLabInformation_organizationId_key" ON "IoioLabInformation"("organizationId");
CREATE INDEX "IoioLabInformation_organizationId_idx" ON "IoioLabInformation"("organizationId");
CREATE UNIQUE INDEX "IoioLabTA_organizationId_userId_key" ON "IoioLabTA"("organizationId", "userId");
CREATE INDEX "IoioLabTA_userId_idx" ON "IoioLabTA"("userId");
CREATE INDEX "IoioLabTA_organizationId_idx" ON "IoioLabTA"("organizationId");

ALTER TABLE "IoioLabInformation" ADD CONSTRAINT "IoioLabInformation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IoioLabTA" ADD CONSTRAINT "IoioLabTA_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IoioLabTA" ADD CONSTRAINT "IoioLabTA_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Add ordered Lab Info section metadata and references to images stored in
-- Supabase Storage. Existing fixed-section copy remains in IoioLabInformation.

CREATE TABLE "IoioLabInformationSection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" VARCHAR(80) NOT NULL,
    "title" VARCHAR(120),
    "content" TEXT,
    "position" INTEGER NOT NULL,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IoioLabInformationSection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IoioLabInformationImage" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "caption" VARCHAR(300),
    "altText" VARCHAR(300),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IoioLabInformationImage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "IoioLabInformationSection_organizationId_key_key"
    ON "IoioLabInformationSection"("organizationId", "key");
CREATE INDEX "IoioLabInformationSection_organizationId_position_idx"
    ON "IoioLabInformationSection"("organizationId", "position");
CREATE INDEX "IoioLabInformationImage_sectionId_position_idx"
    ON "IoioLabInformationImage"("sectionId", "position");

ALTER TABLE "IoioLabInformationSection"
    ADD CONSTRAINT "IoioLabInformationSection_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IoioLabInformationImage"
    ADD CONSTRAINT "IoioLabInformationImage_sectionId_fkey"
    FOREIGN KEY ("sectionId") REFERENCES "IoioLabInformationSection"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
