import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireStaffAccess: vi.fn(),
  getEditData: vi.fn(),
}));

// why: the route loader test isolates the zero-category response from the
// external Shelf session and Prisma connections.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireStaffAccess,
}));
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  getHandbookEditData: mocks.getEditData,
}));

import { loader } from "~/routes/_layout+/handbook.new";

const context = { getSession: () => ({ userId: "staff-1" }) } as never;

describe("new Handbook article route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStaffAccess.mockResolvedValue({
      userId: "staff-1",
      organizationId: "org-1",
      currentOrganization: { type: "TEAM" },
    });
    mocks.getEditData.mockResolvedValue({ article: null, categories: [] });
  });

  it("loads directly with an empty Handbook category list", async () => {
    const result = await loader(
      createLoaderArgs({
        context,
        request: new Request("http://localhost:3000/handbook/new"),
      })
    );

    expect(result).toMatchObject({ article: null, categories: [] });
    expect(mocks.getEditData).toHaveBeenCalledWith({
      organizationId: "org-1",
    });
  });
});
