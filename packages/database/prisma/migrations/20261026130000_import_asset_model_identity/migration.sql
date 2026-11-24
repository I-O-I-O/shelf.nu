-- Optional importer-only identity. Existing AssetModels remain unkeyed and
-- duplicate names remain allowed; only populated keys are unique per org.
ALTER TABLE "AssetModel" ADD COLUMN "importIdentityKey" TEXT;

CREATE UNIQUE INDEX "AssetModel_organizationId_importIdentityKey_key"
  ON "AssetModel"("organizationId", "importIdentityKey");
