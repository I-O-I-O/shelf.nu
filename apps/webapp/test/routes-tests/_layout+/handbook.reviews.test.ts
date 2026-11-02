import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  getHandbookReviewQueue: vi.fn(),
  listArchivedHandbookArticles: vi.fn(),
  restoreHandbookArticle: vi.fn(),
}));

// why: give the route a staff authorization result without opening a Shelf session.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
// why: verify route data wiring without requiring a local database.
vi.mock("~/modules/ioio-handbook/workflow.server", () => ({
  HandbookWorkflowError: class HandbookWorkflowError extends Error {},
  getHandbookReviewQueue: mocks.getHandbookReviewQueue,
  listArchivedHandbookArticles: mocks.listArchivedHandbookArticles,
  restoreHandbookArticle: mocks.restoreHandbookArticle,
}));
// why: fail if the staff review loader imports Claude infrastructure.
vi.mock("~/modules/ioio-handbook/handbook-review.server", () => {
  throw new Error("Claude helper unavailable");
});

import { loader } from "~/routes/_layout+/handbook.reviews";

describe("Handbook staff review queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
      currentOrganization: { type: "TEAM" },
    });
    mocks.getHandbookReviewQueue.mockResolvedValue([]);
    mocks.listArchivedHandbookArticles.mockResolvedValue([]);
  });

  it("loads the empty staff queue while Claude is unavailable", async () => {
    const result = await loader({
      context: { getSession: () => ({ userId: "staff-1" }) },
      request: new Request("https://app.shelf.nu/handbook/reviews"),
      params: {},
    } as never);

    expect(result).toMatchObject({ queue: [], archived: [] });
    expect(mocks.getHandbookReviewQueue).toHaveBeenCalledWith("org-1");
    expect(mocks.listArchivedHandbookArticles).toHaveBeenCalledWith("org-1");
  });
});
