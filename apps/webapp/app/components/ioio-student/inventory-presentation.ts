import { buildInventoryDisplayRows } from "~/modules/asset/inventory-grouping";
import {
  getPhysicalUnitNumberFromTitle,
  normalizePhysicalUnitNumber,
} from "~/modules/asset/physical-unit";
import type {
  StudentAsset,
  StudentLocation,
} from "~/modules/ioio-student/service.server";

export type StudentInventoryItem = StudentAsset & {
  sourceAssetIds: string[];
};

export type StudentLabAreaFilter = {
  key: string;
  label: string;
  code: string | null;
  locationId: string | null;
};

/** Whether the user explicitly asked to see physical-unit-level results. */
export function asksForPhysicalUnits(question: string) {
  return (
    /#\s*\d+/u.test(question) ||
    /\b(?:each|every|individually|unit numbers?)\b/i.test(question) ||
    /\b(?:show|list|display)\b[^?]*\b(?:physical\s+)?units?\b/i.test(
      question
    ) ||
    /\bwhich\b[^?]*\bunits?\b/i.test(question)
  );
}

/** Conversational inventory answers should not automatically become result cards. */
export function requestsStudentAssistantAssetCards(question: string) {
  return (
    asksForPhysicalUnits(question) ||
    /\b(?:recommend|suggest|what\s+(?:should|could|can)\s+i\s+use)\b/i.test(
      question
    ) ||
    /\b(?:show me|list|browse|find|locate)\b/i.test(question) ||
    /\bwhich\b[^?]*\b(?:items?|assets?|products?|kits?|units?)\b/i.test(
      question
    ) ||
    (/\b(?:what\s+(?:kind|type|sort)|how\s+many|do\s+(?:we|you)\s+have|where\s+(?:is|are)|is\s+there|are\s+there)\b/i.test(
      question
    ) &&
      /\b(?:kit|kits|item|items|asset|assets|product|products|equipment)\b/i.test(
        question
      ))
  );
}

export function getStudentLabAreaFilters(
  locations: StudentLocation[]
): StudentLabAreaFilter[] {
  const labRooms = locations.filter((location) =>
    /\blab\b/i.test(location.name)
  );
  const roots = labRooms.length ? labRooms : locations;
  const areas = roots.flatMap((room) => room.children);
  const browseableAreas = areas.filter((area) => {
    const normalizedName = area.name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    return !/(?:^|\s)(?:pick\s*-?\s*up|return|broken|problem)(?:\s|$)/u.test(
      normalizedName
    );
  });

  const candidates = browseableAreas.length
    ? browseableAreas
    : roots.filter((location) => location.children.length === 0);

  return [
    { key: "all", label: "All areas", code: null, locationId: null },
    ...candidates.map((location) => ({
      key: location.id,
      label: location.name,
      code: null,
      locationId: location.id,
    })),
  ];
}

/**
 * Applies the same deterministic canonical grouping as Staff Inventory.
 * AssetModel-linked individual units are presented as one product with
 * availability summed from those physical records. Same-name imported or
 * duplicate records without a shared AssetModel select one canonical record
 * and do not have their quantities combined.
 */
