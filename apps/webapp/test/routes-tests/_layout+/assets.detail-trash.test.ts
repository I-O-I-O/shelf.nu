// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  trashIoioItems: vi.fn(),
  archiveIoioItems: vi.fn(),
  sendNotification: vi.fn(),
}));

// why: the route's Staff authorization boundary is fixed for this action test.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));

// why: the test verifies route behavior after a successful lifecycle service
// call and does not need to mutate the local database.
vi.mock("~/modules/ioio-staff/archive.server", () => ({
  archiveIoioItems: mocks.archiveIoioItems,
  getIoioAssetLifecycleRedirectTarget: vi.fn(),
  trashIoioItems: mocks.trashIoioItems,
}));
vi.mock("~/modules/asset/service.server", () => ({
  deleteAsset: vi.fn(),
  deleteOtherImages: vi.fn(),
  getAsset: vi.fn(),
  relinkAssetQrCode: vi.fn(),
}));

// why: notification delivery is outside the safe return-navigation contract.
vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: mocks.sendNotification,
}));

// why: this action path uses only the mocked lifecycle service, not Prisma.
vi.mock("~/database/db.server", () => ({ db: {} }));

import { action } from "~/routes/_layout+/assets.$assetId";

const context = {
  getSession: () => ({ userId: "staff-1" }),
} as never;

function makeRequest(redirectTo: string) {
  return new Request("http://localhost/assets/asset-1", {
    method: "DELETE",
    body: new URLSearchParams({ intent: "trash", redirectTo }),
  });
}

describe("asset detail Trash action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePermission.mockResolvedValue({ organizationId: "org-1" });
    mocks.trashIoioItems.mockResolvedValue([{ itemId: "asset-1" }]);
  });

  it("returns to the active Inventory context after deleting from its detail", async () => {
    const result = (await action(
      createActionArgs({
        request: makeRequest("/assets?search=Makey&page=3&sort=title"),
        params: { assetId: "asset-1" },
        context,
      })
    )) as Response;

    expect(mocks.trashIoioItems).toHaveBeenCalledWith({
      organizationId: "org-1",
      items: [{ itemType: "ASSET", itemId: "asset-1" }],
      trashedById: "staff-1",
    });
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe(
      "/assets?search=Makey&page=3&sort=title"
    );
  });

  it("falls back to Inventory instead of returning to an asset detail URL", async () => {
    const result = (await action(
      createActionArgs({
        request: makeRequest("/assets/another-trashed-asset"),
        params: { assetId: "asset-1" },
        context,
      })
    )) as Response;

    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("/assets");
  });
});
