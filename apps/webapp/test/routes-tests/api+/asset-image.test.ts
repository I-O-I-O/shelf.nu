import { beforeEach, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  asset: vi.fn(),
  archived: vi.fn(),
  download: vi.fn(),
}));
// why: isolate authentication/database/storage boundaries while exercising real path,
// version, response-byte validation, and authorization logic in the delivery route.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.permission,
}));
vi.mock("~/database/db.server", () => ({
  db: {
    asset: { findFirst: mocks.asset },
    ioioArchivedItem: { findFirst: mocks.archived },
  },
}));
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: () => ({
    storage: { from: () => ({ download: mocks.download }) },
  }),
}));
import { assetImageVersion } from "~/modules/asset/image-proxy.server";
import { loader } from "~/routes/api+/asset-image";

const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
function load(variant = "main", version?: string) {
  return loader(
    createLoaderArgs({
      context: { getSession: () => ({ userId: "viewer" }) },
      request: new Request(
        `https://shelf.example/api/asset-image?assetId=one&variant=${variant}${
          version ? `&v=${version}` : ""
        }`
      ),
    })
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.permission.mockResolvedValue({
    organizationId: "org-1",
    role: "ADMIN",
  });
  mocks.asset.mockResolvedValue({
    id: "one",
    ioioHidden: false,
    mainImageStoragePath: "user/one/photo.webp",
    thumbnailImageStoragePath: "user/one/thumb.webp",
    assetModel: {
      organizationId: "org-1",
      imageStoragePath: "org-1/models/model/cover.webp",
    },
  });
  mocks.archived.mockResolvedValue(null);
  mocks.download.mockResolvedValue({
    data: new Blob([bytes], { type: "text/html" }),
    error: null,
  });
});

it.each(["ADMIN", "SELF_SERVICE"])(
  "delivers actual image bytes for %s without redirects or storage URLs",
  async (role) => {
    mocks.permission.mockResolvedValue({ organizationId: "org-1", role });
    const response = await load();
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(mocks.asset).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "one", organizationId: "org-1" } })
    );
  }
);
it.each([
  ["main", "user/one/photo.webp"],
  ["thumbnail", "user/one/thumb.webp"],
  ["model", "org-1/models/model/cover.webp"],
])("downloads canonical %s object", async (variant, path) => {
  await load(variant, assetImageVersion(path));
  expect(mocks.download).toHaveBeenCalledWith(path);
});
it("rejects an obsolete replacement version", async () => {
  await expect(
    load("main", assetImageVersion("old.webp"))
  ).rejects.toMatchObject({ init: { status: 404 } });
  expect(mocks.download).not.toHaveBeenCalled();
});
it("rejects unauthenticated access before reading data", async () => {
  mocks.permission.mockRejectedValue(new Response(null, { status: 401 }));
  await expect(load()).rejects.toMatchObject({ status: 401 });
  expect(mocks.asset).not.toHaveBeenCalled();
});
it("does not reveal other organizations' assets or linked model images", async () => {
  mocks.asset.mockResolvedValueOnce(null);
  await expect(load()).rejects.toMatchObject({ init: { status: 404 } });
  const asset = await mocks.asset.mock.results[0].value;
  expect(asset).toBeNull();
  mocks.asset.mockResolvedValueOnce({
    id: "one",
    assetModel: { organizationId: "org-other", imageStoragePath: "secret" },
  });
  await expect(load("model")).rejects.toMatchObject({ init: { status: 404 } });
  expect(mocks.download).not.toHaveBeenCalled();
});
it.each(["hidden", "archived"])(
  "protects %s inventory from students",
  async (state) => {
    mocks.permission.mockResolvedValue({
      organizationId: "org-1",
      role: "SELF_SERVICE",
    });
    if (state === "hidden")
      mocks.asset.mockResolvedValueOnce({ id: "one", ioioHidden: true });
    else mocks.archived.mockResolvedValueOnce({ id: "archive" });
    await expect(load()).rejects.toMatchObject({ init: { status: 404 } });
    expect(mocks.download).not.toHaveBeenCalled();
  }
);
it("rejects HTML bytes even when storage claims image MIME", async () => {
  mocks.download.mockResolvedValueOnce({
    data: new Blob(["<html>login</html>"], { type: "image/png" }),
    error: null,
  });
  await expect(load()).rejects.toMatchObject({ init: { status: 502 } });
});
it("reports storage failure without a redirect or placeholder response", async () => {
  mocks.download.mockResolvedValueOnce({
    data: null,
    error: { name: "StorageApiError", statusCode: "503" },
  });
  await expect(load()).rejects.toMatchObject({ init: { status: 502 } });
});
it("returns 404 without contacting storage when no image exists", async () => {
  mocks.asset.mockResolvedValueOnce({ id: "one" });
  await expect(load()).rejects.toMatchObject({ init: { status: 404 } });
  expect(mocks.download).not.toHaveBeenCalled();
});
