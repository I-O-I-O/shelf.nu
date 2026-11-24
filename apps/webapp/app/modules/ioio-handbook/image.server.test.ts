import { describe, expect, it, vi } from "vitest";

const { upload, from } = vi.hoisted(() => ({
  upload: vi.fn().mockResolvedValue({ error: null }),
  from: vi.fn(() => ({ upload })),
}));

// why: Supabase Storage is external; verify bucket/path selection without a
// network call or live storage credentials.
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: () => ({ storage: { from } }),
}));

import {
  detectHandbookImageFormat,
  HANDBOOK_PRIVATE_IMAGE_PREFIX,
  HANDBOOK_IMAGE_MAX_BYTES,
  isHandbookImagePathForOrganization,
  uploadHandbookArticleImage,
} from "./image.server";

describe("Handbook inline images", () => {
  it("accepts only PNG, JPEG, and WebP signatures", () => {
    expect(
      detectHandbookImageFormat(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      )?.contentType
    ).toBe("image/png");
    expect(
      detectHandbookImageFormat(Buffer.from([0xff, 0xd8, 0xff]))?.contentType
    ).toBe("image/jpeg");
    expect(
      detectHandbookImageFormat(Buffer.from("RIFF1234WEBP", "ascii"))
        ?.contentType
    ).toBe("image/webp");
    expect(detectHandbookImageFormat(Buffer.from("<svg/>"))).toBeNull();
    expect(HANDBOOK_IMAGE_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it("restricts image references to the signed-in organization", () => {
    const organizationId = "org-123";
    expect(
      isHandbookImagePathForOrganization(
        "handbook/org-123/123e4567-e89b-12d3-a456-426614174000.png",
        organizationId
      )
    ).toBe(true);
    expect(
      isHandbookImagePathForOrganization(
        `${HANDBOOK_PRIVATE_IMAGE_PREFIX}/org-123/123e4567-e89b-12d3-a456-426614174000.png`,
        organizationId
      )
    ).toBe(true);
    expect(
      isHandbookImagePathForOrganization(
        "handbook/other-org/123e4567-e89b-12d3-a456-426614174000.png",
        organizationId
      )
    ).toBe(false);
    expect(
      isHandbookImagePathForOrganization(
        "handbook/org-123/../../other/file.png",
        organizationId
      )
    ).toBe(false);
  });

  it("stores new inline images in the private assets bucket", async () => {
    const image = await uploadHandbookArticleImage({
      organizationId: "org-123",
      bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      contentType: "image/png",
    });

    expect(from).toHaveBeenCalledWith("assets");
    expect(upload).toHaveBeenCalledWith(
      image.path,
      expect.any(Buffer),
      expect.objectContaining({ upsert: false })
    );
    expect(image.path).toMatch(
      new RegExp(
        `^${HANDBOOK_PRIVATE_IMAGE_PREFIX}/org-123/[0-9a-f-]{36}\\.png$`
      )
    );
  });
});
