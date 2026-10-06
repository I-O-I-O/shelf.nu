import { AssetStatus, AssetType, KitStatus } from "@prisma/client";
import JSZip from "jszip";
import { db } from "~/database/db.server";
import { getAssetAvailabilityBatch } from "~/modules/asset/availability.server";
import { getIndividualUnitAvailability } from "~/modules/asset/individual-product-quantity.server";
import { buildStaffInventoryDisplayRows } from "~/modules/asset/staff-inventory-view";
import {
  IOIO_ARCHIVE_ITEM_TYPE,
  IOIO_ITEM_DISPOSITION,
  type IoioItemDisposition,
} from "~/modules/ioio-staff/archive.server";

type CsvValue = Date | boolean | number | null | string | undefined;

type BackupAsset = {
  id: string;
  title: string;
  type: AssetType;
  status: AssetStatus;
  quantity: number | null;
  availableToBook: boolean;
  assetModelId: string | null;
  assetModel: { id: string; name: string } | null;
  sequentialId: string | null;
  category: { id: string; name: string } | null;
  assetLocations: Array<{
    quantity: number;
    location: { id: string; name: string; parentId: string | null };
  }>;
  assetKits: Array<{ quantity: number; kit: { id: string; name: string } }>;
};

type BackupLocation = {
  id: string;
  name: string;
  parentId: string | null;
};

export type IoioBackupPreview = {
  inventory: number;
  physicalUnits: number;
  categories: number;
  locations: number;
  kits: number;
};

export type IoioBackupRestoreResult = IoioBackupPreview;

export class IoioBackupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IoioBackupValidationError";
  }
}

function csvValue(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function csv(rows: Array<Record<string, CsvValue>>, columns: string[]) {
  const escape = (value: CsvValue) => {
    const text = csvValue(value);
    return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };

  return [
    columns.join(","),
    ...rows.map((row) =>
      columns.map((column) => escape(row[column])).join(",")
    ),
  ].join("\r\n");
}

function locationPath(
  locationId: string | null | undefined,
  locationsById: Map<string, BackupLocation>
) {
  const names: string[] = [];
  const seen = new Set<string>();
  let currentId = locationId ?? null;

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const location = locationsById.get(currentId);
    if (!location) break;
    names.unshift(location.name);
    currentId = location.parentId;
  }

  return names.join(" / ");
}

function locationsForAsset(
  asset: Pick<BackupAsset, "assetLocations">,
  locationsById: Map<string, BackupLocation>
) {
  return asset.assetLocations
    .map(({ location }) => locationPath(location.id, locationsById))
    .filter(Boolean)
    .join(" | ");
}

function locationIdsForAsset(asset: Pick<BackupAsset, "assetLocations">) {
  return asset.assetLocations.map(({ location }) => location.id).join(" | ");
}

function locationQuantitiesForAsset(
  asset: Pick<BackupAsset, "assetLocations">
) {
  return asset.assetLocations
    .map(({ quantity, location }) => `${location.id}:${quantity}`)
    .join(" | ");
}

