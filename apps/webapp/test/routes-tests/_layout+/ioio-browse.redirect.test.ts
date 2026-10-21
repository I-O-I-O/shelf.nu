import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({ requireStudentRead: vi.fn() }));

// why: isolate the student permission boundary while testing the compatibility
// redirect and preserving nested detail-route access.
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireStudentRead: mocks.requireStudentRead,
}));

import { loader } from "~/routes/_layout+/ioio.browse";

describe("student Browse Inventory compatibility route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
  });

  it("redirects the old browse page to Home with its filters intact", async () => {
    const result = await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "student-1" }) } as never,
        request: new Request(
          "http://localhost/ioio/browse?q=Arduino&category=electronics&location=bay&availability=available"
        ),
      })
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe(
      "/ioio?q=Arduino&category=electronics&location=bay&availability=available"
    );
    expect(mocks.requireStudentRead).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing nested student asset detail route available", async () => {
    await expect(
      loader(
        createLoaderArgs({
          context: { getSession: () => ({ userId: "student-1" }) } as never,
          request: new Request("http://localhost/ioio/browse/asset-1"),
        })
      )
    ).resolves.toBeNull();
    expect(mocks.requireStudentRead).toHaveBeenCalledTimes(1);
  });
});
