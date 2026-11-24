import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  permission: vi.fn(),
  asset: vi.fn(),
  model: vi.fn(),
  uploadAsset: vi.fn(),
  uploadModel: vi.fn(),
}));
// why: route-boundary tests isolate session/permission and database/storage services;
// their upload processing and replacement behavior have separate service tests.
vi.mock("~/database/db.server", () => ({
  db: {
    asset: { findFirst: mocks.asset },
    assetModel: { findFirst: mocks.model },
  },
}));
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.access,
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.permission,
}));
vi.mock("~/modules/asset/service.server", () => ({
  updateAssetMainImage: mocks.uploadAsset,
}));
vi.mock("~/modules/asset-model/service.server", () => ({
  updateAssetModelImage: mocks.uploadModel,
}));

import { action } from "~/routes/api+/inventory-image-upload";

function upload(kind = "asset") {
  const body = new FormData();
  body.append(
    kind === "asset" ? "mainImage" : "image",
    new File(["image"], "clipboard.png", { type: "image/png" })
  );
  return action(
    createActionArgs({
      request: new Request(
        `http://localhost/api/inventory-image-upload?kind=${kind}&id=one`,
        { method: "POST", body }
      ),
    })
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({
    userId: "staff-1",
    organizationId: "org-1",
  });
  mocks.permission.mockResolvedValue({ organizationId: "org-1" });
  mocks.asset.mockResolvedValue({ id: "one" });
  mocks.model.mockResolvedValue({ id: "one" });
  mocks.uploadAsset.mockResolvedValue(true);
  mocks.uploadModel.mockResolvedValue("https://storage.example/model.webp");
});

describe("staff clipboard image upload", () => {
  it.each(["asset", "model"])(
    "uses the canonical %s upload with an organization-scoped target",
    async (kind) => {
      expect(await upload(kind)).toMatchObject({ data: { success: true } });
      const find = kind === "asset" ? mocks.asset : mocks.model;
      expect(find).toHaveBeenCalledWith({
        where: { id: "one", organizationId: "org-1" },
        select: { id: true },
      });
      const write = kind === "asset" ? mocks.uploadAsset : mocks.uploadModel;
      const args = write.mock.calls[0][0];
      expect(args.organizationId).toBe("org-1");
      const body = await args.request.formData();
      expect(body.get(kind === "asset" ? "mainImage" : "image")).toBeInstanceOf(
        File
      );
    }
  );

  it("does not upload to another organization's target", async () => {
    mocks.asset.mockResolvedValue(null);
    expect(await upload()).toMatchObject({ init: { status: 404 } });
    expect(mocks.uploadAsset).not.toHaveBeenCalled();
  });

  it("requires staff access before resolving or writing a target", async () => {
    mocks.access.mockRejectedValue(new Error("Staff access required"));
    await upload();
    expect(mocks.asset).not.toHaveBeenCalled();
    expect(mocks.uploadAsset).not.toHaveBeenCalled();
  });

  it("requires update permission", async () => {
    mocks.permission.mockRejectedValue(new Error("Not permitted"));
    await upload("model");
    expect(mocks.model).not.toHaveBeenCalled();
    expect(mocks.uploadModel).not.toHaveBeenCalled();
  });

  it("reports upload failure rather than success", async () => {
    mocks.uploadAsset.mockRejectedValue(new Error("Storage unavailable"));
    expect(await upload()).toMatchObject({
      data: { error: expect.any(String) },
      init: { status: 500 },
    });
  });
});
