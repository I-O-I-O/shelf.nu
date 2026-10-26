import { createHash } from "node:crypto";
import { db } from "~/database/db.server";
import { createAssetModel } from "~/modules/asset-model/service.server";

type ImportAssetModelIdentityInput = {
  name: string;
  manufacturer?: string | null;
  manufacturerPartNumber?: string | null;
};

type ImportAssetModelResolution =
  | { status: "RESOLVED"; assetModelId: string; importIdentityKey: string }
  | { status: "CONFLICT"; code: string; reason: string };

export class ImportAssetModelConflictError extends Error {
  code: string;

  constructor(code: string, reason: string) {
    super(reason);
    this.name = "ImportAssetModelConflictError";
    this.code = code;
  }
}

export function normalizeImportProductIdentityPart(value: string) {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

/** Exact versioned identity; no fuzzy or title-similarity matching is used. */
export function getImportAssetModelIdentity({
  name,
  manufacturer,
  manufacturerPartNumber,
}: ImportAssetModelIdentityInput) {
  const normalizedName = normalizeImportProductIdentityPart(name);
  const normalizedManufacturer = manufacturer
    ? normalizeImportProductIdentityPart(manufacturer)
    : "";
  const normalizedMpn = manufacturerPartNumber
    ? normalizeImportProductIdentityPart(manufacturerPartNumber)
    : "";
  const hasStrongIdentity = Boolean(normalizedManufacturer && normalizedMpn);
  const identity = hasStrongIdentity
    ? ["manufacturer-mpn", normalizedManufacturer, normalizedMpn]
    : ["name", normalizedName];
  const digest = createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");

  return {
    strategy: hasStrongIdentity
      ? ("MANUFACTURER_MPN" as const)
      : ("NAME" as const),
    normalizedName,
    key: `ioio-import:v1:${digest}`,
  };
}

async function findByIdentityKey(organizationId: string, key: string) {
  return db.assetModel.findFirst({
    where: { organizationId, importIdentityKey: key },
    select: { id: true },
  });
}

function isUniqueViolation(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "P2002";
}

/**
 * Import-scoped canonical model resolution. The nullable compound unique key
 * serializes concurrent exact identities without constraining native models.
 */
export async function resolveImportAssetModel({
  organizationId,
  userId,
  name,
  manufacturer,
  manufacturerPartNumber,
  description,
  defaultCategoryId,
  defaultValuation,
  preferredModelId,
}: ImportAssetModelIdentityInput & {
  organizationId: string;
  userId: string;
  description?: string | null;
  defaultCategoryId?: string | null;
  defaultValuation?: number | null;
  preferredModelId?: string;
}): Promise<ImportAssetModelResolution> {
  const identity = getImportAssetModelIdentity({
    name,
    manufacturer,
    manufacturerPartNumber,
  });
  if (!identity.normalizedName) {
    return {
      status: "CONFLICT",
      code: "IMPORT_ASSET_MODEL_NAME_MISSING",
      reason: "A product name is required to identify its AssetModel.",
    };
  }

  const keyedModel = await findByIdentityKey(organizationId, identity.key);
  if (identity.strategy === "NAME") {
    const nameMatches = await db.assetModel.findMany({
      where: {
        organizationId,
        name: { equals: identity.normalizedName, mode: "insensitive" },
      },
      select: { id: true, name: true, importIdentityKey: true },
    });
    const exactNormalizedMatches = nameMatches.filter(
      (model) =>
        normalizeImportProductIdentityPart(model.name) ===
        identity.normalizedName
    );
    if (exactNormalizedMatches.length > 1) {
      return {
        status: "CONFLICT",
        code: "AMBIGUOUS_IMPORT_ASSET_MODEL_NAME",
        reason:
          "Multiple existing AssetModels have this normalized product name; staff review is required.",
      };
    }
    const existingByName = exactNormalizedMatches[0];
    if (keyedModel) {
      if (existingByName && existingByName.id !== keyedModel.id) {
        return {
          status: "CONFLICT",
          code: "AMBIGUOUS_IMPORT_ASSET_MODEL_NAME",
          reason:
            "The normalized name matches a different AssetModel than the previously resolved import identity.",
        };
      }
      return {
        status: "RESOLVED",
        assetModelId: keyedModel.id,
        importIdentityKey: identity.key,
      };
    }
    if (existingByName) {
      if (
        existingByName.importIdentityKey &&
        existingByName.importIdentityKey !== identity.key
      ) {
        return {
          status: "CONFLICT",
          code: "IMPORT_ASSET_MODEL_IDENTITY_MISMATCH",
          reason:
            "The matching AssetModel already has a different canonical import identity.",
        };
      }
      if (existingByName.importIdentityKey === identity.key) {
        return {
          status: "RESOLVED",
          assetModelId: existingByName.id,
          importIdentityKey: identity.key,
        };
      }

      try {
        const attached = await db.assetModel.updateMany({
          where: {
            id: existingByName.id,
            organizationId,
            importIdentityKey: null,
          },
          data: { importIdentityKey: identity.key },
        });
        if (attached.count === 1) {
          return {
            status: "RESOLVED",
            assetModelId: existingByName.id,
            importIdentityKey: identity.key,
          };
        }
      } catch (cause) {
        if (!isUniqueViolation(cause)) throw cause;
      }

      const concurrentWinner = await findByIdentityKey(
        organizationId,
        identity.key
      );
      if (concurrentWinner) {
        return {
          status: "RESOLVED",
          assetModelId: concurrentWinner.id,
          importIdentityKey: identity.key,
        };
      }
      return {
        status: "CONFLICT",
        code: "IMPORT_ASSET_MODEL_IDENTITY_CHANGED",
        reason:
          "The existing AssetModel changed identity during resolution; staff review is required.",
      };
    }
  }

  if (keyedModel) {
    return {
      status: "RESOLVED",
      assetModelId: keyedModel.id,
      importIdentityKey: identity.key,
    };
  }

  try {
    const model = await createAssetModel({
      id: preferredModelId,
      importIdentityKey: identity.key,
      name: name.trim(),
      description,
      defaultCategoryId,
      defaultValuation,
      userId,
      organizationId,
    });
    return {
      status: "RESOLVED",
      assetModelId: model.id,
      importIdentityKey: identity.key,
    };
  } catch (cause) {
    // The service rereads on a key collision. This second lookup also covers
    // errors wrapped by Shelf's common constraint handler.
    const concurrentWinner = await findByIdentityKey(
      organizationId,
      identity.key
    );
    if (concurrentWinner) {
      return {
        status: "RESOLVED",
        assetModelId: concurrentWinner.id,
        importIdentityKey: identity.key,
      };
    }
    throw cause;
  }
}
