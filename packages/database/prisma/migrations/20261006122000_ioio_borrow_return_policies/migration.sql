ALTER TABLE "Asset"
ADD COLUMN "requiresBorrowApproval" BOOLEAN NOT NULL DEFAULT false;


ALTER TABLE "Asset"
ADD COLUMN "requiresReturnPhoto" BOOLEAN NOT NULL DEFAULT false;


CREATE TYPE "AssetReturnHandling" AS ENUM ('RETURN_TO_STORAGE', 'RETURN_TO_RETURN_ZONE');

ALTER TABLE "Asset"
ADD COLUMN "returnHandling" "AssetReturnHandling" NOT NULL DEFAULT 'RETURN_TO_STORAGE';

-- Existing Kit members were already routed through the Kit return workflow.
-- Preserve that behavior in the new explicit asset-level setting. Future
-- changes made in Asset Edit are authoritative and can override it.
UPDATE "Asset"
SET "returnHandling" = 'RETURN_TO_RETURN_ZONE'
WHERE "id" IN (SELECT "assetId" FROM "AssetKit");

-- Native Shelf Kit membership is also represented on historical booking
-- slices. Preserve the previous Kit return behavior for those physical asset
-- records when there is no AssetKit pivot row.
UPDATE "Asset"
SET "returnHandling" = 'RETURN_TO_RETURN_ZONE'
WHERE "id" IN (
  SELECT DISTINCT "assetId"
  FROM "BookingAsset"
  WHERE "sourceKitId" IS NOT NULL
);


ALTER TABLE "Asset"
ADD COLUMN "requiresStaffPreparation" BOOLEAN NOT NULL DEFAULT false;


ALTER TABLE "Kit"
ADD COLUMN "maxBorrowDays" INTEGER NOT NULL DEFAULT 14;



ALTER TABLE "Asset"
ADD COLUMN "maxBorrowDays" INTEGER NOT NULL DEFAULT 45;

-- Existing Kit records already carry the configured duration. Copy it to
-- their member Assets so the shared Asset borrowing path has one source of
-- truth for all physical units.
UPDATE "Asset" AS asset
SET "maxBorrowDays" = kit."maxBorrowDays"
FROM "AssetKit" AS asset_kit
JOIN "Kit" AS kit ON kit."id" = asset_kit."kitId"
WHERE asset."id" = asset_kit."assetId";


ALTER TABLE "Asset"
ADD COLUMN "extensionBorrowDays" INTEGER;

ALTER TABLE "Kit"
ADD COLUMN "extensionBorrowDays" INTEGER;
