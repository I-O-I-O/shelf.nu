import { createHash } from "node:crypto";
import JSZip from "jszip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";

const database = vi.hoisted(() => ({
  asset: { findMany: vi.fn(), findFirst: vi.fn() },
  assetModel: { findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
  category: { findFirst: vi.fn(), findMany: vi.fn() },
  qr: { findFirst: vi.fn() },
  location: { findMany: vi.fn() },
  ioioWriteOperation: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  ioioImportItem: {
    createMany: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  ioioArchivedItem: { findMany: vi.fn() },
}));
const mockStaffAccess = vi.hoisted(() => vi.fn());
const mockGetCategories = vi.hoisted(() => vi.fn());
const mockCreateAsset = vi.hoisted(() => vi.fn());
const mockUpdateAsset = vi.hoisted(() => vi.fn());
const mockCreateAssetModel = vi.hoisted(() => vi.fn());
const mockCreateCategory = vi.hoisted(() => vi.fn());
const mockRequirePermission = vi.hoisted(() => vi.fn());
const mockGetBrokenSection = vi.hoisted(() => vi.fn());
const mockGetReturnArea = vi.hoisted(() => vi.fn());
const mockGetArchivedCategoryIds = vi.hoisted(() => vi.fn());
const mockRequestImportHelperProposal = vi.hoisted(() => vi.fn());

// why: the tests exercise the pure file parsing and row classification logic;
// database and Shelf mutation services must not be initialized for those tests.
vi.mock("~/database/db.server", () => ({
  db: database,
}));

// why: the classification tests must prove they do not accidentally invoke a
// real Shelf write service while constructing a proposal.
vi.mock("~/modules/asset/service.server", () => ({
  BULK_CREATE_MAX: 100,
  createAsset: mockCreateAsset,
  updateAsset: mockUpdateAsset,
}));

// why: importer tests must observe whether a model is requested without writing
// to Shelf's model tables or invoking model side effects.
vi.mock("~/modules/asset-model/service.server", () => ({
  createAssetModel: mockCreateAssetModel,
}));

// why: access is only exercised by the request-level prepare/apply functions,
// not by these pure parser and classifier tests.
vi.mock("./access.server", () => ({
  requireIoioStaffAccess: mockStaffAccess,
}));

// why: preparation's category snapshot is independent of the stored SUCCEEDED result.
vi.mock("~/modules/category/service.server", () => ({
  createCategory: mockCreateCategory,
  getActiveCategoriesForOrganization: mockGetCategories,
}));

// why: import tests assert that category creation uses Shelf's permission gate
// and canonical service while avoiding organization/auth database setup.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mockRequirePermission,
}));

// why: operational-zone configuration is controlled in tests so location
// suggestions remain deterministic without querying IOIO settings tables.
vi.mock("~/modules/ioio-lab-information/broken-section.server", () => ({
  getConfiguredBrokenSection: mockGetBrokenSection,
}));
vi.mock("~/modules/ioio-student/report-return-location.server", () => ({
  getConfiguredReportReturnArea: mockGetReturnArea,
}));
vi.mock("~/modules/ioio-staff/archive.server", () => ({
  getIoioArchivedCategoryIds: mockGetArchivedCategoryIds,
}));
vi.mock("~/modules/ioio-staff/pickup-zone.server", () => ({
  PICKUP_ZONE_NAME: "Pickup Zone",
}));
vi.mock("~/utils/get-random-color", () => ({
  getRandomColor: () => "#123456",
}));

// why: preparation tests control helper availability and responses while the
// helper contract's own tests verify real strict parsing and validation.
vi.mock("./import-helper-client.server", () => ({
  requestImportHelperProposal: mockRequestImportHelperProposal,
}));

import { validateImportHelperResponse } from "./import-helper-contract.server";
import {
  applyStaffInventoryImport,
  classifyStaffImportRows,
  getIndividualUnitImportLimitError,
  getStaffImportProposalHash,
  parseStaffImportFile,
  prepareStaffInventoryImport,
  summarizeStaffImportRows,
  type StaffImportResult,
} from "./inventory-import.server";

beforeEach(() => {
  database.category.findMany.mockResolvedValue([]);
  database.location.findMany.mockResolvedValue([]);
  mockCreateCategory.mockImplementation(({ name }) => ({
    id: "category-created",
    name,
  }));
  mockRequirePermission.mockResolvedValue({});
  mockGetBrokenSection.mockResolvedValue(null);
  mockGetReturnArea.mockResolvedValue(null);
  mockGetArchivedCategoryIds.mockResolvedValue([]);
});