function unitNumber(title: string, sequentialId: string | null) {
  const match = title.match(/#\d+$/u);
  return match?.[0] ?? sequentialId ?? "";
}

function lifecycleState(
  assetId: string,
  dispositions: Map<string, "ARCHIVE" | "TRASH">
) {
  return dispositions.get(assetId) ?? "ACTIVE";
}

export async function createIoioInventoryBackup({
  organizationId,
}: {
  organizationId: string;
}) {
  const [locations, categories, assets, kits, lifecycleRows] =
    await Promise.all([
      db.location.findMany({
        where: { organizationId },
        orderBy: [{ parentId: "asc" }, { name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, parentId: true },
      }),
      db.category.findMany({
        where: { organizationId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, description: true, color: true },
      }),
      db.asset.findMany({
        where: { organizationId },
        orderBy: [{ title: "asc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          type: true,
          status: true,
          quantity: true,
          availableToBook: true,
          assetModelId: true,
          sequentialId: true,
          assetModel: { select: { id: true, name: true } },
          category: { select: { id: true, name: true } },
          assetLocations: {
            select: {
              quantity: true,
              location: { select: { id: true, name: true, parentId: true } },
            },
          },
          assetKits: {
            select: {
              quantity: true,
              kit: { select: { id: true, name: true } },
            },
          },
        },
      }),
      db.kit.findMany({
        where: { organizationId },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: {
          id: true,
          name: true,
          status: true,
          categoryId: true,
          locationId: true,
          maxBorrowDays: true,
          extensionBorrowDays: true,
        },
      }),
      db.ioioArchivedItem.findMany({
        where: {
          organizationId,
          restoredAt: null,
          itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
        },
        orderBy: { archivedAt: "desc" },
        select: { itemId: true, disposition: true },
      }),
    ]);

  const locationsById = new Map(
    locations.map((location) => [location.id, location])
  );
  const dispositions = new Map<string, "ARCHIVE" | "TRASH">();
  for (const row of lifecycleRows) {
    if (!dispositions.has(row.itemId))
      dispositions.set(row.itemId, row.disposition);
  }

  const activeAssets = assets.filter((asset) => !dispositions.has(asset.id));
  const archivedAssets = assets.filter((asset) => dispositions.has(asset.id));
  const activeRows = buildStaffInventoryDisplayRows(activeAssets);
  const activeLogicalKeys = new Set(
    activeRows.map(
      (row) =>
        row.assetModelId ??
        row.assetModel?.id ??
        `title:${row.logicalTitle.trim().toLocaleLowerCase()}`
    )
  );
  const archivedRows = buildStaffInventoryDisplayRows(archivedAssets).filter(
    (row) =>
      !activeLogicalKeys.has(
        row.assetModelId ??
          row.assetModel?.id ??
          `title:${row.logicalTitle.trim().toLocaleLowerCase()}`
      )
  );
  const logicalRows = [...activeRows, ...archivedRows];
  const activeAssetIds = activeAssets.map((asset) => asset.id);
  const availability = await getAssetAvailabilityBatch(activeAssetIds, {
    organizationId,
    window: null,
  });

  const inventoryRows: Array<Record<string, CsvValue>> = [];
  const physicalUnitRows: Array<Record<string, CsvValue>> = [];
  const exportedPhysicalUnitIds = new Set<string>();

  for (const row of logicalRows) {
    const members = row.members;
    const activeMembers = members.filter(
      (member) => !dispositions.has(member.id)
    );
    const isIndividualProduct =
      row.isExpandable ||
      (row.type === AssetType.INDIVIDUAL && Boolean(row.assetModelId));
    let totalQuantity = 0;
    let availableQuantity = 0;

    if (isIndividualProduct) {
      totalQuantity = activeMembers.filter(
        (member) => member.type === AssetType.INDIVIDUAL
      ).length;
      const individualAvailability = await getIndividualUnitAvailability({
        organizationId,
        assetIds: activeMembers
          .filter((member) => member.type === AssetType.INDIVIDUAL)
          .map((member) => member.id),
        window: null,
      });
      availableQuantity = individualAvailability.available;
    } else {
      const canonical = row;
      totalQuantity =
        canonical.type === AssetType.QUANTITY_TRACKED
          ? Math.max(0, canonical.quantity ?? 0)
          : activeMembers.length > 0
          ? 1
          : 0;
      availableQuantity =
        dispositions.has(canonical.id) || !activeMembers.length
          ? 0
          : canonical.type === AssetType.QUANTITY_TRACKED
          ? Math.max(0, availability.get(canonical.id)?.physicalAvailable ?? 0)
          : canonical.status === AssetStatus.AVAILABLE &&
            canonical.availableToBook
          ? 1
          : 0;
    }

    const state = lifecycleState(row.id, dispositions);
    inventoryRows.push({
      asset_id: row.id,
      asset_name: row.logicalTitle,
      asset_model_id: row.assetModelId ?? row.assetModel?.id ?? "",
      asset_model_name: row.assetModel?.name ?? "",
      category_id: row.category?.id ?? "",
      category: row.category?.name ?? "",
      tracking_method: row.type ?? "",
      total_quantity: totalQuantity,
      available_quantity: availableQuantity,
      lifecycle_state: state,
      location: locationsForAsset(row, locationsById),
      location_ids: locationIdsForAsset(row),
      location_quantities: locationQuantitiesForAsset(row),
      kit_ids: row.assetKits.map(({ kit }) => kit.id).join(" | "),
      kits: row.assetKits.map(({ kit }) => kit.name).join(" | "),
    });

    if (isIndividualProduct) {
      for (const member of activeMembers.filter(
        (candidate) => candidate.type === AssetType.INDIVIDUAL
      )) {
        physicalUnitRows.push({
          physical_unit_id: member.id,
          logical_asset_id: row.id,
          logical_product: row.logicalTitle,
          asset_model_id: member.assetModelId ?? member.assetModel?.id ?? "",
          asset_model_name: member.assetModel?.name ?? "",
          unit_number: unitNumber(member.title, member.sequentialId),
          unit_status: member.status,
          available_to_book: member.availableToBook,
          lifecycle_state: lifecycleState(member.id, dispositions),
          location: locationsForAsset(member, locationsById),
          location_ids: locationIdsForAsset(member),
          location_quantities: locationQuantitiesForAsset(member),
          kit_ids: member.assetKits.map(({ kit }) => kit.id).join(" | "),
          kits: member.assetKits.map(({ kit }) => kit.name).join(" | "),
        });
        exportedPhysicalUnitIds.add(member.id);
      }
    }
  }

  // Keep real physical-unit records visible in the backup even when a unit is
  // archived or trashed alongside an otherwise active logical product.
  for (const asset of assets) {
    if (
      asset.type !== AssetType.INDIVIDUAL ||
      exportedPhysicalUnitIds.has(asset.id)
    ) {
      continue;
    }

    const logicalRow = logicalRows.find(
      (row) =>
        (asset.assetModelId &&
          (row.assetModelId === asset.assetModelId ||
            row.assetModel?.id === asset.assetModelId)) ||
        (!asset.assetModelId &&
          row.logicalTitle.trim().toLocaleLowerCase() ===
            asset.title
              .replace(/\s+#\d+$/u, "")
              .trim()
              .toLocaleLowerCase())
    );
    physicalUnitRows.push({
      physical_unit_id: asset.id,
      logical_asset_id: logicalRow?.id ?? asset.id,
      logical_product:
        asset.assetModel?.name ?? asset.title.replace(/\s+#\d+$/u, ""),
      asset_model_id: asset.assetModelId ?? asset.assetModel?.id ?? "",
      asset_model_name: asset.assetModel?.name ?? "",
      unit_number: unitNumber(asset.title, asset.sequentialId),
      unit_status: asset.status,
      available_to_book: asset.availableToBook,
      lifecycle_state: lifecycleState(asset.id, dispositions),
      location: locationsForAsset(asset, locationsById),
      location_ids: locationIdsForAsset(asset),
      location_quantities: locationQuantitiesForAsset(asset),
      kit_ids: asset.assetKits.map(({ kit }) => kit.id).join(" | "),
      kits: asset.assetKits.map(({ kit }) => kit.name).join(" | "),
    });
  }

  const locationRows = locations.map((location) => ({
    location_id: location.id,
    name: location.name,
    parent_id: location.parentId ?? "",
    hierarchy_level: locationPath(location.id, locationsById)
      .split(" / ")
      .filter(Boolean).length,
    full_path: locationPath(location.id, locationsById),
  }));
  const categoryRows = categories.map((category) => ({
    category_id: category.id,
    name: category.name,
    description: category.description ?? "",
    color: category.color,
  }));

  const zip = new JSZip();
  zip.file(
    "inventory.csv",
    csv(inventoryRows, [
      "asset_id",
      "asset_name",
      "asset_model_id",
      "asset_model_name",
      "category_id",
      "category",
      "tracking_method",
      "total_quantity",
      "available_quantity",
      "lifecycle_state",
      "location",
      "location_ids",
      "location_quantities",
      "kit_ids",
      "kits",
    ])
  );
  zip.file(
    "physical-units.csv",
    csv(physicalUnitRows, [
      "physical_unit_id",
      "logical_asset_id",
      "logical_product",
      "asset_model_id",
      "asset_model_name",
      "unit_number",
      "unit_status",
      "available_to_book",
      "lifecycle_state",
      "location",
      "location_ids",
      "location_quantities",
      "kit_ids",
      "kits",
    ])
  );
  zip.file(
    "locations.csv",
    csv(locationRows, [
      "location_id",
      "name",
      "parent_id",
      "hierarchy_level",
      "full_path",
    ])
  );
  zip.file(
    "categories.csv",
    csv(categoryRows, ["category_id", "name", "description", "color"])
  );
  zip.file(
    "kits.csv",
    csv(
      kits.map((kit) => ({
        kit_id: kit.id,
        name: kit.name,
        status: kit.status,
        category_id: kit.categoryId ?? "",
        location_id: kit.locationId ?? "",
        max_borrow_days: kit.maxBorrowDays,
        extension_borrow_days: kit.extensionBorrowDays ?? "",
      })),
      [
        "kit_id",
        "name",
        "status",
        "category_id",
        "location_id",
        "max_borrow_days",
        "extension_borrow_days",
      ]
    )
  );
  zip.file(
    "README.txt",
    [
      "IOIO inventory backup",
      "",
      "This readable export contains canonical inventory, active physical units, locations, and categories.",
      "It does not contain credentials, tokens, secrets, or personal account data.",
      "The export is a safety snapshot, not a database recovery dump.",
    ].join("\n")
  );

  return zip.generateAsync({ type: "uint8array" });
}

type ParsedBackupRow = Record<string, string>;

export type ParsedIoioBackup = {
  inventory: ParsedBackupRow[];
  physicalUnits: ParsedBackupRow[];
  categories: ParsedBackupRow[];
  locations: ParsedBackupRow[];
  kits: ParsedBackupRow[];
};

const REQUIRED_BACKUP_FILES = [
  "inventory.csv",
  "physical-units.csv",
  "categories.csv",
  "locations.csv",
] as const;

const ALLOWED_BACKUP_CSV_FILES = new Set([
  ...REQUIRED_BACKUP_FILES,
  "kits.csv",
]);

const REQUIRED_COLUMNS = {
  "inventory.csv": [
    "asset_id",
    "asset_name",
    "tracking_method",
    "total_quantity",
    "available_quantity",
    "lifecycle_state",
  ],
  "physical-units.csv": [
    "physical_unit_id",
    "logical_asset_id",
    "logical_product",
    "unit_number",
    "unit_status",
    "available_to_book",
    "lifecycle_state",
  ],
  "categories.csv": ["category_id", "name", "description", "color"],
  "locations.csv": ["location_id", "name", "parent_id", "full_path"],
  "kits.csv": ["kit_id", "name", "status"],
} as const;

function parseCsv(text: string, fileName: string): ParsedBackupRow[] {
  const input = text.replace(/^\uFEFF/u, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new IoioBackupValidationError(
      `${fileName} contains an unterminated quoted value.`
    );
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some((value) => value !== "")) rows.push(row);
  }

  const headers = rows.shift() ?? [];
  const required = REQUIRED_COLUMNS[fileName as keyof typeof REQUIRED_COLUMNS];
  if (!required || required.some((column) => !headers.includes(column))) {
    throw new IoioBackupValidationError(
      `${fileName} is missing required backup columns.`
    );
  }
  return rows.map((values) => {
    if (values.length !== headers.length) {
      throw new IoioBackupValidationError(
        `${fileName} contains a row with an invalid number of columns.`
      );
    }
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""])
    ) as ParsedBackupRow;
  });
}

function requiredValue(row: ParsedBackupRow, field: string, fileName: string) {
  const value = row[field]?.trim();
  if (!value) {
    throw new IoioBackupValidationError(
      `${fileName} contains a row without ${field}.`
    );
  }
  return value;
}

function integerValue(
  row: ParsedBackupRow,
  field: string,
  fileName: string,
  options?: { allowEmpty?: boolean }
) {
  const raw = row[field]?.trim() ?? "";
  if (!raw && options?.allowEmpty) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new IoioBackupValidationError(
      `${fileName} contains an invalid ${field} value.`
    );
  }
  return value;
}

