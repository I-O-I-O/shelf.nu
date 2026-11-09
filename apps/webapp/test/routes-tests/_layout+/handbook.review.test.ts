import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";
import { ShelfError } from "~/utils/error";

const mocks = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  listObservations: vi.fn(),
  listCategories: vi.fn(),
  approveNew: vi.fn(),
  approveRevision: vi.fn(),
  resolveSubmission: vi.fn(),
  rejectRevision: vi.fn(),
  resolveCategory: vi.fn(),
  HandbookValidationError: class HandbookValidationError extends Error {},
}));

// why: review route tests exercise the staff gate and action routing without a live Shelf session or database.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireStaff,
}));
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  HandbookValidationError: mocks.HandbookValidationError,
  approveHandbookNewArticleSubmission: mocks.approveNew,
  approveHandbookArticleRevision: mocks.approveRevision,
  listHandbookCategories: mocks.listCategories,
  listHandbookObservations: mocks.listObservations,
  rejectHandbookArticleRevision: mocks.rejectRevision,
  resolveHandbookArticleSubmission: mocks.resolveSubmission,
  resolveHandbookObservationCategoryProposal: mocks.resolveCategory,
}));

import { action, loader } from "~/routes/_layout+/handbook.review";

const context = { getSession: () => ({ userId: "staff-1" }) } as never;

describe("Handbook review route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStaff.mockResolvedValue({
      userId: "staff-1",
      organizationId: "team-1",
      currentOrganization: { type: "TEAM" },
    });
    mocks.listObservations.mockResolvedValue([{ id: "submission-1" }]);
    mocks.listCategories.mockResolvedValue([]);
    mocks.approveNew.mockResolvedValue({ versionNumber: 1 });
    mocks.approveRevision.mockResolvedValue({ versionNumber: 2 });
  });

  it("loads the existing pending Handbook contribution records behind the Staff gate", async () => {
    await expect(
      loader(
        createLoaderArgs({
          context,
          request: new Request("http://localhost/handbook/review"),
        })
      )
    ).resolves.toMatchObject({
      observations: [{ id: "submission-1" }],
      categories: [],
    });
    expect(mocks.requireStaff).toHaveBeenCalled();
    expect(mocks.listObservations).toHaveBeenCalledWith("team-1");
  });

  it("uses the existing student submission to approve and publish a new article", async () => {
    const result = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/handbook/review", {
          method: "POST",
          body: new URLSearchParams({
            observationId: "submission-1",
            intent: "approve-new",
          }),
        }),
      })
    );

    expect(result).toMatchObject({
      success: true,
      message: "Article approved and published as Version 1.",
    });
    expect(mocks.approveNew).toHaveBeenCalledWith({
      organizationId: "team-1",
      userId: "staff-1",
      observationId: "submission-1",
    });
    expect(mocks.approveRevision).not.toHaveBeenCalled();
  });

  it("returns a student's existing contribution record for changes", async () => {
    await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/handbook/review", {
          method: "POST",
          body: new URLSearchParams({
            observationId: "submission-1",
            intent: "return-for-changes",
          }),
        }),
      })
    );

    expect(mocks.resolveSubmission).toHaveBeenCalledWith({
      organizationId: "team-1",
      userId: "staff-1",
      observationId: "submission-1",
      resolution: "return-for-changes",
    });
  });

  it("rejects access when the existing Staff authorization gate denies the user", async () => {
    mocks.requireStaff.mockRejectedValue(
      new ShelfError({
        cause: null,
        message: "This IOIO staff feature is available to staff only.",
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      })
    );

    await expect(
      loader(
        createLoaderArgs({
          context,
          request: new Request("http://localhost/handbook/review"),
        })
      )
    ).rejects.toMatchObject({ init: { status: 403 } });
    expect(mocks.listObservations).not.toHaveBeenCalled();
  });
});
