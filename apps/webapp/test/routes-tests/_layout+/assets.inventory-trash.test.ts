// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getAssetIndexSettings: vi.fn(),
  trashIoioItems: vi.fn(),
  archiveIoioItems: vi.fn(),
  sendNotification: vi.fn(),
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
vi.mock("~/modules/asset/service.server", () => ({
  addIndividualUnitsToAssetModel: vi.fn(),
  bulkDeleteAssets: vi.fn(),
}));

// why: notification delivery is external to the action's lifecycle routing.
vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: mocks.sendNotification,
}));

// why: the action does not access the database directly; stubbing prevents
// db.server's development connection from opening during route import.
vi.mock("~/database/db.server", () => ({
  db: { user: { findUniqueOrThrow: vi.fn() } },
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
});