function booleanValue(row: ParsedBackupRow, field: string, fileName: string) {
  const value = row[field]?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new IoioBackupValidationError(
    `${fileName} contains an invalid ${field} value.`
  );
}

function splitValues(value: string | undefined) {
  return (value ?? "")
    .split(" | ")
    .map((part) => part.trim())
    .filter(Boolean);
}

function validateUniqueIds(
  rows: ParsedBackupRow[],
  field: string,
  fileName: string
) {
  const ids = new Set<string>();
  for (const row of rows) {
    const id = requiredValue(row, field, fileName);
    if (ids.has(id)) {
      throw new IoioBackupValidationError(
        `${fileName} contains duplicate ${field} values.`
      );
    }
    ids.add(id);
  }
}

function validateRows(backup: ParsedIoioBackup) {
  validateUniqueIds(backup.inventory, "asset_id", "inventory.csv");
  validateUniqueIds(
    backup.physicalUnits,
    "physical_unit_id",
    "physical-units.csv"
  );
  validateUniqueIds(backup.categories, "category_id", "categories.csv");
  validateUniqueIds(backup.locations, "location_id", "locations.csv");
  validateUniqueIds(backup.kits, "kit_id", "kits.csv");

  const inventoryIds = new Set(backup.inventory.map((row) => row.asset_id));
  const categoryIds = new Set(backup.categories.map((row) => row.category_id));
  const locationIds = new Set(backup.locations.map((row) => row.location_id));
  const kitIds = new Set(backup.kits.map((row) => row.kit_id));

  for (const row of backup.inventory) {
    const type = requiredValue(row, "tracking_method", "inventory.csv");
    if (type !== AssetType.INDIVIDUAL && type !== AssetType.QUANTITY_TRACKED) {
      throw new IoioBackupValidationError(
        "inventory.csv contains an unknown tracking method."
      );
    }
    integerValue(row, "total_quantity", "inventory.csv");
    integerValue(row, "available_quantity", "inventory.csv");
    const lifecycle = requiredValue(row, "lifecycle_state", "inventory.csv");
    if (!["ACTIVE", "ARCHIVE", "TRASH"].includes(lifecycle)) {
      throw new IoioBackupValidationError(
        "inventory.csv contains an unknown lifecycle state."
      );
    }
    for (const id of splitValues(row.location_ids)) {
      if (!locationIds.has(id)) {
        throw new IoioBackupValidationError(
          "inventory.csv references an unknown location."
        );
      }
    }
    for (const id of splitValues(row.category_id)) {
      if (!categoryIds.has(id)) {
        throw new IoioBackupValidationError(
          "inventory.csv references an unknown category."
        );
      }
    }
    for (const id of backup.kits.length > 0 ? splitValues(row.kit_ids) : []) {
      if (!kitIds.has(id)) {
        throw new IoioBackupValidationError(
          "inventory.csv references an unknown kit."
        );
      }
    }
    const total = integerValue(row, "total_quantity", "inventory.csv") ?? 0;
    const available =
      integerValue(row, "available_quantity", "inventory.csv") ?? 0;
    if (available > total) {
      throw new IoioBackupValidationError(
        "inventory.csv contains an available quantity greater than total quantity."
      );
    }
    for (const value of splitValues(row.location_quantities)) {
      const separator = value.lastIndexOf(":");
      const quantity = Number(value.slice(separator + 1));
      if (
        separator <= 0 ||
        !locationIds.has(value.slice(0, separator)) ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        throw new IoioBackupValidationError(
          "inventory.csv contains invalid location quantities."
        );
      }
    }
  }

  const physicalIds = new Set<string>();
  for (const row of backup.physicalUnits) {
    const physicalId = requiredValue(
      row,
      "physical_unit_id",
      "physical-units.csv"
    );
    if (physicalIds.has(physicalId)) {
      throw new IoioBackupValidationError(
        "physical-units.csv contains duplicate physical unit IDs."
      );
    }
    physicalIds.add(physicalId);
    if (
      !inventoryIds.has(
        requiredValue(row, "logical_asset_id", "physical-units.csv")
      )
    ) {
      throw new IoioBackupValidationError(
        "A physical unit references an unknown logical asset."
      );
    }
    requiredValue(row, "unit_number", "physical-units.csv");
    const status = requiredValue(row, "unit_status", "physical-units.csv");
    if (!Object.values(AssetStatus).includes(status as AssetStatus)) {
      throw new IoioBackupValidationError(
        "physical-units.csv contains an unknown unit status."
      );
    }
    booleanValue(row, "available_to_book", "physical-units.csv");
    const lifecycle = requiredValue(
      row,
      "lifecycle_state",
      "physical-units.csv"
    );
    if (!["ACTIVE", "ARCHIVE", "TRASH"].includes(lifecycle)) {
      throw new IoioBackupValidationError(
        "physical-units.csv contains an unknown lifecycle state."
      );
    }
    for (const value of splitValues(row.location_quantities)) {
      const separator = value.lastIndexOf(":");
      const quantity = Number(value.slice(separator + 1));
      if (
        separator <= 0 ||
        !locationIds.has(value.slice(0, separator)) ||
        !Number.isInteger(quantity) ||
        quantity <= 0
      ) {
        throw new IoioBackupValidationError(
          "physical-units.csv contains invalid location quantities."
        );
      }
    }
  }

  for (const row of backup.locations) {
    const parentId = row.parent_id?.trim();
    if (parentId && !locationIds.has(parentId)) {
      throw new IoioBackupValidationError(
        "locations.csv contains a location with an unknown parent."
      );
    }
  }
  for (const row of backup.locations) {
    const seen = new Set<string>();
    let currentId: string | undefined = row.location_id;
    while (currentId) {
      if (seen.has(currentId)) {
        throw new IoioBackupValidationError(
          "locations.csv contains a circular location hierarchy."
        );
      }
      seen.add(currentId);
      currentId = backup.locations
        .find((candidate) => candidate.location_id === currentId)
        ?.parent_id?.trim();
    }
  }

  for (const row of backup.kits) {
    const status = requiredValue(row, "status", "kits.csv");
    if (!Object.values(KitStatus).includes(status as KitStatus)) {
      throw new IoioBackupValidationError(
        "kits.csv contains an unknown kit status."
      );
    }
    if (row.category_id?.trim() && !categoryIds.has(row.category_id.trim())) {
      throw new IoioBackupValidationError(
        "kits.csv references an unknown category."
      );
    }
    if (row.location_id?.trim() && !locationIds.has(row.location_id.trim())) {
      throw new IoioBackupValidationError(
        "kits.csv references an unknown location."
      );
    }
    integerValue(row, "max_borrow_days", "kits.csv");
    integerValue(row, "extension_borrow_days", "kits.csv", {
      allowEmpty: true,
    });
  }
}

