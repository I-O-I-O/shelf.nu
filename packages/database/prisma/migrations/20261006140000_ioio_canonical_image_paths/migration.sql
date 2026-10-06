-- Canonical image identity is a Storage bucket object path, independent of the
-- configured Supabase endpoint. Keep legacy URL columns intact for gradual,
-- non-destructive compatibility; existing references are not rewritten here.
ALTER TABLE "Asset"
  ADD COLUMN "mainImageStoragePath" TEXT,
  ADD COLUMN "thumbnailImageStoragePath" TEXT;

ALTER TABLE "AssetModel"
  ADD COLUMN "imageStoragePath" TEXT,
  ADD COLUMN "thumbnailImageStoragePath" TEXT;

ALTER TABLE "Kit"
  ADD COLUMN "imageStoragePath" TEXT;

ALTER TABLE "Location"
  ADD COLUMN "imageStoragePath" TEXT,
  ADD COLUMN "thumbnailImageStoragePath" TEXT;

ALTER TABLE "AuditImage"
  ADD COLUMN "imageStoragePath" TEXT,
  ADD COLUMN "thumbnailImageStoragePath" TEXT;

-- New audit uploads keep canonical object paths rather than persisting
-- endpoint-specific public URLs. Existing URL-only audit rows remain valid.
ALTER TABLE "AuditImage" ALTER COLUMN "imageUrl" DROP NOT NULL;
