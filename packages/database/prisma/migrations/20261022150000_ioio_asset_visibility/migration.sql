-- IOIO student visibility is independent of physical availability and Shelf's
-- archive/trash lifecycle. Models hide a grouped product; standalone assets
-- use the asset-level flag.
ALTER TABLE "Asset"
  ADD COLUMN "ioioHidden" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "AssetModel"
  ADD COLUMN "ioioHidden" BOOLEAN NOT NULL DEFAULT false;