async function readIoioBackupZip(file: Uint8Array) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new IoioBackupValidationError(
      "This file is not a valid IOIO Lab backup ZIP."
    );
  }

  for (const fileName of REQUIRED_BACKUP_FILES) {
    if (!zip.file(fileName)) {
      throw new IoioBackupValidationError(
        `This backup is missing ${fileName}.`
      );
    }
  }
  const read = async (fileName: string) =>
    parseCsv(
      await (zip.file(fileName)?.async("string") ?? Promise.resolve("")),
      fileName
    );
  const backup: ParsedIoioBackup = {
    inventory: await read("inventory.csv"),
    physicalUnits: await read("physical-units.csv"),
    categories: await read("categories.csv"),
    locations: await read("locations.csv"),
    kits: zip.file("kits.csv") ? await read("kits.csv") : [],
  };
  validateRows(backup);
  return backup;
}

function backupFileName(name: string) {
  return name.split(/[\\/]/u).at(-1)?.toLocaleLowerCase() ?? "";
}

export async function readIoioInventoryBackupFiles(
  files: Array<{ name: string; bytes: Uint8Array }>
) {
  const totalBytes = files.reduce(
    (total, file) => total + file.bytes.byteLength,
    0
  );
  if (files.length === 0 || totalBytes === 0 || totalBytes > 25 * 1024 * 1024) {
    throw new IoioBackupValidationError(
      "The backup file is empty or larger than the 25 MB limit."
    );
  }

  const names = files.map((file) => backupFileName(file.name));
  const zipFiles = files.filter((_, index) => names[index].endsWith(".zip"));
  const csvFiles = files.filter((_, index) => names[index].endsWith(".csv"));

  if (zipFiles.length > 0 && csvFiles.length > 0) {
    throw new IoioBackupValidationError(
      "Upload one backup ZIP or the supported CSV files, not both."
    );
  }
  if (zipFiles.length > 0) {
    if (files.length !== 1) {
      throw new IoioBackupValidationError(
        "Upload one backup ZIP or the supported CSV files, not multiple ZIP files."
      );
    }
    return readIoioBackupZip(files[0].bytes);
  }

  if (csvFiles.length !== files.length) {
    throw new IoioBackupValidationError(
      "Unsupported file type. Upload a .zip file or the supported .csv files."
    );
  }
  const csvByName = new Map<string, Uint8Array>();
  for (const [index, file] of files.entries()) {
    const name = names[index];
    if (!ALLOWED_BACKUP_CSV_FILES.has(name)) {
      throw new IoioBackupValidationError(
        `${name || "This file"} is not an allowed IOIO backup dataset.`
      );
    }
    if (csvByName.has(name)) {
      throw new IoioBackupValidationError(
        `The backup contains ${name} more than once.`
      );
    }
    csvByName.set(name, file.bytes);
  }
  for (const fileName of REQUIRED_BACKUP_FILES) {
    if (!csvByName.has(fileName)) {
      throw new IoioBackupValidationError(
        `The CSV upload is missing ${fileName}.`
      );
    }
  }

  const backup: ParsedIoioBackup = {
    inventory: parseCsv(
      new TextDecoder().decode(csvByName.get("inventory.csv")),
      "inventory.csv"
    ),
    physicalUnits: parseCsv(
      new TextDecoder().decode(csvByName.get("physical-units.csv")),
      "physical-units.csv"
    ),
    categories: parseCsv(
      new TextDecoder().decode(csvByName.get("categories.csv")),
      "categories.csv"
    ),
    locations: parseCsv(
      new TextDecoder().decode(csvByName.get("locations.csv")),
      "locations.csv"
    ),
    kits: csvByName.has("kits.csv")
      ? parseCsv(
          new TextDecoder().decode(csvByName.get("kits.csv")),
          "kits.csv"
        )
      : [],
  };
  validateRows(backup);
  return backup;
}

