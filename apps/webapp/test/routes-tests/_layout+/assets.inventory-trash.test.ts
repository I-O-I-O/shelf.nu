// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getAssetIndexSettings: vi.fn(),
  trashIoioItems: vi.fn(),
  archiveIoioItems: vi.fn(),
  setIoioAssetHidden: vi.fn(),
  setIoioAssetsHidden: vi.fn(),
  sendNotification: vi.fn(),
  assetFindFirst: vi.fn(),
  assetFindMany: vi.fn(),
  assetModelFindFirst: vi.fn(),
  assetModelFindMany: vi.fn(),
}));

// why: permission lookup is the authorization boundary; a fixed Staff result
// lets this test focus on the active Inventory form/action contract.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));

// why: these settings are unrelated to the Trash lifecycle, but the shared
// Inventory action loads them before dispatching any intent.
vi.mock("~/modules/asset-index-settings/service.server", () => ({
  changeMode: vi.fn(),
  getAssetIndexSettings: mocks.getAssetIndexSettings,
}));

// why: only the Trash service boundary is under test; archive and asset
// service operations are separate Inventory intents.
vi.mock("~/modules/ioio-staff/archive.server", () => ({
  archiveIoioItems: mocks.archiveIoioItems,
  getIoioArchivedItemIds: vi.fn().mockResolvedValue([]),
  trashIoioItems: mocks.trashIoioItems,
}));
vi.mock("~/modules/ioio-staff/visibility.server", () => ({
  setIoioAssetHidden: mocks.setIoioAssetHidden,
  setIoioAssetsHidden: mocks.setIoioAssetsHidden,
}));
vi.mock("~/modules/asset/service.server", () => ({
  addIndividualUnitsToAssetModel: vi.fn(),
  bulkDeleteAssets: vi.fn(),
}));

// why: notification delivery is external to the action's lifecycle routing.
vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: mocks.sendNotification,
}));

// why: route action tests need controlled product ownership and no database
// connection; visibility authorization resolves the canonical AssetModel.
vi.mock("~/database/db.server", () => ({
  db: {
    user: { findUniqueOrThrow: vi.fn() },
    asset: {
      findFirst: mocks.assetFindFirst,
      findMany: mocks.assetFindMany,
    },
    assetModel: {
      findFirst: mocks.assetModelFindFirst,
      findMany: mocks.assetModelFindMany,
    },
  },
}));

import { action } from "~/routes/_layout+/assets._index";

const context = {
  getSession: () => ({ userId: "staff-1" }),
} as never;

function makeInventoryTrashRequest() {
  return new Request(
    "http://localhost/assets?search=Makey&page=2&sort=title&index",
    {
      method: "POST",
      body: new URLSearchParams({
        "assetIds[0]": "asset-1",
        currentSearchParams: "search=Makey&page=2&sort=title",
        intent: "bulk-trash",
      }),
    }
  );
}

describe("active Staff Inventory Trash action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({
      organizationId: "org-1",
      canUseBarcodes: false,
      role: "ADMIN",
    });
    mocks.getAssetIndexSettings.mockResolvedValue({});
    mocks.assetFindFirst.mockResolvedValue({ assetModelId: null });
    mocks.assetModelFindFirst.mockResolvedValue(null);
    mocks.assetFindMany.mockResolvedValue([]);
    mocks.assetModelFindMany.mockResolvedValue([]);
    mocks.trashIoioItems.mockResolvedValue([
      { itemType: "ASSET", itemId: "asset-1" },
    ]);
  });

  it("trashes the submitted Shelf Asset ID and stays on active Inventory", async () => {
    const result = (await action(
      createActionArgs({
        request: makeInventoryTrashRequest(),
        context,
      })
    )) as { success: boolean; undo: { operation: string } };

    expect(mocks.trashIoioItems).toHaveBeenCalledWith({
      organizationId: "org-1",
      items: [{ itemType: "ASSET", itemId: "asset-1" }],
      trashedById: "staff-1",
    });
    expect(result).toMatchObject({
      success: true,
      undo: { operation: "trash" },
    });
  });

  it("returns a controlled conflict for a legitimate Trash blocker", async () => {
    const { ShelfError } = await import("~/utils/error");
    mocks.trashIoioItems.mockRejectedValue(
      new ShelfError({
        cause: null,
        message:
          "One or more selected assets are checked out or in custody. Check them in before archiving or moving them to Trash.",
        label: "Assets",
        status: 409,
        shouldBeCaptured: false,
      })
    );

    const result = (await action(
      createActionArgs({
        request: makeInventoryTrashRequest(),
        context,
      })
    )) as {
      init?: { status?: number };
      data?: { error?: { message?: string } };
    };

    expect(result.init?.status).toBe(409);
    expect(result.data?.error?.message).toContain("checked out or in custody");
  });

  it("uses the update permission and visibility service for Hide asset", async () => {
    const result = (await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/assets", {
          method: "POST",
          body: new URLSearchParams({
            intent: "hide-asset",
            assetId: "makey-unit-001",
          }),
        }),
      })
    )) as unknown as { success: boolean; hidden: boolean };

    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "asset",
        action: "update",
      })
    );
    expect(mocks.setIoioAssetHidden).toHaveBeenCalledWith({
      assetId: "makey-unit-001",
      organizationId: "org-1",
      hidden: true,
    });
    expect(result).toMatchObject({ success: true, hidden: true });
  });

  it("uses AssetModel update permission for a linked product", async () => {
    mocks.assetFindFirst.mockResolvedValue({ assetModelId: "makey-model" });
    mocks.assetModelFindFirst.mockResolvedValue({ id: "makey-model" });

    const result = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/assets", {
          method: "POST",
          body: new URLSearchParams({
            intent: "hide-asset",
            assetId: "makey-unit-001",
          }),
        }),
      })
    );

    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "assetModel",
        action: "update",
      })
    );
    expect(result).toMatchObject({ success: true, hidden: true });
  });

  it("uses the same visibility service for Unhide asset", async () => {
    const result = (await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/assets", {
          method: "POST",
          body: new URLSearchParams({
            intent: "unhide-asset",
            assetId: "makey-unit-001",
          }),
        }),
      })
    )) as unknown as { success: boolean; hidden: boolean };

    expect(mocks.setIoioAssetHidden).toHaveBeenCalledWith({
      assetId: "makey-unit-001",
      organizationId: "org-1",
      hidden: false,
    });
    expect(result).toMatchObject({ success: true, hidden: false });
  });

  it("authorizes every entity scope in a mixed bulk visibility action", async () => {
    mocks.assetFindMany.mockResolvedValue([
      { id: "visible-unit", assetModelId: null },
      { id: "model-unit", assetModelId: "makey-model" },
    ]);
    mocks.assetModelFindMany.mockResolvedValue([{ id: "makey-model" }]);

    const result = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/assets", {
          method: "POST",
          body: new URLSearchParams({
            intent: "hide-asset",
            "assetIds[0]": "visible-unit",
            "assetIds[1]": "model-unit",
          }),
        }),
      })
    );

    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "asset", action: "update" })
    );
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "assetModel", action: "update" })
    );
    expect(mocks.setIoioAssetsHidden).toHaveBeenCalledWith({
      assetIds: ["visible-unit", "model-unit"],
      organizationId: "org-1",
      hidden: true,
    });
    expect(result).toMatchObject({
      success: true,
      assetIds: ["visible-unit", "model-unit"],
      hidden: true,
    });
  });
});
