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

import { setIoioAssetHidden, setIoioAssetsHidden } from "./visibility.server";

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
      ioioHidden: false,
    });
    mocks.assetModelFindFirst.mockResolvedValue(null);
  });

  it("hides a grouped product through its organization-scoped AssetModel", async () => {
    mocks.assetFindFirst.mockResolvedValue({
      id: "unit-001",
      assetModelId: "makey-model",
      ioioHidden: false,
    });
    mocks.assetModelFindFirst.mockResolvedValue({
      id: "makey-model",
      ioioHidden: false,
    });

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
      select: { id: true, ioioHidden: true },
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
      ioioHidden: false,
    });
    mocks.assetModelFindFirst.mockResolvedValue({
      id: "makey-model",
      ioioHidden: true,
    });

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
      ioioHidden: false,
    });

    await setIoioAssetHidden({
      assetId: "unit-001",
      organizationId: "org-1",
      hidden: true,
    });

    expect(mocks.assetUpdateMany).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        assetModelId: "legacy-model",
        ioioHidden: { not: true },
      },
      data: { ioioHidden: true },
    });
    expect(mocks.assetModelUpdate).not.toHaveBeenCalled();
  });

  it("does not rewrite an item that already has the requested visibility", async () => {
    mocks.assetFindFirst.mockResolvedValue({
      id: "asset-1",
      assetModelId: null,
      ioioHidden: true,
    });

    await setIoioAssetHidden({
      assetId: "asset-1",
      organizationId: "org-1",
      hidden: true,
    });

    expect(mocks.assetUpdate).not.toHaveBeenCalled();
  });

  it("updates a shared model once for multiple selected physical units", async () => {
    let modelHidden = false;
    mocks.assetFindFirst.mockImplementation(({ where }) =>
      Promise.resolve({
        id: where.id,
        assetModelId: "makey-model",
        ioioHidden: false,
      })
    );
    mocks.assetModelFindFirst.mockImplementation(() =>
      Promise.resolve({ id: "makey-model", ioioHidden: modelHidden })
    );
    mocks.assetModelUpdate.mockImplementation(({ data }) => {
      modelHidden = data.ioioHidden;
      return Promise.resolve({ id: "makey-model", ioioHidden: modelHidden });
    });

    await setIoioAssetsHidden({
      assetIds: ["unit-001", "unit-002", "unit-001"],
      organizationId: "org-1",
      hidden: true,
    });

    expect(mocks.assetFindFirst).toHaveBeenCalledTimes(2);
    expect(mocks.assetModelUpdate).toHaveBeenCalledTimes(1);
  });
});