export async function readIoioInventoryBackup(file: Uint8Array) {
  return readIoioInventoryBackupFiles([{ name: "backup.zip", bytes: file }]);
}

export function getIoioBackupPreview(
  backup: ParsedIoioBackup
): IoioBackupPreview {
  return {
    inventory: backup.inventory.length,
    physicalUnits: backup.physicalUnits.length,
    categories: backup.categories.length,
    locations: backup.locations.length,
    kits: backup.kits.length,
  };
}

function fullLocationPath(
  locationId: string,
  locationsById: Map<string, ParsedBackupRow>
) {
  const names: string[] = [];
  const seen = new Set<string>();
  let currentId: string | undefined = locationId;
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const location = locationsById.get(currentId);
    if (!location) return "";
    names.unshift(location.name);
    currentId = location.parent_id?.trim() || undefined;
  }
  return names.join(" / ");
}

function assetPlacementIds(
  row: ParsedBackupRow,
  locationsById: Map<string, ParsedBackupRow>,
  locationIds: Set<string>
) {
  const explicitIds = splitValues(row.location_ids).filter((id) =>
    locationIds.has(id)
  );
  if (explicitIds.length > 0) return explicitIds;

  const paths = splitValues(row.location);
  return paths
    .map((path) =>
      [...locationsById.keys()].find(
        (id) => fullLocationPath(id, locationsById) === path
      )
    )
    .filter((id): id is string => Boolean(id));
}

