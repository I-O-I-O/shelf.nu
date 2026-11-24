import sharp from "sharp";
import { beforeEach, expect, it, vi } from "vitest";
import {
  persistImportProductImage,
  readImportProductImage,
  pruneImportProductImages,
} from "./import-product-image.server";

const storage = vi.hoisted(() => ({
  upsert: vi.fn(),
  findFirst: vi.fn(),
  deleteMany: vi.fn(),
}));
// why: the existing Image table is external persistence; keep tests offline and
// exercise byte/reference round trips with the actual preview service.
vi.mock("~/database/db.server", () => ({ db: { image: storage } }));
const records = new Map<
  string,
  { id: string; ownerOrgId: string; blob: Buffer; contentType: string }
>();
beforeEach(() => {
  vi.clearAllMocks();
  records.clear();
  storage.upsert.mockImplementation(({ where, create }) => {
    if (!records.has(where.id)) records.set(where.id, create);
    return records.get(where.id);
  });
  storage.findFirst.mockImplementation(({ where }) =>
    records.get(where.id)?.ownerOrgId === where.ownerOrgId
      ? records.get(where.id)
      : null
  );
  storage.deleteMany.mockResolvedValue({ count: 0 });
});
it("stores a real processed preview once and reloads it from an org-owned reference", async () => {
  const bytes = await sharp({
    create: { width: 160, height: 120, channels: 3, background: "#abc" },
  })
    .webp()
    .toBuffer();
  const input = {
    image: {
      status: "IMAGE_FOUND" as const,
      mimeType: "image/webp" as const,
      dataBase64: bytes.toString("base64"),
      autoAccepted: true,
    },
    operationId: "operation-1",
    organizationId: "org-1",
    userId: "staff-1",
  };
  const first = await persistImportProductImage(input);
  const second = await persistImportProductImage(input);
  expect(first).toEqual(second);
  expect(records.size).toBe(1);
  expect(first.dataBase64).toBeUndefined();
  expect(await readImportProductImage(first.imageId!, "org-1")).toEqual(bytes);
  await expect(readImportProductImage(first.imageId!, "org-2")).rejects.toThrow(
    "unavailable"
  );
  await expect(
    readImportProductImage("../../other-file", "org-1")
  ).rejects.toThrow("Invalid");
});
it("rejects invalid or oversized preview bytes before persistence", async () => {
  for (const bytes of [
    Buffer.from("not an image"),
    Buffer.alloc(128 * 1024 + 1),
  ]) {
    await expect(
      persistImportProductImage({
        image: {
          status: "IMAGE_FOUND",
          mimeType: "image/webp",
          dataBase64: bytes.toString("base64"),
        },
        operationId: "op",
        organizationId: "org",
        userId: "staff",
      })
    ).rejects.toThrow("Invalid");
  }
  expect(storage.upsert).not.toHaveBeenCalled();
});
it("restricts expired preview cleanup to the current owner and temporary images", async () => {
  await pruneImportProductImages("org-1", "staff-1");
  expect(storage.deleteMany).toHaveBeenCalledWith({
    where: {
      ownerOrgId: "org-1",
      userId: "staff-1",
      altText: { startsWith: "ioio-import-preview:" },
      createdAt: { lt: expect.any(Date) },
      location: null,
      organization: null,
    },
  });
});

it("never persists a found status without usable bytes or an org-owned reference", async () => {
  await expect(
    persistImportProductImage({
      image: { status: "IMAGE_FOUND", mimeType: "image/webp" },
      operationId: "op",
      organizationId: "org",
      userId: "staff",
    })
  ).rejects.toThrow("no stored bytes");
  await expect(
    persistImportProductImage({
      image: {
        status: "IMAGE_FOUND",
        mimeType: "image/webp",
        imageId: `ioio-import-${"a".repeat(64)}`,
      },
      operationId: "op",
      organizationId: "org",
      userId: "staff",
    })
  ).rejects.toThrow("unavailable");
  expect(storage.upsert).not.toHaveBeenCalled();
});
