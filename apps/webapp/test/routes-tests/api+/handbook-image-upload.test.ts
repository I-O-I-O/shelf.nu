// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireIoioHandbookRead: vi.fn(),
  imageCreate: vi.fn(),
}));

// why: grant an authenticated organization reader without setting up a Shelf session.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireIoioHandbookRead,
}));
// why: assert the exact validated bytes and organization ownership sent to Shelf storage.
vi.mock("~/database/db.server", () => ({
  db: { image: { create: mocks.imageCreate } },
}));

import { action } from "~/routes/api+/handbook-image-upload";

function buildArgs(file: File) {
  const form = new FormData();
  form.set("image", file);
  const request = new Request(
    "https://app.shelf.nu/api/handbook-image-upload",
    {
      method: "POST",
      body: form,
    }
  );
  const context = { getSession: () => ({ userId: "student-1" }) };
  return { request, context } as unknown as Parameters<typeof action>[0];
}

describe("Handbook image upload action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioHandbookRead.mockResolvedValue({
      organizationId: "org-1",
      userId: "student-1",
    });
    mocks.imageCreate.mockResolvedValue({ id: "image-1" });
  });

  it("stores an image up to 2 MB after checking its actual format", async () => {
    const file = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
      "diagram.png",
      { type: "image/png" }
    );

    await expect(action(buildArgs(file))).resolves.toMatchObject({
      success: true,
      src: "/api/image/image-1",
    });
    expect(mocks.imageCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        contentType: "image/png",
        ownerOrgId: "org-1",
        userId: "student-1",
      }),
      select: { id: true },
    });
  });

  it("rejects an image larger than 2 MB before storing it", async () => {
    const file = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    });

    await expect(action(buildArgs(file))).resolves.toMatchObject({
      data: {
        success: false,
        message: "Images must be 2 MB or smaller.",
      },
      init: { status: 400 },
    });
    expect(mocks.imageCreate).not.toHaveBeenCalled();
  });

  it("rejects file contents that do not match a supported raster format", async () => {
    const file = new File(["<svg></svg>"], "diagram.png", {
      type: "image/png",
    });

    await expect(action(buildArgs(file))).resolves.toMatchObject({
      data: {
        success: false,
        message: "Upload a PNG, JPEG, or WebP image.",
      },
      init: { status: 400 },
    });
    expect(mocks.imageCreate).not.toHaveBeenCalled();
  });
});