function placementQuantities(row: ParsedBackupRow, ids: string[]) {
  const values = new Map<string, number>();
  for (const value of splitValues(row.location_quantities)) {
    const separator = value.lastIndexOf(":");
    if (separator <= 0) continue;
    const id = value.slice(0, separator);
    const quantity = Number(value.slice(separator + 1));
    if (Number.isInteger(quantity) && quantity > 0) values.set(id, quantity);
  }
  return ids.map((id) => ({ locationId: id, quantity: values.get(id) ?? 1 }));
}

function lifecycleValue(row: ParsedBackupRow) {
  if (row.lifecycle_state === "ACTIVE") return null;
  return row.lifecycle_state === "ARCHIVE"
    ? IOIO_ITEM_DISPOSITION.ARCHIVE
    : row.lifecycle_state === "TRASH"
    ? IOIO_ITEM_DISPOSITION.TRASH
    : (null as IoioItemDisposition | null);
}

/**
 * Restores only the operational IOIO datasets in a single transaction. The
 * ZIP has already been structurally and referentially validated by
 * readIoioInventoryBackup, and all writes remain organization-scoped.
 */
export async function restoreIoioInventoryBackup({
  backup,
  organizationId,
  userId,
}: {
  backup: ParsedIoioBackup;
  organizationId: string;
  userId: string;
}): Promise<IoioBackupRestoreResult> {
  return db.$transaction(async (tx) => {
    const inventoryIds = backup.inventory.map((row) => row.asset_id);
    const physicalIds = backup.physicalUnits.map((row) => row.physical_unit_id);
    const allAssetIds = [...new Set([...inventoryIds, ...physicalIds])];
    const categoryIds = backup.categories.map((row) => row.category_id);
    const locationIds = backup.locations.map((row) => row.location_id);
    const kitIds = backup.kits.map((row) => row.kit_id);
    const assetModelIds = [...backup.inventory, ...backup.physicalUnits]
      .map((row) => row.asset_model_id?.trim())
      .filter((id): id is string => Boolean(id));

    const [
      existingAssets,
      existingCategories,
      existingLocations,
      existingKits,
      existingModels,
    ] = await Promise.all([
      tx.asset.findMany({
        where: { organizationId, id: { in: allAssetIds } },
        select: { id: true, organizationId: true },
      }),
      tx.category.findMany({
        where: { organizationId, id: { in: categoryIds } },
        select: { id: true, organizationId: true },
      }),
      tx.location.findMany({
        where: { organizationId, id: { in: locationIds } },
        select: { id: true, organizationId: true },
      }),
      tx.kit.findMany({
        where: { id: { in: kitIds } },
        select: { id: true, organizationId: true },
      }),
      tx.assetModel.findMany({
        where: { id: { in: [...new Set(assetModelIds)] } },
        select: { id: true, organizationId: true },
      }),
    ]);

    const foreignRecords = [
      ...existingAssets,
      ...existingCategories,
      ...existingLocations,
      ...existingKits,
      ...existingModels,
    ].filter((record) => record.organizationId !== organizationId);
    if (foreignRecords.length > 0) {
      throw new IoioBackupValidationError(
        "This backup contains IDs belonging to another organization."
      );
    }

    for (const row of backup.categories) {
      await tx.category.upsert({
        where: { id: row.category_id },
        update: {
          name: requiredValue(row, "name", "categories.csv"),
          description: row.description || null,
          color: requiredValue(row, "color", "categories.csv"),
        },
        create: {
          id: row.category_id,
          name: requiredValue(row, "name", "categories.csv"),
          description: row.description || null,
          color: requiredValue(row, "color", "categories.csv"),
          organizationId,
          userId,
        },
      });
    }

    const locationsById = new Map(
      backup.locations.map((row) => [row.location_id, row])
    );
    const sortedLocations = [...backup.locations].sort(
      (left, right) =>
        fullLocationPath(left.location_id, locationsById).split(" / ").length -
        fullLocationPath(right.location_id, locationsById).split(" / ").length
    );
    for (const row of sortedLocations) {
      await tx.location.upsert({
        where: { id: row.location_id },
        update: {
          name: requiredValue(row, "name", "locations.csv"),
          parentId: row.parent_id?.trim() || null,
        },
        create: {
          id: row.location_id,
          name: requiredValue(row, "name", "locations.csv"),
          parentId: row.parent_id?.trim() || null,
          organizationId,
          userId,
        },
      });
    }

    const modelNames = new Map<string, string>();
    for (const row of [...backup.inventory, ...backup.physicalUnits]) {
      const id = row.asset_model_id?.trim();
      if (id) {
        const name =
          row.asset_model_name?.trim() ||
          row.logical_product?.trim() ||
          row.asset_name?.trim();
        if (name) modelNames.set(id, name);
      }
    }
    for (const id of new Set(assetModelIds)) {
      await tx.assetModel.upsert({
        where: { id },
        update: { name: modelNames.get(id) ?? id },
        create: {
          id,
          name: modelNames.get(id) ?? id,
          organizationId,
          userId,
        },
      });
    }

    for (const row of backup.kits) {
      await tx.kit.upsert({
        where: { id: row.kit_id },
        update: {
          name: requiredValue(row, "name", "kits.csv"),
          status: row.status as KitStatus,
          categoryId: row.category_id?.trim() || null,
          locationId: row.location_id?.trim() || null,
          maxBorrowDays: integerValue(row, "max_borrow_days", "kits.csv") ?? 14,
          extensionBorrowDays: integerValue(
            row,
            "extension_borrow_days",
            "kits.csv",
            {
              allowEmpty: true,
            }
          ),
        },
        create: {
          id: row.kit_id,
          name: requiredValue(row, "name", "kits.csv"),
          status: row.status as KitStatus,
          categoryId: row.category_id?.trim() || null,
          locationId: row.location_id?.trim() || null,
          maxBorrowDays: integerValue(row, "max_borrow_days", "kits.csv") ?? 14,
          extensionBorrowDays: integerValue(
            row,
            "extension_borrow_days",
            "kits.csv",
            {
              allowEmpty: true,
            }
          ),
          organizationId,
          createdById: userId,
        },
      });
    }

    const physicalById = new Map(
      backup.physicalUnits.map((row) => [row.physical_unit_id, row])
    );
    const inventoryById = new Map(
      backup.inventory.map((row) => [row.asset_id, row])
    );
    const assetRows = new Map<string, ParsedBackupRow>();
    for (const row of backup.inventory) assetRows.set(row.asset_id, row);
    for (const row of backup.physicalUnits) {
      if (!assetRows.has(row.physical_unit_id))
        assetRows.set(row.physical_unit_id, row);
    }

    for (const [assetId, row] of assetRows) {
      const physical = physicalById.get(assetId);
      const inventory =
        inventoryById.get(assetId) ?? inventoryById.get(row.logical_asset_id);
      const isIndividual =
        row.tracking_method === AssetType.INDIVIDUAL || Boolean(physical);
      const title = physical
        ? `${requiredValue(
            physical,
            "logical_product",
            "physical-units.csv"
          )} #${requiredValue(
            physical,
            "unit_number",
            "physical-units.csv"
          ).replace(/^#/, "")}`
        : requiredValue(row, "asset_name", "inventory.csv");
      const categoryId =
        (inventory?.category_id ?? row.category_id)?.trim() || null;
      const modelId =
        (physical?.asset_model_id ?? row.asset_model_id)?.trim() || null;
      const quantity = isIndividual
        ? null
        : integerValue(row, "total_quantity", "inventory.csv");
      const available = physical
        ? booleanValue(physical, "available_to_book", "physical-units.csv")
        : (integerValue(row, "available_quantity", "inventory.csv") ?? 0) > 0;
      const status =
        physical?.unit_status ??
        (available ? AssetStatus.AVAILABLE : AssetStatus.IN_CUSTODY);

      await tx.asset.upsert({
        where: { id: assetId },
        update: {
          title,
          type: isIndividual
            ? AssetType.INDIVIDUAL
            : AssetType.QUANTITY_TRACKED,
          status: status as AssetStatus,
          quantity,
          availableToBook: available,
          categoryId,
          assetModelId: modelId,
        },
        create: {
          id: assetId,
          title,
          type: isIndividual
            ? AssetType.INDIVIDUAL
            : AssetType.QUANTITY_TRACKED,
          status: status as AssetStatus,
          quantity,
          availableToBook: available,
          categoryId,
          assetModelId: modelId,
          organizationId,
          userId,
        },
      });
    }

    const placementRows = new Map<string, ParsedBackupRow>();
    for (const row of backup.inventory) placementRows.set(row.asset_id, row);
    for (const row of backup.physicalUnits)
      placementRows.set(row.physical_unit_id, row);
    for (const [assetId, row] of placementRows) {
      const ids = assetPlacementIds(row, locationsById, new Set(locationIds));
      await tx.assetLocation.deleteMany({
        where: { assetId, organizationId, assetKitId: null },
      });
      if (ids.length > 0) {
        const quantities = placementQuantities(row, ids);
        await tx.assetLocation.createMany({
          data: quantities.map(({ locationId, quantity }) => ({
            assetId,
            locationId,
            organizationId,
            quantity,
          })),
        });
      }
    }

    const relationRows = [...backup.inventory, ...backup.physicalUnits];
    for (const row of relationRows) {
      const assetId = row.physical_unit_id ?? row.asset_id;
      for (const kitId of backup.kits.length > 0
        ? splitValues(row.kit_ids)
        : []) {
        await tx.assetKit.upsert({
          where: { assetId_kitId: { assetId, kitId } },
          update: { quantity: 1 },
          create: { assetId, kitId, organizationId, quantity: 1 },
        });
      }
    }

    const lifecycleRows = [
      ...backup.inventory.map((row) => ({ id: row.asset_id, row })),
      ...backup.physicalUnits.map((row) => ({ id: row.physical_unit_id, row })),
    ];
    for (const { id, row } of lifecycleRows) {
      const lifecycle = lifecycleValue(row);
      const existing = await tx.ioioArchivedItem.findFirst({
        where: {
          organizationId,
          itemType: "ASSET",
          itemId: id,
          restoredAt: null,
        },
      });
      if (!lifecycle) {
        if (existing) {
          await tx.ioioArchivedItem.updateMany({
            where: { id: existing.id, organizationId },
            data: { restoredAt: new Date(), restoredById: userId },
          });
        }
      } else if (existing) {
        await tx.ioioArchivedItem.updateMany({
          where: { id: existing.id, organizationId },
          data: { disposition: lifecycle, archivedById: userId },
        });
      } else {
        await tx.ioioArchivedItem.create({
          data: {
            organizationId,
            itemType: "ASSET",
            itemId: id,
            disposition: lifecycle,
            archivedById: userId,
          },
        });
      }
    }

    return getIoioBackupPreview(backup);
  });
}