export function groupStudentAssets(
  assets: StudentAsset[]
): StudentInventoryItem[] {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const candidates = assets.map((asset) => ({
    ...asset,
    // Preserve the stable logical-product key when a legacy row has no
    // hydrated model object. Display fields remain organization-scoped by the
    // server service.
    assetModelId: asset.assetModelId ?? asset.assetModel?.id ?? null,
    assetLocations: asset.locations,
  }));

  return buildInventoryDisplayRows(candidates).map((row) => {
    const canonical = assetsById.get(row.id)!;
    const physicalUnits = row.isExpandable
      ? row.members.flatMap((member) => {
          const asset = assetsById.get(member.id);
          return asset ? [asset] : [];
        })
      : [canonical];
    const isModelLinkedIndividual =
      canonical.type === "INDIVIDUAL" &&
      Boolean(canonical.assetModelId ?? canonical.assetModel?.id);
    const modelHasImage = Boolean(canonical.assetModel?.image);
    const representativeWithImage = [...physicalUnits]
      .filter((asset) => Boolean(asset.mainImage || asset.kitImage))
      .sort((left, right) => {
        const leftUnit = getPhysicalUnitNumberFromTitle(left.title) ?? "~~~~";
        const rightUnit = getPhysicalUnitNumberFromTitle(right.title) ?? "~~~~";
        return (
          leftUnit.localeCompare(rightUnit) || left.id.localeCompare(right.id)
        );
      })[0];
    // Prefer the shared product cover on a grouped card over a unit-specific
    // photo. If no product/canonical image exists, choose the first numbered
    // unit with either an asset or native Kit image as a stable fallback.
    const representativeImage =
      !modelHasImage && !canonical.mainImage && !canonical.kitImage
        ? representativeWithImage
        : null;
    const totalQuantity = row.isExpandable
      ? physicalUnits.reduce(
          (total, asset) =>
            total +
            (asset.type === "QUANTITY_TRACKED" ? asset.quantity ?? 0 : 1),
          0
        )
      : isModelLinkedIndividual
      ? 1
      : canonical.quantity;
    const locations = new Map<string, StudentAsset["locations"][number]>();
    const kits = new Map<string, StudentAsset["kits"][number]>();
    const qrIds = new Set<string>();

    for (const asset of physicalUnits) {
      for (const location of asset.locations) {
        const previous = locations.get(location.id);
        locations.set(location.id, {
          ...location,
          quantity: (previous?.quantity ?? 0) + location.quantity,
        });
      }
      for (const kit of asset.kits) {
        const previous = kits.get(kit.id);
        kits.set(kit.id, {
          ...kit,
          quantity: (previous?.quantity ?? 0) + kit.quantity,
        });
      }
      for (const qrId of asset.qrIds) qrIds.add(qrId);
    }

    return {
      ...canonical,
      title: isModelLinkedIndividual
        ? canonical.assetModel?.name ?? row.logicalTitle
        : row.logicalTitle,
      ...(modelHasImage
        ? {
            mainImage: null,
            thumbnailImage: null,
            mainImageExpiration: null,
          }
        : {}),
      ...(representativeImage
        ? {
            mainImage: representativeImage.mainImage,
            mainImageExpiration: representativeImage.mainImageExpiration,
            thumbnailImage: representativeImage.thumbnailImage,
            kitImage: representativeImage.kitImage,
          }
        : {}),
      quantity: totalQuantity,
      availableQuantity: row.isExpandable
        ? physicalUnits.reduce(
            (total, asset) => total + (asset.availableQuantity ?? 0),
            0
          )
        : canonical.availableQuantity,
      availableToBook: row.isExpandable
        ? physicalUnits.some((asset) => asset.availableToBook)
        : canonical.availableToBook,
      locations: [...locations.values()],
      kits: [...kits.values()],
      qrIds: [...qrIds],
      sourceAssetIds: row.members.map((member) => member.id),
    };
  });
}

/**
 * Select intentional UI results separately from inventory records used as
 * private grounding context. Default to no cards for normal questions; when a
 * product-level result is requested, use Shelf's canonical logical grouping.
 */
export function selectStudentAssistantDisplayAssets(
  question: string,
  assets: StudentAsset[]
): StudentAsset[] {
  if (!requestsStudentAssistantAssetCards(question)) return [];
  if (asksForPhysicalUnits(question)) {
    const requestedUnitNumber = question.match(/#\s*(\d+)/u)?.[1];
    if (!requestedUnitNumber) return assets;

    const normalizedUnitNumber =
      normalizePhysicalUnitNumber(requestedUnitNumber);
    return normalizedUnitNumber
      ? assets.filter(
          (asset) =>
            getPhysicalUnitNumberFromTitle(asset.title) === normalizedUnitNumber
        )
      : [];
  }
  return groupStudentAssets(assets);
}

export function filterStudentInventory(
  assets: StudentInventoryItem[],
  filters: {
    categoryId?: string | null;
    availability?: string | null;
    itemType?: string | null;
  }
) {
  return assets.filter((asset) => {
    if (filters.categoryId && asset.category?.id !== filters.categoryId) {
      return false;
    }
    if (filters.availability === "available" && !asset.availableQuantity) {
      return false;
    }
    if (filters.availability === "unavailable" && asset.availableQuantity) {
      return false;
    }
    if (filters.itemType === "quantity" && asset.type !== "QUANTITY_TRACKED") {
      return false;
    }
    if (
      filters.itemType === "individual" &&
      asset.type === "QUANTITY_TRACKED"
    ) {
      return false;
    }
    return true;
  });
}
