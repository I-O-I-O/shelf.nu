import { describe, expect, it } from "vitest";
import {
  detectHandbookImageFormat,
  HANDBOOK_IMAGE_MAX_BYTES,
  isHandbookImagePathForOrganization,
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
});
