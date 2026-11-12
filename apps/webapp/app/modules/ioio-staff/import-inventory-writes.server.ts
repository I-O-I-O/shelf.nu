import { createAsset, updateAsset } from "~/modules/asset/service.server";
import { ShelfError } from "~/utils/error";
import { id } from "~/utils/id/id.server";
import { Logger } from "~/utils/logger";

export const IMPORT_NON_DESTRUCTIVE_MESSAGE =
  "Inventory import cannot delete, archive, or undo Shelf inventory. Use the separate Shelf inventory workflow.";

function forbidden(message = IMPORT_NON_DESTRUCTIVE_MESSAGE): never {
  throw new ShelfError({
    cause: null,
    message,
    label: "Assets",
    status: 403,
    shouldBeCaptured: false,
  });
}

/** Only these canonical operations exist at the import write boundary. */
export function assertImportInventoryOperation(operation: string) {
  if (
    ![
      "CREATE_ASSET",
      "CREATE_ASSET_MODEL",
      "SET_QUANTITY",
      "SET_CATEGORY",
      "ENRICH_MODEL",
    ].includes(operation)
  )
    forbidden();
}

type ImportWriteScope = { importSessionId: string; importCandidateId: string };
function audit(
  scope: ImportWriteScope,
  operationType: string,
  assetId: string | null,
  assetModelId: string | null
) {
  Logger.info({
    event: "ioio_import_canonical_write",
    importSessionId: scope.importSessionId,
    candidateId: scope.importCandidateId,
    operationType,
    assetId,
    assetModelId,
  });
}

export async function createImportAsset(
  input: Parameters<typeof createAsset>[0] & ImportWriteScope
) {
  assertImportInventoryOperation("CREATE_ASSET");
  const { importSessionId, importCandidateId, ...args } = input;
  if (
    args.type === "QUANTITY_TRACKED" &&
    (!Number.isSafeInteger(args.quantity) || (args.quantity ?? 0) <= 0)
  )
    forbidden("Import quantities must be positive. Import cannot zero stock.");
  if (
    [
      "deletedAt",
      "archivedAt",
      "ioioHidden",
      "delete",
      "deleteMany",
      "disconnect",
      "status",
    ].some((key) => Object.hasOwn(args, key))
  )
    forbidden();
  const assetId = args.id ?? id();
  Logger.info({
    event: "ioio_import_canonical_write_attempt",
    importSessionId,
    candidateId: importCandidateId,
    operationType: "CREATE_ASSET",
    assetId,
    assetModelId: args.assetModelId ?? null,
  });
  const asset = await createAsset({ ...args, id: assetId });
  audit(
    { importSessionId, importCandidateId },
    "CREATE_ASSET",
    asset.id,
    args.assetModelId ?? null
  );
  return asset;
}

/** Field allowlist prevents destructive tracking/lifecycle/placement mutations.
 * Canonical updateAsset owns row locking, placement constraints and transactionality.
 * Existing placements cannot be replaced here, including through a forged payload.
 * New-asset placement remains supported by createImportAsset(locationId).
 */
export async function updateImportAsset(
  input: Parameters<typeof updateAsset>[0] & ImportWriteScope
) {
  const { importSessionId, importCandidateId, ...args } = input;
  const allowed = new Set([
    "id",
    "organizationId",
    "userId",
    "request",
    "quantity",
    "categoryId",
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key)))
    forbidden(
      "Import cannot replace or remove existing placements or change inventory lifecycle. Use Shelf's asset workflow."
    );
  const hasQuantity = Object.hasOwn(args, "quantity");
  const hasCategory = Object.hasOwn(args, "categoryId");
  if (hasQuantity === hasCategory) forbidden();
  if (
    hasQuantity &&
    (!Number.isSafeInteger(args.quantity) || (args.quantity ?? 0) <= 0)
  )
    forbidden("Import quantities must be positive. Import cannot zero stock.");
  if (hasCategory && !args.categoryId)
    forbidden("Import cannot clear an existing category.");
  const operationType = hasQuantity ? "SET_QUANTITY" : "SET_CATEGORY";
  assertImportInventoryOperation(operationType);
  Logger.info({
    event: "ioio_import_canonical_write_attempt",
    importSessionId,
    candidateId: importCandidateId,
    operationType,
    assetId: args.id,
  });
  const asset = await updateAsset(args);
  audit({ importSessionId, importCandidateId }, operationType, args.id, null);
  return asset;
}