describe("staff inventory import safety", () => {
  async function applyNewImport({
    quantity,
    type = "INDIVIDUAL",
    existingAssets = [],
    pauseAtUnitIndex,
    duplicateProposal,
    duplicateFile,
    raceWinner,
    omitReviewDecisions = false,
    allowSameFileReimport = false,
    denyStaffAccess = false,
    proposalHashOverride,
    useExistingCategory = true,
    newCategoryName,
    approveNewCategory = false,
    denyCategoryPermission = false,
    categoryArchivedAfterReview = false,
    selectedLocationId,
    categoryAppearedAfterReview = false,
    ambiguousLocation = false,
    decisionType,
    minQuantity,
    unitOfMeasure,
    consumptionType,
    skipDecision = false,
  }: {
    quantity: number;
    type?: "INDIVIDUAL" | "QUANTITY_TRACKED";
    existingAssets?: Array<{ id: string; title: string }>;
    pauseAtUnitIndex?: number;
    duplicateProposal?: { id: string; status: string; organizationId?: string };
    duplicateFile?: { id: string; status: string; proposalSha256: string };
    raceWinner?: { id: string; status: string };
    omitReviewDecisions?: boolean;
    allowSameFileReimport?: boolean;
    denyStaffAccess?: boolean;
    proposalHashOverride?: string;
    useExistingCategory?: boolean;
    newCategoryName?: string;
    approveNewCategory?: boolean;
    denyCategoryPermission?: boolean;
    categoryArchivedAfterReview?: boolean;
    selectedLocationId?: string;
    categoryAppearedAfterReview?: boolean;
    ambiguousLocation?: boolean;
    decisionType?: "INDIVIDUAL" | "QUANTITY_TRACKED" | null;
    minQuantity?: number | null;
    unitOfMeasure?: string | null;
    consumptionType?: "ONE_WAY" | "TWO_WAY" | null;
    skipDecision?: boolean;
  }) {
    vi.clearAllMocks();
    const operationId = `operation-${type}-${quantity}`;
    const row = {
      rowNumber: 2,
      title: "Arduino Nano",
      action: "CREATE" as const,
      assetId: null,
      type,
      quantity,
      receivedQuantity: quantity,
      quantityStatus: "RECEIVED" as const,
      category: useExistingCategory ? "Electronics" : null,
      categoryId: useExistingCategory ? "category-electronics" : null,
      location: null,
      locationId: selectedLocationId ?? null,
      ...(ambiguousLocation
        ? { locationResolution: "AMBIGUOUS" as const }
        : {}),
      currentQuantity: null,
      currentCategoryId: null,
      currentLocationId: null,
      reason: "New item",
    };
    const proposalContent = {
      version: 1 as const,
      operationId,
      organizationId: "org-1",
      source: { filename: "inventory.csv", size: 42, sha256: "hash" },
      rows: [row],
      counts: {
        CREATE: 1,
        INCREASE_QUANTITY: 0,
        NO_CHANGE: 0,
        POSSIBLE_DUPLICATE: 0,
        NEEDS_REVIEW: 0,
        IGNORE: 0,
        UPDATE_QUANTITY: 0,
        UPDATE_LOCATION: 0,
        UPDATE_CATEGORY: 0,
        AMBIGUOUS: 0,
        REJECT: 0,
      },
      createdAt: new Date().toISOString(),
      categoryOptions: useExistingCategory
        ? [{ id: "category-electronics", name: "Electronics", archived: false }]
        : [],
      locationOptions: selectedLocationId
        ? [
            {
              id: selectedLocationId,
              name: "Problem / Broken Zone",
              parentId: null,
              pathLabel: "IOIO Lab – B477 · Problem / Broken Zone",
              operational: true,
              currentUnits: 18,
            },
          ]
        : [],
    };
    const proposal = {
      ...proposalContent,
      proposalHash: getStaffImportProposalHash(proposalContent),
    };
    const operation = {
      id: operationId,
      operationType: "INVENTORY_IMPORT",
      organizationId: "org-1",
      userId: "staff-1",
      status: "PREPARED",
      fileSha256: proposal.source.sha256,
      createdAt: new Date(),
      updatedAt: new Date(),
      description: JSON.stringify({ proposal }),
    };
    const ledgerRows: Array<Record<string, any>> = [];
    const assetRows: Array<Record<string, any>> = [];
    let modelId: string | null = null;
    let modelIdentityKey: string | null = null;
    let claimAttempted = false;
    if (denyStaffAccess) {
      mockStaffAccess.mockRejectedValue(new Error("Staff access denied."));
    } else {
      mockStaffAccess.mockResolvedValue({
        organizationId: "org-1",
        userId: "staff-1",
      });
    }
    mockGetCategories.mockResolvedValue(
      useExistingCategory
        ? [{ id: "category-electronics", name: "Electronics" }]
        : []
    );
    if (approveNewCategory) {
      mockCreateCategory.mockImplementation(({ name }) => {
        mockGetCategories.mockResolvedValue([{ id: "category-created", name }]);
        return { id: "category-created", name };
      });
    }
    if (categoryAppearedAfterReview) {
      mockGetCategories.mockResolvedValue([
        { id: "category-created-elsewhere", name: newCategoryName },
      ]);
    }
    if (categoryArchivedAfterReview) {
      mockGetCategories.mockReset().mockResolvedValue([]);
    }
    if (denyCategoryPermission) {
      mockRequirePermission.mockRejectedValue(new Error("Permission denied"));
    }
    if (selectedLocationId) {
      database.location.findMany.mockResolvedValue([
        { id: "room", name: "IOIO Lab – B477", parentId: null },
        {
          id: selectedLocationId,
          name: "Problem / Broken Zone",
          parentId: "room",
        },
      ]);
      mockGetBrokenSection.mockResolvedValue({ id: selectedLocationId });
    }
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) => {
      if (where.id === operationId) return operation;
      if (where.proposalSha256) {
        if (claimAttempted && raceWinner) return raceWinner;
        return duplicateProposal?.organizationId === undefined ||
          duplicateProposal.organizationId === where.organizationId
          ? duplicateProposal ?? null
          : null;
      }
      if (where.fileSha256 && where.organizationId === "org-1") {
        return duplicateFile ?? null;
      }
      return null;
    });
    database.ioioWriteOperation.updateMany.mockImplementation(
      ({ where, data }) => {
        if (
          where.id !== operationId ||
          where.organizationId !== "org-1" ||
          where.userId !== "staff-1"
        ) {
          return { count: 0 };
        }
        if (where.status && where.status !== operation.status) {
          return { count: 0 };
        }
        if (
          where.status === "PREPARED" &&
          data.status === "APPLYING" &&
          raceWinner
        ) {
          claimAttempted = true;
          throw { code: "P2002" };
        }
        Object.assign(operation, data);
        return { count: 1 };
      }
    );
    database.ioioImportItem.createMany.mockImplementation(({ data }) => {
      for (const item of data) {
        if (ledgerRows.some((entry) => entry.identityKey === item.identityKey))
          continue;
        ledgerRows.push({
          ...item,
          id: `ledger-${ledgerRows.length + 1}`,
          status: item.unitIndex === pauseAtUnitIndex ? "IN_FLIGHT" : "PENDING",
          attempt: 0,
          heartbeatAt: null,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      return { count: data.length };
    });
    database.ioioImportItem.findMany.mockImplementation(({ where }) =>
      ledgerRows.filter(
        (item) =>
          item.operationId === where.operationId &&
          item.organizationId === where.organizationId &&
          (!where.status || item.status === where.status)
      )
    );
    database.ioioImportItem.findFirst.mockImplementation(
      ({ where }) =>
        ledgerRows.find(
          (item) =>
            item.id === where.id &&
            item.operationId === where.operationId &&
            item.organizationId === where.organizationId
        ) ?? null
    );
    database.ioioImportItem.updateMany.mockImplementation(({ where, data }) => {
      const item = ledgerRows.find(
        (entry) =>
          entry.id === where.id &&
          entry.operationId === where.operationId &&
          entry.organizationId === where.organizationId &&
          (!where.status || entry.status === where.status)
      );
      if (!item) return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        item[key] =
          key === "attempt" && typeof value === "object"
            ? item.attempt + (value as { increment: number }).increment
            : value;
      }
      item.updatedAt = new Date();
      return { count: 1 };
    });
    database.assetModel.findFirst.mockImplementation(({ where }) => {
      if (where.id) return where.id === modelId ? { id: modelId } : null;
      if (where.importIdentityKey)
        return where.importIdentityKey === modelIdentityKey && modelId
          ? { id: modelId }
          : null;
      return where.name === "Arduino Nano" && modelId ? { id: modelId } : null;
    });
    database.assetModel.findMany.mockResolvedValue([]);
    database.assetModel.updateMany.mockResolvedValue({ count: 0 });
    mockCreateAssetModel.mockImplementation(({ id, importIdentityKey }) => {
      modelId = id;
      modelIdentityKey = importIdentityKey ?? null;
      return { id, importIdentityKey: modelIdentityKey };
    });
    database.asset.findMany.mockImplementation(({ where }) => {
      const availableAssets = [...existingAssets, ...assetRows];
      if (typeof where.title === "string")
        return availableAssets.filter((asset) => asset.title === where.title);
      if (where.title?.startsWith)
        return availableAssets.filter((asset) =>
          asset.title.startsWith(where.title.startsWith)
        );
      return [];
    });
    database.asset.findFirst.mockResolvedValue(null);
    database.category.findFirst.mockResolvedValue(null);
    database.qr.findFirst.mockResolvedValue(null);
    if (!selectedLocationId) database.location.findMany.mockResolvedValue([]);
    mockCreateAsset.mockImplementation((asset) => {
      assetRows.push(asset);
      return { id: asset.id };
    });

    const result = await applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash: proposalHashOverride ?? proposal.proposalHash,
      allowSameFileReimport,
      ...(!omitReviewDecisions
        ? {
            reviewDecisions: JSON.stringify([
              skipDecision
                ? { rowNumber: row.rowNumber, decision: "IGNORE" }
                : {
                    rowNumber: row.rowNumber,
                    decision: "APPROVE",
                    title: row.title,
                    assetId: null,
                    categoryId: useExistingCategory ? row.categoryId : null,
                    newCategoryName: newCategoryName ?? null,
                    approveNewCategory,
                    locationId: selectedLocationId ?? null,
                    quantity,
                    type: decisionType === undefined ? type : decisionType,
                    minQuantity,
                    unitOfMeasure,
                    consumptionType,
                  },
            ]),
          }
        : {}),
    });
    return {
      result,
      assetRows,
      ledgerRows,
      operationId,
      modelId,
      operation,
      proposalHash: proposal.proposalHash,
    };
  }

  async function applyAfterConcurrentAssetEdit(
    changedField: "quantity" | "categoryId" | "locationId"
  ) {
    vi.clearAllMocks();
    const operationId = `operation-stale-${changedField}`;
    const expectedAssetState = {
      assetId: "asset-existing",
      title: "USB-C Cable",
      type: "QUANTITY_TRACKED" as const,
      quantity: 20,
      categoryId: "category-electronics",
      locationIds: ["location-a"],
      assetModelId: null,
    };
    const asset = {
      id: "asset-existing",
      title: "USB-C Cable",
      type: "QUANTITY_TRACKED" as const,
      quantity: changedField === "quantity" ? 21 : 20,
      categoryId:
        changedField === "categoryId"
          ? "category-other"
          : "category-electronics",
      assetModelId: null,
      assetLocations: [
        {
          locationId:
            changedField === "locationId" ? "location-b" : "location-a",
          quantity: 20,
          assetKitId: null,
        },
      ],
    };
    const row = {
      rowNumber: 2,
      title: "USB-C Cable",
      action: "UPDATE_QUANTITY" as const,
      assetId: "asset-existing",
      type: "QUANTITY_TRACKED" as const,
      quantity: 5,
      receivedQuantity: 5,
      quantityStatus: "RECEIVED" as const,
      category: null,
      categoryId: "category-electronics",
      location: null,
      locationId: "location-a",
      locationLabel: "Shelf A",
      currentQuantity: 20,
      currentCategoryId: "category-electronics",
      currentLocationId: "location-a",
      expectedAssetState,
      proposedQuantity: 25,
      reason: "Existing stock",
    };
    const proposalContent = {
      version: 1 as const,
      operationId,
      organizationId: "org-1",
      source: { filename: "stock.csv", size: 10, sha256: "file-hash" },
      rows: [row],
      counts: {
        CREATE: 0,
        INCREASE_QUANTITY: 0,
        NO_CHANGE: 0,
        POSSIBLE_DUPLICATE: 0,
        NEEDS_REVIEW: 0,
        IGNORE: 0,
        UPDATE_QUANTITY: 1,
        UPDATE_LOCATION: 0,
        UPDATE_CATEGORY: 0,
        AMBIGUOUS: 0,
        REJECT: 0,
      },
      createdAt: new Date().toISOString(),
      categoryOptions: [{ id: "category-electronics", name: "Electronics" }],
      locationOptions: [
        {
          id: "location-a",
          name: "Shelf A",
          parentId: null,
          pathLabel: "Shelf A",
          operational: false,
          currentUnits: 20,
        },
      ],
    };
    const proposal = {
      ...proposalContent,
      proposalHash: getStaffImportProposalHash(proposalContent),
    };
    const operation = {
      id: operationId,
      operationType: "INVENTORY_IMPORT",
      organizationId: "org-1",
      userId: "staff-1",
      status: "PREPARED",
      fileSha256: proposal.source.sha256,
      createdAt: new Date(),
      updatedAt: new Date(),
      description: JSON.stringify({ proposal }),
    };
    const ledgerRows: Array<Record<string, any>> = [];
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    mockGetCategories.mockResolvedValue([
      { id: "category-electronics", name: "Electronics" },
    ]);
    database.ioioWriteOperation.findFirst.mockImplementation(({ where }) =>
      where.id === operationId ? operation : null
    );
    database.ioioWriteOperation.updateMany.mockImplementation(
      ({ where, data }) => {
        if (
          where.id !== operationId ||
          (where.status && where.status !== operation.status)
        ) {
          return { count: 0 };
        }
        Object.assign(operation, data);
        return { count: 1 };
      }
    );
    database.ioioImportItem.createMany.mockImplementation(({ data }) => {
      for (const item of data) {
        ledgerRows.push({
          ...item,
          id: `ledger-${ledgerRows.length + 1}`,
          status: "PENDING",
          attempt: 0,
          heartbeatAt: null,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      return { count: data.length };
    });
    database.ioioImportItem.findMany.mockImplementation(({ where }) =>
      ledgerRows.filter(
        (item) =>
          item.operationId === where.operationId &&
          item.organizationId === where.organizationId &&
          (!where.status || item.status === where.status)
      )
    );
    database.ioioImportItem.findFirst.mockImplementation(
      ({ where }) =>
        ledgerRows.find(
          (item) => item.id === where.id && item.operationId === operationId
        ) ?? null
    );
    database.ioioImportItem.updateMany.mockImplementation(({ where, data }) => {
      const item = ledgerRows.find((entry) => entry.id === where.id);
      if (!item || (where.status && item.status !== where.status))
        return { count: 0 };
      Object.assign(item, data, { updatedAt: new Date() });
      return { count: 1 };
    });
    database.asset.findMany.mockResolvedValue([asset]);
    database.asset.findFirst.mockResolvedValue(asset);
    database.location.findMany.mockResolvedValue([]);

    return applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash: proposal.proposalHash,
      reviewDecisions: JSON.stringify([
        {
          rowNumber: 2,
          decision: "APPROVE",
          title: "USB-C Cable",
          assetId: "asset-existing",
          categoryId: "category-electronics",
          locationId: "location-a",
          quantity: 5,
        },
      ]),
    });
  }

  it("creates one individual Asset, QR, and AssetModel for quantity one", async () => {
    const { result, assetRows, ledgerRows, modelId } = await applyNewImport({
      quantity: 1,
    });

    expect(assetRows).toHaveLength(1);
    expect(assetRows[0]).toMatchObject({
      title: "Arduino Nano",
      type: "INDIVIDUAL",
      quantity: null,
      assetModelId: modelId,
      id: ledgerRows.find((item) => item.unitIndex === 0)?.targetAssetId,
      newQrId: ledgerRows.find((item) => item.unitIndex === 0)?.qrId,
    });
    expect(mockCreateAssetModel).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      totalRows: 1,
      succeededRows: 1,
    });
    expect(
      database.ioioWriteOperation.updateMany.mock.calls.at(-1)?.[0].data.status
    ).toBe("SUCCEEDED");
  });

  it("creates a proposed category only after explicit approval and Shelf permission", async () => {
    const { result } = await applyNewImport({
      quantity: 1,
      type: "QUANTITY_TRACKED",
      useExistingCategory: false,
      newCategoryName: "Sensors",
      approveNewCategory: true,
    });

    const applied = result as StaffImportResult;
    expect(applied.succeededRows).toBe(1);
    expect(mockRequirePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "staff-1",
        entity: PermissionEntity.category,
        action: PermissionAction.create,
      })
    );
    expect(mockCreateCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Sensors",
        userId: "staff-1",
        organizationId: "org-1",
      })
    );
  });

  it("does not create a category when the staff member lacks category:create permission", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        useExistingCategory: false,
        newCategoryName: "Sensors",
        approveNewCategory: true,
        denyCategoryPermission: true,
      })
    ).rejects.toThrow("Permission denied");

    expect(mockCreateCategory).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("blocks Apply when a new category has not been explicitly approved", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        useExistingCategory: false,
        newCategoryName: "Sensors",
      })
    ).rejects.toThrow("Row 2 is NEEDS_REVIEW");

    expect(mockCreateCategory).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("blocks a category archived after review before writing", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        categoryArchivedAfterReview: true,
      })
    ).rejects.toThrow(/Row 2 is CONFLICT/i);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("blocks a category that appeared after review before any inventory write", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        useExistingCategory: false,
        newCategoryName: "Sensors",
        approveNewCategory: true,
        categoryAppearedAfterReview: true,
      })
    ).rejects.toThrow(/Row 2 is CONFLICT/i);
    expect(mockCreateCategory).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("does not let Approve bypass a category that still needs a decision", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        useExistingCategory: false,
        newCategoryName: "Sensors",
        approveNewCategory: false,
      })
    ).rejects.toThrow(/Row 2 is NEEDS_REVIEW/i);
    expect(mockCreateCategory).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("does not let Approve bypass an ambiguous location", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        ambiguousLocation: true,
      })
    ).rejects.toThrow(/Row 2 is NEEDS_REVIEW/i);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("allows an explicit skip without creating inventory", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      useExistingCategory: false,
      skipDecision: true,
    });

    expect((result as StaffImportResult).skippedRows).toBe(1);
    expect(assetRows).toHaveLength(0);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("requires tracking mode and persists reviewed quantity settings", async () => {
    await expect(
      applyNewImport({
        quantity: 1,
        type: "QUANTITY_TRACKED",
        decisionType: null,
      })
    ).rejects.toThrow(/Row 2 is NEEDS_REVIEW/i);

    const { assetRows } = await applyNewImport({
      quantity: 5,
      type: "QUANTITY_TRACKED",
      minQuantity: 2,
      unitOfMeasure: "boxes",
      consumptionType: "ONE_WAY",
    });
    expect(assetRows[0]).toMatchObject({
      quantity: 5,
      minQuantity: 2,
      unitOfMeasure: "boxes",
      consumptionType: "ONE_WAY",
    });
  });

  it("allows an explicit manual choice of a valid operational location", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      type: "QUANTITY_TRACKED",
      selectedLocationId: "broken-zone",
    });

    expect((result as StaffImportResult).succeededRows).toBe(1);
    expect(assetRows[0].locationId).toBe("broken-zone");
  });

  it("creates five individual Assets with one model and distinct QR IDs", async () => {
    const { result, assetRows, ledgerRows, modelId } = await applyNewImport({
      quantity: 5,
    });

    expect(
      ledgerRows
        .filter((item) => item.unitIndex !== null)
        .map((item) => [item.unitIndex, item.status])
    ).toEqual([
      [0, "DONE"],
      [1, "DONE"],
      [2, "DONE"],
      [3, "DONE"],
      [4, "DONE"],
    ]);
    expect(assetRows).toHaveLength(5);
    expect(assetRows.map((asset) => asset.title)).toEqual([
      "Arduino Nano #001",
      "Arduino Nano #002",
      "Arduino Nano #003",
      "Arduino Nano #004",
      "Arduino Nano #005",
    ]);
    expect(assetRows.every((asset) => asset.assetModelId === modelId)).toBe(
      true
    );
    expect(new Set(assetRows.map((asset) => asset.id)).size).toBe(5);
    expect(new Set(assetRows.map((asset) => asset.newQrId)).size).toBe(5);
    expect(ledgerRows.filter((item) => item.unitIndex !== null)).toHaveLength(
      5
    );
    expect(result).toMatchObject({
      totalRows: 5,
      succeededRows: 5,
      failedRowsCount: 0,
      conflictedRowsCount: 0,
    });
    expect(mockCreateAssetModel).toHaveBeenCalledTimes(1);
  });

  it("returns the stored successful result on a second apply without duplicate Assets", async () => {
    const { result, assetRows, operationId, proposalHash } =
      await applyNewImport({
        quantity: 5,
      });
    const secondResult = await applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash,
    });

    expect(secondResult).toEqual(result);
    expect(assetRows).toHaveLength(5);
    expect(mockCreateAsset).toHaveBeenCalledTimes(5);
    expect(mockCreateAssetModel).toHaveBeenCalledTimes(1);
  });

  it("rejects a proposal with unresolved rows even when Apply is called directly", async () => {
    await expect(
      applyNewImport({ quantity: 1, omitReviewDecisions: true })
    ).rejects.toThrow("Staff confirmation is required");
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("rejects a stale proposal hash before any inventory write", async () => {
    await expect(
      applyNewImport({ quantity: 1, proposalHashOverride: "stale-hash" })
    ).rejects.toThrow("proposal changed after review");
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("enforces the existing staff access gate on Apply", async () => {
    await expect(
      applyNewImport({ quantity: 1, denyStaffAccess: true })
    ).rejects.toThrow("Staff access denied");
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("blocks an equivalent reviewed proposal already applying elsewhere", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      raceWinner: { id: "operation-winner", status: "APPLYING" },
    });

    expect(result).toEqual({
      status: "IN_PROGRESS",
      operationId: "operation-winner",
    });
    expect(assetRows).toHaveLength(0);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("warns and blocks when the exact reviewed proposal already succeeded", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      duplicateProposal: { id: "completed-import", status: "SUCCEEDED" },
    });

    expect(result).toMatchObject({
      status: "DUPLICATE",
      code: "SAME_PROPOSAL",
      canOverride: false,
    });
    expect(assetRows).toHaveLength(0);
    expect(mockCreateAsset).not.toHaveBeenCalled();
  });

  it("warns for the same PDF with changed decisions and requires an explicit override", async () => {
    const duplicateFile = {
      id: "prior-file-import",
      status: "SUCCEEDED",
      proposalSha256: "a-different-reviewed-proposal-hash",
    };
    const blocked = await applyNewImport({ quantity: 1, duplicateFile });
    expect(blocked.result).toMatchObject({
      status: "DUPLICATE",
      code: "SAME_FILE_DIFFERENT_PROPOSAL",
      canOverride: true,
    });
    expect(blocked.assetRows).toHaveLength(0);

    const explicitlyConfirmed = await applyNewImport({
      quantity: 1,
      duplicateFile,
      allowSameFileReimport: true,
    });
    expect(explicitlyConfirmed.result).toMatchObject({
      totalRows: 1,
      succeededRows: 1,
    });
    expect(explicitlyConfirmed.assetRows).toHaveLength(1);
  });

  it("does not treat a matching proposal hash in another organization as a duplicate", async () => {
    const { result, assetRows } = await applyNewImport({
      quantity: 1,
      duplicateProposal: {
        id: "other-org-import",
        status: "SUCCEEDED",
        organizationId: "org-2",
      },
    });

    expect(result).toMatchObject({ succeededRows: 1 });
    expect(assetRows).toHaveLength(1);
  });

  it.each(["quantity", "categoryId", "locationId"] as const)(
    "blocks a %s edit after review as CONFLICT without overwriting it",
    async (changedField) => {
      await expect(applyAfterConcurrentAssetEdit(changedField)).rejects.toThrow(
        /CONFLICT/i
      );
      expect(mockUpdateAsset).not.toHaveBeenCalled();
    }
  );

  it("resumes after three DONE units without recreating them", async () => {
    const {
      result: firstResult,
      assetRows,
      ledgerRows,
      operationId,
      operation,
      proposalHash,
    } = await applyNewImport({ quantity: 5, pauseAtUnitIndex: 3 });
    expect(firstResult).toEqual({ status: "IN_PROGRESS", operationId });
    expect(assetRows).toHaveLength(3);

    operation.updatedAt = new Date(Date.now() - 11 * 60 * 1000);
    const pausedUnit = ledgerRows.find((item) => item.unitIndex === 3)!;
    pausedUnit.updatedAt = new Date(Date.now() - 11 * 60 * 1000);
    const parentItem = ledgerRows.find((item) => item.unitIndex === null)!;
    parentItem.updatedAt = new Date(Date.now() - 11 * 60 * 1000);
    parentItem.heartbeatAt = new Date(Date.now() - 11 * 60 * 1000);
    const firstThreeIds = ledgerRows
      .filter((item) => item.unitIndex !== null && item.unitIndex < 3)
      .map((item) => item.targetAssetId);

    const resumedResult = await applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash,
    });

    expect(
      ledgerRows
        .filter((item) => item.unitIndex !== null)
        .map((item) => [item.unitIndex, item.status])
    ).toEqual([
      [0, "DONE"],
      [1, "DONE"],
      [2, "DONE"],
      [3, "DONE"],
      [4, "DONE"],
    ]);
    expect(assetRows).toHaveLength(5);
    expect(resumedResult).toMatchObject({ totalRows: 5, succeededRows: 5 });
    expect(new Set(assetRows.map((asset) => asset.id)).size).toBe(5);
    expect(
      assetRows.filter((asset) => firstThreeIds.includes(asset.id))
    ).toHaveLength(3);
    expect(mockCreateAsset).toHaveBeenCalledTimes(5);
    expect(resumedResult).toMatchObject({
      totalRows: 5,
      succeededRows: 5,
      failedRowsCount: 0,
      conflictedRowsCount: 0,
    });
  });

  it("uses a deterministic alternative when an individual unit title already exists", async () => {
    const { assetRows } = await applyNewImport({
      quantity: 2,
      existingAssets: [{ id: "existing-asset", title: "Arduino Nano #001" }],
    });

    expect(assetRows.map((asset) => asset.title)).toEqual([
      expect.stringMatching(/^Arduino Nano #001 \(import .*\)$/),
      "Arduino Nano #002",
    ]);
  });

  it("preserves quantity-tracked quantity semantics without creating individual units", async () => {
    const { result, assetRows, ledgerRows, modelId } = await applyNewImport({
      quantity: 5,
      type: "QUANTITY_TRACKED",
    });

    expect(assetRows).toHaveLength(1);
    expect(assetRows[0]).toMatchObject({
      type: "QUANTITY_TRACKED",
      quantity: 5,
    });
    expect(assetRows[0]).not.toHaveProperty("assetModelId");
    expect(ledgerRows.filter((item) => item.unitIndex !== null)).toHaveLength(
      0
    );
    expect(modelId).toBeNull();
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ totalRows: 1, succeededRows: 1 });
  });

  it("enforces named individual-unit limits without affecting quantity-tracked rows", () => {
    const individualRow = {
      rowNumber: 2,
      title: "Arduino Nano",
      action: "CREATE",
      assetId: null,
      type: "INDIVIDUAL",
      quantity: 101,
      receivedQuantity: 101,
      quantityStatus: "RECEIVED",
    };
    const quantityTrackedRow = {
      ...individualRow,
      type: "QUANTITY_TRACKED",
      quantity: 5000,
      receivedQuantity: 5000,
    };

    expect(
      getIndividualUnitImportLimitError([individualRow] as never)
    ).toContain("100 individual units");
    expect(
      getIndividualUnitImportLimitError(
        Array.from({ length: 6 }, (_, index) => ({
          ...individualRow,
          rowNumber: index + 2,
          quantity: 100,
          receivedQuantity: 100,
        })) as never
      )
    ).toContain("500 individual units");
    expect(
      getIndividualUnitImportLimitError([quantityTrackedRow] as never)
    ).toBeNull();
  });

  it("parses the supported safe columns and preserves row numbers", async () => {
    const rows = await parseStaffImportFile({
      filename: "inventory.csv",
      contentType: "text/csv",
      buffer: Buffer.from(
        "Name,Quantity,Category,Location\nArduino Nano,8,Boards,B477\n"
      ),
    });

    expect(rows).toEqual([
      {
        rowNumber: 2,
        title: "Arduino Nano",
        quantity: 8,
        category: "Boards",
        location: "B477",
        type: null,
      },
    ]);
  });

  it("rejects personal borrower columns before proposal creation", async () => {
    await expect(
      parseStaffImportFile({
        filename: "inventory.csv",
        buffer: Buffer.from(
          "Name,Borrower email\nArduino Nano,person@example.com\n"
        ),
      })
    ).rejects.toThrow("Personal borrower or account columns are not accepted.");
  });

  it("reads the first worksheet of an XLSX as values", async () => {
    const workbook = new JSZip();
    workbook.file(
      "xl/workbook.xml",
      '<workbook><sheets><sheet name="Inventory" r:id="rId1" /></sheets></workbook>'
    );
    workbook.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" /></Relationships>'
    );
    workbook.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Quantity</t></is></c></row><row><c r="A2" t="inlineStr"><is><t>Arduino Nano</t></is></c><c r="B2"><v>8</v></c></row></sheetData></worksheet>'
    );
    const buffer = await workbook.generateAsync({ type: "nodebuffer" });
    const rows = await parseStaffImportFile({
      filename: "inventory.xlsx",
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer,
    });

    expect(rows[0]).toMatchObject({ title: "Arduino Nano", quantity: 8 });
  });

  it("keeps procurement fields while ignoring price and invoice columns", async () => {
    const rows = await parseStaffImportFile({
      filename: "mouser-order.csv",
      contentType: "text/csv",
      buffer: Buffer.from(
        "Product Description,Manufacturer,MPN,Quantity Ordered,Quantity Shipped,Unit Price,Invoice Number\nArduino ABX00028 Nano Every,Arduino,ABX00028,5,4,25.00,INV-42\n"
      ),
    });

    expect(rows[0]).toMatchObject({
      title: "Arduino ABX00028 Nano Every",
      sourceDescription: "Arduino ABX00028 Nano Every",
      manufacturer: "Arduino",
      manufacturerPartNumber: "ABX00028",
      orderedQuantity: 5,
      receivedQuantity: 4,
      quantityStatus: "RECEIVED",
    });
    expect(rows[0]).not.toHaveProperty("price");
    expect(rows[0]).not.toHaveProperty("invoiceNumber");
  });

  it("extracts delimited PDF text into a review-required proposal row", async () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n(Name|Quantity|Category|Location) Tj\n(Arduino Nano|8|Boards|B477) Tj\nendstream\nendobj\n%%EOF`,
      "latin1"
    );
    const rows = await parseStaffImportFile({
      filename: "inventory.pdf",
      contentType: "application/pdf",
      buffer: pdf,
    });

    expect(rows[0]).toMatchObject({
      title: "Arduino Nano",
      quantity: 8,
      category: "Boards",
      location: "B477",
      reviewRequired: true,
    });
  });

  it("keeps a clear fatal error for an unreadable PDF", async () => {
    await expect(
      parseStaffImportFile({
        filename: "inventory.pdf",
        contentType: "application/pdf",
        buffer: Buffer.from("%PDF-1.4\nnot readable inventory text", "latin1"),
      })
    ).rejects.toThrow(
      "This PDF appears to be scanned. Scanned-PDF OCR is not supported yet."
    );
  });

  it("rejects malformed PDFs before calling the helper", async () => {
    mockRequestImportHelperProposal.mockClear();
    await expect(
      parseStaffImportFile({
        filename: "not-a-pdf.pdf",
        contentType: "application/pdf",
        buffer: Buffer.from("not a PDF"),
      })
    ).rejects.toThrow("not a valid PDF");
    expect(mockRequestImportHelperProposal).not.toHaveBeenCalled();
  });

  it("calls the validated helper with page evidence and stores proposal-only candidates", async () => {
    const firstPageText = "Supplier inventory";
    const sourceText = "Order line: Arduino Nano quantity 3";
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page /Contents 3 0 R >>\nendobj\n2 0 obj\n<< /Type /Page /Contents 4 0 R >>\nendobj\n3 0 obj\n<< /Length 1 >>\nstream\n(${firstPageText}) Tj\nendstream\nendobj\n4 0 obj\n<< /Length 1 >>\nstream\n(${sourceText}) Tj\nendstream\nendobj\n%%EOF`,
      "latin1"
    );
    const helperResponse = {
      schemaVersion: 1,
      rows: [
        {
          sourceRef: "pdf-page-2",
          productName: "Arduino Nano",
          quantity: 3,
          manufacturer: "Arduino",
          mpn: "ABX00028",
          description: "Arduino Nano board",
          productMatch: {
            matchType: "NEW",
            candidateId: null,
            confidence: 0.88,
          },
          categorySuggestion: {
            categoryId: "cat-electronics",
            proposedName: null,
            confidence: 0.96,
          },
          trackingSuggestion: { mode: "INDIVIDUAL", confidence: 0.9 },
          kitHint: { isKit: false, name: null, confidence: 0.99 },
          settingsSuggestions: [],
          locationSuggestions: [{ locationId: "loc-shelf", confidence: 0.8 }],
          questions: [],
          evidence: [
            { sourceRef: "pdf-page-2", text: "Arduino Nano quantity 3" },
          ],
        },
      ],
      questions: [],
    } as const;

    vi.clearAllMocks();
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([
      {
        id: "asset-existing-cable",
        title: "USB-C Cable",
        type: "QUANTITY_TRACKED",
        quantity: 18,
        description: null,
        categoryId: "cat-electronics",
        assetModelId: null,
        assetLocations: [
          { locationId: "loc-shelf", quantity: 18, assetKitId: null },
        ],
      },
    ]);
    database.location.findMany.mockResolvedValue([
      { id: "room", name: "IOIO Lab – B477", parentId: null },
      { id: "loc-shelf", name: "Container A1-1.1", parentId: "room" },
      { id: "broken", name: "Problem / Broken Zone", parentId: "room" },
      { id: "pickup", name: "Pickup Zone", parentId: "room" },
      { id: "return", name: "Return Section", parentId: "room" },
    ]);
    mockGetBrokenSection.mockResolvedValue({ id: "broken" });
    mockGetReturnArea.mockResolvedValue("IOIO Lab – B477 · Return Section");
    mockGetCategories.mockResolvedValue([
      { id: "cat-electronics", name: "Electronics" },
    ]);
    database.ioioWriteOperation.findUnique.mockResolvedValue(null);
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "operation-pdf-helper",
    });
    database.ioioImportItem.createMany.mockResolvedValue({ count: 1 });
    database.ioioImportItem.findMany.mockResolvedValue([]);
    mockRequestImportHelperProposal.mockImplementation((request) => ({
      status: "ready",
      proposal: validateImportHelperResponse(helperResponse, request),
    }));

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File([pdf], "inventory.pdf", { type: "application/pdf" }),
    });

    expect(prepared.status).toBe("PREPARED");
    if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
    const [helperRequest] = mockRequestImportHelperProposal.mock.calls[0];
    expect(helperRequest.document.pages).toEqual([
      {
        sourceRef: "pdf-page-1",
        page: 1,
        text: firstPageText,
      },
      {
        sourceRef: "pdf-page-2",
        page: 2,
        text: sourceText,
      },
    ]);
    expect(helperRequest.document.sha256).toBe(
      createHash("sha256").update(pdf).digest("hex")
    );
    expect(helperRequest.relevantLocations).toEqual([
      expect.objectContaining({
        id: "room",
        pathLabel: "IOIO Lab – B477",
      }),
      expect.objectContaining({
        id: "loc-shelf",
        pathLabel: "IOIO Lab – B477 · Container A1-1.1",
        occupancy: expect.objectContaining({ currentUnits: 18 }),
      }),
    ]);
    expect(prepared.proposal.locationOptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "broken", operational: true }),
        expect.objectContaining({ id: "pickup", operational: true }),
        expect.objectContaining({ id: "return", operational: true }),
      ])
    );
    expect(prepared.proposal.source.sha256).toBe(helperRequest.document.sha256);
    expect(database.category.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1", id: { in: [] } },
      })
    );
    expect(database.location.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: "org-1" } })
    );
    expect(prepared.proposal.source.extractionProvider).toBe(
      "import-helper:v1"
    );
    expect(prepared.proposal.rows[0]).toMatchObject({
      title: "Arduino Nano",
      quantity: 3,
      receivedQuantity: null,
      type: "INDIVIDUAL",
      action: "NEEDS_REVIEW",
      categoryId: "cat-electronics",
      locationId: "loc-shelf",
      sourceEvidence: [
        {
          sourceRef: "pdf-page-2",
          page: 2,
          text: "Arduino Nano quantity 3",
        },
      ],
      helperCandidate: helperResponse.rows[0],
    });
    expect(mockCreateAsset).not.toHaveBeenCalled();
    expect(mockUpdateAsset).not.toHaveBeenCalled();
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "invalid-response" as const, label: "invalid helper output" },
    { reason: "unavailable" as const, label: "unavailable helper" },
  ])(
    "uses deterministic rows when the $label cannot return a proposal",
    async ({ reason }) => {
      const pdf = Buffer.from(
        `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n(Name|Quantity|Category|Location) Tj\n(Arduino Nano|4|Boards|Shelf A) Tj\nendstream\nendobj\n%%EOF`,
        "latin1"
      );
      vi.clearAllMocks();
      mockStaffAccess.mockResolvedValue({
        organizationId: "org-1",
        userId: "staff-1",
      });
      database.asset.findMany.mockResolvedValue([]);
      database.location.findMany.mockResolvedValue([
        { id: "loc-shelf", name: "Shelf A" },
      ]);
      mockGetCategories.mockResolvedValue([
        { id: "cat-boards", name: "Boards" },
      ]);
      database.ioioWriteOperation.findUnique.mockResolvedValue(null);
      database.ioioWriteOperation.findFirst.mockResolvedValue({
        id: "operation-pdf-fallback",
      });
      database.ioioImportItem.createMany.mockResolvedValue({ count: 1 });
      database.ioioImportItem.findMany.mockResolvedValue([]);
      mockRequestImportHelperProposal.mockResolvedValue({
        status: "manual",
        reason,
      });

      const prepared = await prepareStaffInventoryImport({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/staff/import"),
        file: new File([pdf], "inventory.pdf", { type: "application/pdf" }),
      });

      expect(prepared.status).toBe("PREPARED");
      if (prepared.status !== "PREPARED") throw new Error("Expected proposal");
      expect(prepared.proposal.source.extractionProvider).toBe("deterministic");
      expect(prepared.proposal.rows[0]).toMatchObject({
        title: "Arduino Nano",
        quantity: 4,
        sourceEvidence: [{ sourceRef: "pdf-page-1", page: 1 }],
      });
      expect(mockCreateAsset).not.toHaveBeenCalled();
      expect(mockUpdateAsset).not.toHaveBeenCalled();
      expect(mockCreateAssetModel).not.toHaveBeenCalled();
    }
  );

  it("returns a stored SUCCEEDED result without creating PENDING ledger rows", async () => {
    const result = {
      operationId: "operation-succeeded",
      createdIds: ["asset-1"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [],
      conflictRows: [],
      ignoredRows: 0,
      reviewedRows: 1,
      totalRows: 1,
      succeededRows: 1,
      failedRowsCount: 0,
      conflictedRowsCount: 0,
      skippedRows: 0,
    };
    const proposal = {
      version: 1 as const,
      operationId: result.operationId,
      organizationId: "org-1",
      source: {
        filename: "inventory.csv",
        size: 16,
        sha256: "file-sha",
      },
      rows: [],
      counts: {},
      createdAt: "2026-10-26T00:00:00.000Z",
    };
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([]);
    mockGetCategories.mockResolvedValue([]);
    database.ioioWriteOperation.findUnique.mockResolvedValue({
      status: "SUCCEEDED",
      description: JSON.stringify({ proposal, result }),
      createdAt: new Date("2026-10-26T00:00:00.000Z"),
    });

    const response = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(["Name,Quantity\nNano,1"], "inventory.csv", {
        type: "text/csv",
      }),
    });

    expect(response).toEqual({ status: "SUCCEEDED", result });
    expect(database.ioioImportItem.createMany).not.toHaveBeenCalled();
    expect(database.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("returns the stored PARTIAL result when the same file is prepared again", async () => {
    vi.clearAllMocks();
    const result = {
      operationId: "operation-partial",
      createdIds: ["asset-1"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [{ rowNumber: 3, reason: "Needs correction." }],
      conflictRows: [],
      ignoredRows: 0,
      reviewedRows: 1,
      totalRows: 2,
      succeededRows: 1,
      failedRowsCount: 1,
      conflictedRowsCount: 0,
      skippedRows: 0,
    };
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.asset.findMany.mockResolvedValue([]);
    database.location.findMany.mockResolvedValue([]);
    mockGetCategories.mockResolvedValue([]);
    database.ioioWriteOperation.findUnique.mockResolvedValue({
      status: "PARTIAL",
      description: JSON.stringify({ result }),
      createdAt: new Date(),
    });

    const prepared = await prepareStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      file: new File(["Name,Quantity\nNano,1"], "inventory.csv", {
        type: "text/csv",
      }),
    });

    expect(prepared).toEqual({ status: "PARTIAL", result });
    expect(database.ioioImportItem.createMany).not.toHaveBeenCalled();
    expect(database.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("resumes from DONE ledger rows without repeating the Shelf write", async () => {
    const operationId = "operation-resume";
    const row = {
      rowNumber: 2,
      title: "Arduino Nano",
      action: "CREATE" as const,
      assetId: null,
      type: "QUANTITY_TRACKED" as const,
      quantity: 1,
      category: "Electronics",
      categoryId: "category-electronics",
      location: null,
      locationId: null,
      currentQuantity: null,
      currentCategoryId: null,
      currentLocationId: null,
      reason: "New item",
    };
    const proposalContent = {
      version: 1 as const,
      operationId,
      organizationId: "org-1",
      source: { filename: "inventory.csv", size: 42, sha256: "resume-hash" },
      rows: [row],
      counts: {
        CREATE: 1,
        INCREASE_QUANTITY: 0,
        NO_CHANGE: 0,
        POSSIBLE_DUPLICATE: 0,
        NEEDS_REVIEW: 0,
        IGNORE: 0,
        UPDATE_QUANTITY: 0,
        UPDATE_LOCATION: 0,
        UPDATE_CATEGORY: 0,
        AMBIGUOUS: 0,
        REJECT: 0,
      },
      createdAt: new Date().toISOString(),
    };
    const proposal = {
      ...proposalContent,
      proposalHash: getStaffImportProposalHash(proposalContent),
    };
    const operation = {
      id: operationId,
      operationType: "INVENTORY_IMPORT",
      organizationId: "org-1",
      userId: "staff-1",
      status: "APPLYING",
      createdAt: new Date(),
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
      description: JSON.stringify({
        proposal,
        executionPlan: { rows: [row], reviewedRows: 1 },
      }),
    };
    const ledgerItem = {
      id: "ledger-1",
      operationId,
      organizationId: "org-1",
      rowKey: "row-2",
      unitIndex: null,
      status: "DONE",
      attempt: 1,
      heartbeatAt: null,
      updatedAt: new Date(),
      writtenState: { outcome: "created", assetId: "asset-1" },
    };
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.ioioWriteOperation.findFirst.mockResolvedValue(operation);
    database.ioioWriteOperation.updateMany.mockResolvedValue({ count: 1 });
    database.ioioImportItem.createMany.mockResolvedValue({ count: 0 });
    database.ioioImportItem.findMany.mockImplementation(({ where }) =>
      where.status === "IN_FLIGHT" ? [] : [ledgerItem]
    );

    const result = await applyStaffInventoryImport({
      context: { getSession: () => ({ userId: "staff-1" }) } as never,
      request: new Request("http://localhost/staff/import"),
      operationId,
      proposalHash: proposal.proposalHash,
    });

    expect(result).toMatchObject({
      operationId,
      createdIds: ["asset-1"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [],
      conflictRows: [],
      totalRows: 1,
      succeededRows: 1,
      failedRowsCount: 0,
      conflictedRowsCount: 0,
      skippedRows: 0,
    });
    expect(
      database.ioioWriteOperation.updateMany.mock.calls.at(-1)?.[0].data.status
    ).toBe("SUCCEEDED");
    expect(database.ioioImportItem.updateMany).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
    expect(mockUpdateAsset).not.toHaveBeenCalled();
  });

  it.each([
    { label: "all DONE", statuses: ["DONE"], expected: "SUCCEEDED" },
    {
      label: "DONE and SKIPPED",
      statuses: ["DONE", "SKIPPED"],
      expected: "SUCCEEDED",
    },
    {
      label: "DONE and FAILED",
      statuses: ["DONE", "FAILED"],
      expected: "PARTIAL",
    },
    {
      label: "DONE and CONFLICT",
      statuses: ["DONE", "CONFLICT"],
      expected: "PARTIAL",
    },
    {
      label: "DONE, FAILED, and CONFLICT",
      statuses: ["DONE", "FAILED", "CONFLICT"],
      expected: "PARTIAL",
    },
    {
      label: "DONE, SKIPPED, and FAILED",
      statuses: ["DONE", "SKIPPED", "FAILED"],
      expected: "PARTIAL",
    },
    { label: "all FAILED", statuses: ["FAILED", "FAILED"], expected: "FAILED" },
    {
      label: "all CONFLICT",
      statuses: ["CONFLICT", "CONFLICT"],
      expected: "FAILED",
    },
    {
      label: "active work",
      statuses: ["DONE", "IN_FLIGHT"],
      expected: "APPLYING",
    },
  ])("aggregates $label as $expected", ({ statuses, expected }) => {
    expect(
      summarizeStaffImportRows(
        statuses as Array<
          "PENDING" | "IN_FLIGHT" | "DONE" | "FAILED" | "CONFLICT" | "SKIPPED"
        >
      ).status
    ).toBe(expected);
  });

  it("counts total, successful, failed, conflicted, and skipped rows", () => {
    expect(
      summarizeStaffImportRows([
        "DONE",
        "DONE",
        "SKIPPED",
        "FAILED",
        "CONFLICT",
      ])
    ).toEqual({
      totalRows: 5,
      succeededRows: 2,
      failedRowsCount: 1,
      conflictedRowsCount: 1,
      skippedRows: 1,
      status: "PARTIAL",
    });
  });

  it("returns PARTIAL results without retrying terminal ledger rows", async () => {
    vi.clearAllMocks();
    const operationId = "operation-partial";
    const result = {
      operationId,
      createdIds: ["asset-done"],
      updatedIds: [],
      reusedIds: [],
      failedRows: [{ rowNumber: 3, reason: "Invalid category." }],
      conflictRows: [{ rowNumber: 4, reason: "Needs manual review." }],
      ignoredRows: 0,
      reviewedRows: 4,
      totalRows: 4,
      succeededRows: 1,
      failedRowsCount: 1,
      conflictedRowsCount: 1,
      skippedRows: 0,
    };
    mockStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    database.ioioWriteOperation.findFirst.mockResolvedValue({
      id: operationId,
      operationType: "INVENTORY_IMPORT",
      organizationId: "org-1",
      userId: "staff-1",
      status: "PARTIAL",
      description: JSON.stringify({ result }),
    });

    await expect(
      applyStaffInventoryImport({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request: new Request("http://localhost/staff/import"),
        operationId,
        proposalHash: "unused-terminal-status-hash",
      })
    ).resolves.toEqual(result);
    expect(database.ioioImportItem.createMany).not.toHaveBeenCalled();
    expect(database.ioioImportItem.updateMany).not.toHaveBeenCalled();
    expect(mockCreateAsset).not.toHaveBeenCalled();
    expect(mockUpdateAsset).not.toHaveBeenCalled();
  });

  it("skips blank separators, repeated headers, and page markers in PDF tables", async () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n(Name|Quantity|Category|Location) Tj\n(Arduino Nano|8|Boards|B477) Tj\n(|||) Tj\n(Name|Quantity|Category|Location) Tj\n(Page 2 of 2|||) Tj\n(Arduino Uno|3|Boards|B477) Tj\nendstream\nendobj\n%%EOF`,
      "latin1"
    );

    const rows = await parseStaffImportFile({
      filename: "inventory.pdf",
      contentType: "application/pdf",
      buffer: pdf,
    });

    expect(rows.map((row) => row.title)).toEqual([
      "Arduino Nano",
      "Arduino Uno",
    ]);
  });

  it("keeps a PDF row with inventory values but no item name for review", async () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n(Name|Quantity|Category|Location) Tj\n(|8|Boards|B477) Tj\nendstream\nendobj\n%%EOF`,
      "latin1"
    );

    const rows = await parseStaffImportFile({
      filename: "inventory.pdf",
      contentType: "application/pdf",
      buffer: pdf,
    });

    expect(rows[0]).toMatchObject({
      title: "",
      quantity: 8,
      pdfClassification: "PARTIAL",
      reviewRequired: true,
    });
  });

  it("preserves valid PDF rows when another row has an invalid quantity", async () => {
    const pdf = Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nstream\n(Name|Quantity|Category|Location) Tj\n(Arduino Nano|8|Boards|B477) Tj\n(|6|Boards|B477) Tj\n(Multimeter|not-a-number|Measurement|B443) Tj\nendstream\nendobj\n%%EOF`,
      "latin1"
    );

    const rows = await parseStaffImportFile({
      filename: "inventory.pdf",
      contentType: "application/pdf",
      buffer: pdf,
    });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      title: "Arduino Nano",
      pdfClassification: "VALID_ITEM",
    });
    expect(rows[1]).toMatchObject({
      title: "",
      pdfClassification: "PARTIAL",
    });
    expect(rows[2]).toMatchObject({
      title: "Multimeter",
      quantity: null,
      pdfClassification: "PARTIAL",
    });
  });

  it("does not auto-resolve duplicate names", () => {
    const rows = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          quantity: null,
          category: null,
          location: null,
          type: null,
        },
      ],
      assets: [
        {
          id: "asset-1",
          title: "Arduino Nano",
          type: "INDIVIDUAL",
          quantity: null,
          categoryId: null,
          assetLocations: [],
        },
        {
          id: "asset-2",
          title: "Arduino Nano",
          type: "INDIVIDUAL",
          quantity: null,
          categoryId: null,
          assetLocations: [],
        },
      ],
      categories: [],
      locations: [],
    });

    expect(rows[0].action).toBe("AMBIGUOUS");
    expect(rows[0].assetId).toBeNull();
  });

  it("creates one controlled quantity update when the match is unique", () => {
    const [row] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          quantity: 8,
          category: null,
          location: null,
          type: "QUANTITY_TRACKED",
        },
      ],
      assets: [
        {
          id: "asset-1",
          title: "Arduino Nano",
          type: "QUANTITY_TRACKED",
          quantity: 4,
          categoryId: null,
          assetLocations: [],
        },
      ],
      categories: [],
      locations: [],
    });

    expect(row.action).toBe("UPDATE_QUANTITY");
    expect(row.assetId).toBe("asset-1");
    expect(row.reason).toContain("quantity");
  });

  it("proposes an increase only from confirmed received quantity", () => {
    const [received] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          quantity: 5,
          orderedQuantity: 5,
          receivedQuantity: 5,
          quantityStatus: "RECEIVED",
          category: "Boards & Embedded Systems",
          location: null,
          type: "QUANTITY_TRACKED",
          sourceDescription: "ARDUINO ABX00028 NANO",
        },
      ],
      assets: [
        {
          id: "asset-1",
          title: "Arduino Nano",
          type: "QUANTITY_TRACKED",
          quantity: 8,
          categoryId: "category-1",
          assetLocations: [],
        },
      ],
      categories: [{ id: "category-1", name: "Boards & Embedded Systems" }],
      locations: [],
    });

    expect(received.action).toBe("INCREASE_QUANTITY");
    expect(received.proposedQuantity).toBe(13);

    const [ordered] = classifyStaffImportRows({
      rows: [
        {
          rowNumber: 2,
          title: "Arduino Nano",
          quantity: 5,
          orderedQuantity: 5,
          quantityStatus: "ORDERED",
          category: "Boards & Embedded Systems",
          location: null,
          type: "QUANTITY_TRACKED",
          sourceDescription: "ARDUINO ABX00028 NANO",
        },
      ],
      assets: [
        {
          id: "asset-1",
          title: "Arduino Nano",
          type: "QUANTITY_TRACKED",
          quantity: 8,
          categoryId: "category-1",
          assetLocations: [],
        },
      ],
      categories: [{ id: "category-1", name: "Boards & Embedded Systems" }],
      locations: [],
    });

    expect(ordered.action).toBe("NEEDS_REVIEW");
    expect(ordered.proposedQuantity).toBe(8);
  });
});
