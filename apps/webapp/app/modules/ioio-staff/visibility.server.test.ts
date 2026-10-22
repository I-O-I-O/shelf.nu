// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  assetFindFirst: vi.fn(),
  assetUpdate: vi.fn(),
  assetUpdateMany: vi.fn(),
  assetModelFindFirst: vi.fn(),
  assetModelUpdate: vi.fn(),
}));

// why: the service's transaction boundary is the behavior under test; a local
// callback transaction keeps these cases isolated from a configured database.
vi.mock("~/database/db.server", () => ({
  db: { $transaction: mocks.transaction },
}));

import { setIoioAssetHidden } from "./visibility.server";

describe("setIoioAssetHidden", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation((callback) =>
      callback({
        asset: {
          findFirst: mocks.assetFindFirst,
          update: mocks.assetUpdate,
          updateMany: mocks.assetUpdateMany,
        },
        assetModel: {
          findFirst: mocks.assetModelFindFirst,
          update: mocks.assetModelUpdate,
        },
      })
    );
    mocks.assetFindFirst.mockResolvedValue({
      id: "asset-1",
      assetModelId: null,
    });
    mocks.assetModelFindFirst.mockResolvedValue(null);
  });

  it("hides a grouped product through its organization-scoped AssetModel", async () => {
    mocks.assetFindFirst.mockResolvedValue({
      id: "unit-001",
      assetModelId: "makey-model",
    });
    mocks.assetModelFindFirst.mockResolvedValue({ id: "makey-model" });

    await expect(
      setIoioAssetHidden({
        assetId: "unit-001",
        organizationId: "org-1",
        hidden: true,
      })
    ).resolves.toEqual({
      scope: "asset-model",
      id: "makey-model",
      hidden: true,
    });

    expect(mocks.assetModelFindFirst).toHaveBeenCalledWith({
      where: { id: "makey-model", organizationId: "org-1" },
      select: { id: true },
    });
    expect(mocks.assetModelUpdate).toHaveBeenCalledWith({
      where: { id: "makey-model", organizationId: "org-1" },
      data: { ioioHidden: true },
    });
    expect(mocks.assetUpdate).not.toHaveBeenCalled();
    expect(mocks.assetUpdateMany).not.toHaveBeenCalled();
  });

  it("hides a standalone product without changing physical availability", async () => {
    await setIoioAssetHidden({
      assetId: "asset-1",
      organizationId: "org-1",
      hidden: true,
    });

    expect(mocks.assetUpdate).toHaveBeenCalledWith({
      where: { id: "asset-1", organizationId: "org-1" },
      data: { ioioHidden: true },
    });
    expect(mocks.assetModelUpdate).not.toHaveBeenCalled();
  });

  it("unhides the same canonical product scope", async () => {
    mocks.assetFindFirst.mockResolvedValue({
      id: "unit-001",
      assetModelId: "makey-model",
    });
    mocks.assetModelFindFirst.mockResolvedValue({ id: "makey-model" });

    await setIoioAssetHidden({
      assetId: "unit-001",
      organizationId: "org-1",
      hidden: false,
    });

    expect(mocks.assetModelUpdate).toHaveBeenCalledWith({
      where: { id: "makey-model", organizationId: "org-1" },
      data: { ioioHidden: false },
    });
  });

  it("limits legacy model-link fallback updates to the current organization", async () => {
    mocks.assetFindFirst.mockResolvedValue({
      id: "unit-001",
      assetModelId: "legacy-model",
    });

    await setIoioAssetHidden({
      assetId: "unit-001",
      organizationId: "org-1",
      hidden: true,
    });

    expect(mocks.assetUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: "org-1", assetModelId: "legacy-model" },
      data: { ioioHidden: true },
    });
    expect(mocks.assetModelUpdate).not.toHaveBeenCalled();
  });
});
