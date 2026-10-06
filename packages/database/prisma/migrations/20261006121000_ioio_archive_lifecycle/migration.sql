-- IOIO-only archive markers. Native Asset and Kit rows remain intact so
-- relationships, images, and Shelf history survive archive and restore.
CREATE TYPE "IoioItemDisposition" AS ENUM ('ARCHIVE', 'TRASH');

CREATE TYPE "IoioArchivedItemType" AS ENUM ('ASSET', 'KIT', 'CATEGORY');

CREATE TABLE "IoioArchivedItem" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemType" "IoioArchivedItemType" NOT NULL,
    "itemId" TEXT NOT NULL,
    "disposition" "IoioItemDisposition" NOT NULL DEFAULT 'ARCHIVE',
    "originalCategoryId" TEXT,
    "originalCategoryName" TEXT,
    "originalLocationId" TEXT,
    "originalLocationName" TEXT,
    "archivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedById" TEXT NOT NULL,
    "restoredAt" TIMESTAMPTZ(3),
    "restoredById" TEXT,

    CONSTRAINT "IoioArchivedItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IoioArchivedItem_organizationId_restoredAt_idx"
  ON "IoioArchivedItem"("organizationId", "restoredAt");

CREATE INDEX "IoioArchivedItem_organizationId_itemType_itemId_restoredAt_idx"
  ON "IoioArchivedItem"("organizationId", "itemType", "itemId", "restoredAt");

-- Only one active archive marker may exist for a native item at a time.
CREATE UNIQUE INDEX "IoioArchivedItem_active_item_key"
  ON "IoioArchivedItem"("organizationId", "itemType", "itemId")
  WHERE "restoredAt" IS NULL;

CREATE INDEX "IoioArchivedItem_organizationId_disposition_restoredAt_idx"
  ON "IoioArchivedItem"("organizationId", "disposition", "restoredAt");
