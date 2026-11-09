import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, redirect, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireRead: vi.fn(),
  listDrafts: vi.fn(),
  deleteDraft: vi.fn(),
  discardRevision: vi.fn(),
  withdrawSubmission: vi.fn(),
  HandbookValidationError: class HandbookValidationError extends Error {},
}));

// why: the loader test verifies the current account and organization are used
// without requiring a live Shelf session or database connection.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireRead,
}));
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  HandbookValidationError: mocks.HandbookValidationError,
  discardHandbookArticleRevisionDraft: mocks.discardRevision,
  deleteHandbookDraft: mocks.deleteDraft,
  listMyHandbookDrafts: mocks.listDrafts,
  withdrawHandbookSubmission: mocks.withdrawSubmission,
}));

import HandbookMyWorkPage, {
  action,
  loader,
} from "~/routes/_layout+/handbook.my-work";

const mockContext = {
  getSession: () => ({ userId: "student-1" }),
} as never;

describe("Handbook My Work route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "org-1",
      isStudent: true,
      canEdit: false,
    });
    mocks.deleteDraft.mockResolvedValue({ id: "article-1" });
    mocks.discardRevision.mockResolvedValue({ id: "article-1" });
    mocks.listDrafts.mockResolvedValue([
      {
        id: "article-1",
        slug: "test-handbook-draft",
        draftTitle: "Test Handbook Draft",
        updatedAt: new Date("2026-11-04T00:00:00.000Z"),
        handbookCategory: { id: "category-1", name: "Workshop Safety" },
        submittedForReview: false,
        workType: "NEW_ARTICLE",
        baseVersionNumber: null,
      },
    ]);
  });

  it("loads only the authenticated user's drafts for direct navigation", async () => {
    const result = await loader(
      createLoaderArgs({
        context: mockContext,
        request: new Request("http://localhost/handbook/my-work"),
      })
    );

    expect(result).toMatchObject({
      drafts: [{ id: "article-1", slug: "test-handbook-draft" }],
      isStudent: true,
    });
    expect(mocks.listDrafts).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "student-1",
    });
  });

  it("shows the student contribution states and submission date", async () => {
    const submittedAt = "2026-11-09T00:00:00.000Z";
    const statuses = [
      ["Draft Article", "DRAFT"],
      ["Pending Article", "PENDING_REVIEW"],
      ["Returned Article", "RETURNED_FOR_CHANGES"],
      ["Approved Article", "APPROVED"],
      ["Rejected Article", "REJECTED"],
    ] as const;
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/my-work",
          Component: HandbookMyWorkPage,
          loader: () => ({
            isStudent: true,
            drafts: statuses.map(([draftTitle, contributionStatus]) => ({
              id: draftTitle,
              slug: "change-filament",
              draftTitle,
              updatedAt: submittedAt,
              submittedAt: contributionStatus === "DRAFT" ? null : submittedAt,
              handbookCategory: null,
              submittedForReview: contributionStatus === "PENDING_REVIEW",
              workType:
                contributionStatus === "APPROVED" ||
                contributionStatus === "REJECTED"
                  ? "OUTCOME"
                  : "NEW_ARTICLE",
              contributionStatus,
              baseVersionNumber: null,
            })),
          }),
        },
      ],
      { initialEntries: ["/handbook/my-work"] }
    );
    render(createElement(RouterProvider, { router }));

    const rows = await screen.findAllByRole("listitem");
    for (const status of [
      "Draft",
      "Pending review",
      "Returned for changes",
      "Approved",
      "Rejected",
    ]) {
      expect(rows.some((row) => row.textContent?.includes(`${status} ·`))).toBe(
        true
      );
    }
    expect(screen.getAllByText(/Submitted/)).toHaveLength(4);
    expect(
      screen.queryByRole("link", { name: "Review contributions" })
    ).toBeNull();
  });

  it("deletes the requested draft and returns to My Work", async () => {
    const response = (await action(
      createActionArgs({
        context: mockContext,
        request: new Request("http://localhost/handbook/my-work", {
          method: "POST",
          body: new URLSearchParams({
            intent: "delete-draft",
            articleId: "article-1",
          }),
        }),
      })
    )) as Response;

    expect(mocks.deleteDraft).toHaveBeenCalledWith({
      organizationId: "org-1",
      articleId: "article-1",
      userId: "student-1",
      canManageAnyDraft: false,
    });
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location")).toBe(
      "/handbook/my-work?deleted=1"
    );
  });

  it("discards a saved revision draft without deleting the published article", async () => {
    const result = await action(
      createActionArgs({
        context: mockContext,
        request: new Request("http://localhost/handbook/my-work", {
          method: "POST",
          body: new URLSearchParams({
            intent: "discard-revision",
            articleId: "article-1",
          }),
        }),
      })
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/my-work?discarded=1"
    );
    expect(mocks.discardRevision).toHaveBeenCalledWith({
      organizationId: "org-1",
      articleId: "article-1",
      userId: "student-1",
      canManageAnyDraft: false,
    });
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
  });

  it("withdraws only the authenticated contributor's submission", async () => {
    mocks.withdrawSubmission.mockResolvedValue({ id: "submission-1" });
    const result = await action(
      createActionArgs({
        context: mockContext,
        request: new Request("http://localhost/handbook/my-work", {
          method: "POST",
          body: new URLSearchParams({
            intent: "withdraw-submission",
            observationId: "submission-1",
          }),
        }),
      })
    );
    expect(mocks.withdrawSubmission).toHaveBeenCalledWith({
      organizationId: "org-1",
      observationId: "submission-1",
      userId: "student-1",
      canManageAnySubmission: false,
    });
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/my-work?withdrawn=1"
    );
    expect(mocks.deleteDraft).not.toHaveBeenCalled();
  });

  it("forwards the existing Staff draft-management permission to the service", async () => {
    mocks.requireRead.mockResolvedValue({
      userId: "staff-1",
      organizationId: "org-1",
      isStudent: false,
      canEdit: true,
    });

    await action(
      createActionArgs({
        context: mockContext,
        request: new Request("http://localhost/handbook/my-work", {
          method: "POST",
          body: new URLSearchParams({
            intent: "delete-draft",
            articleId: "article-2",
          }),
        }),
      })
    );

    expect(mocks.deleteDraft).toHaveBeenCalledWith({
      organizationId: "org-1",
      articleId: "article-2",
      userId: "staff-1",
      canManageAnyDraft: true,
    });
  });

  it("returns a normal action error when a submitted draft is not deletable", async () => {
    mocks.deleteDraft.mockRejectedValue(
      new mocks.HandbookValidationError(
        "This draft has been submitted for Staff review and cannot be deleted."
      )
    );

    const result = (await action(
      createActionArgs({
        context: mockContext,
        request: new Request("http://localhost/handbook/my-work", {
          method: "POST",
          body: new URLSearchParams({
            intent: "delete-draft",
            articleId: "article-1",
          }),
        }),
      })
    )) as any;

    expect(result.init.status).toBe(400);
    expect(result.data.message).toMatch(/submitted for Staff review/);
  });

  it("asks for confirmation before deleting a draft", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/my-work",
          Component: HandbookMyWorkPage,
          loader: () => ({
            drafts: [
              {
                id: "article-1",
                slug: "test-handbook-draft",
                draftTitle: "Test Handbook Draft",
                updatedAt: new Date("2026-11-04T00:00:00.000Z"),
                handbookCategory: null,
                submittedForReview: false,
                workType: "NEW_ARTICLE",
                baseVersionNumber: null,
              },
            ],
            isStudent: true,
          }),
        },
      ],
      { initialEntries: ["/handbook/my-work"] }
    );
    render(createElement(RouterProvider, { router }));

    await user.click(
      await screen.findByRole("button", { name: "Delete draft" })
    );

    expect(
      screen.getByRole("heading", { name: "Delete this draft?" })
    ).toBeTruthy();
    expect(
      screen.getByText("This will permanently remove the unpublished draft.")
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Delete draft" })
    ).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("heading", { name: "Delete this draft?" })
    ).toBeNull();
  });

  it("does not show delete for a draft already submitted for review", async () => {
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/my-work",
          Component: HandbookMyWorkPage,
          loader: () => ({
            drafts: [
              {
                id: "article-1",
                slug: "test-handbook-draft",
                draftTitle: "Test Handbook Draft",
                updatedAt: new Date("2026-11-04T00:00:00.000Z"),
                handbookCategory: null,
                submittedForReview: true,
                contributionStatus: "PENDING_REVIEW",
                submissionId: "submission-1",
                workType: "NEW_ARTICLE",
                baseVersionNumber: null,
              },
            ],
            isStudent: true,
          }),
        },
      ],
      { initialEntries: ["/handbook/my-work"] }
    );
    render(createElement(RouterProvider, { router }));

    expect(
      await screen.findByText(/Pending review · New article/)
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete draft" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Withdraw submission" })
    ).toBeTruthy();
  });

  it.each(["NEW_ARTICLE", "IMPROVEMENT_PENDING"])(
    "confirms withdrawal for %s and retains the draft",
    async (workType) => {
      const user = userEvent.setup();
      let pending = true;
      mocks.withdrawSubmission.mockImplementation(() => {
        pending = false;
        return Promise.resolve({ id: "submission-1" });
      });
      const router = createMemoryRouter(
        [
          {
            path: "/handbook/my-work",
            loader: () => ({
              isStudent: true,
              drafts: [
                {
                  id: "work-1",
                  articleId: "article-1",
                  submissionId: pending ? "submission-1" : null,
                  slug: "example",
                  draftTitle: "My proposal",
                  updatedAt: "2026-11-06T00:00:00Z",
                  handbookCategory: null,
                  submittedForReview: pending,
                  baseVersionNumber: workType === "NEW_ARTICLE" ? null : 1,
                  workType: pending
                    ? workType
                    : workType === "NEW_ARTICLE"
                    ? "NEW_ARTICLE"
                    : "IMPROVEMENT_DRAFT",
                },
              ],
            }),
            action: (routeArgs) =>
              action({ ...routeArgs, context: mockContext }),
            Component: HandbookMyWorkPage,
          },
        ],
        { initialEntries: ["/handbook/my-work"] }
      );
      render(createElement(RouterProvider, { router }));
      await user.click(
        await screen.findByRole("button", { name: "Withdraw submission" })
      );
      expect(screen.getByRole("alertdialog")).toHaveTextContent(
        "submission record will be retained"
      );
      expect(mocks.withdrawSubmission).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("button", { name: "Withdraw submission" })
      );
      expect(await screen.findByText(/Submission withdrawn/)).toBeTruthy();
      expect(screen.getByText("My proposal")).toBeTruthy();
      expect(mocks.deleteDraft).not.toHaveBeenCalled();
    }
  );

  it("removes a deleted draft from My Work and shows success feedback", async () => {
    const user = userEvent.setup();
    let deleted = false;
    const draft = {
      id: "article-1",
      slug: "test-handbook-draft",
      draftTitle: "Test Handbook Draft",
      updatedAt: new Date("2026-11-04T00:00:00.000Z"),
      handbookCategory: null,
      submittedForReview: false,
      workType: "NEW_ARTICLE",
      baseVersionNumber: null,
    };
    const router = createMemoryRouter(
      [
        {
          path: "/handbook/my-work",
          loader: () => ({
            drafts: deleted ? [] : [draft],
            isStudent: true,
          }),
          action: () => {
            deleted = true;
            return redirect("/handbook/my-work?deleted=1");
          },
          Component: HandbookMyWorkPage,
        },
      ],
      { initialEntries: ["/handbook/my-work"] }
    );
    render(createElement(RouterProvider, { router }));

    await user.click(
      await screen.findByRole("button", { name: "Delete draft" })
    );
    await user.click(screen.getByRole("button", { name: "Delete draft" }));

    expect(await screen.findByText("Draft deleted.")).toBeTruthy();
    expect(
      await screen.findByText("You have no Handbook drafts yet.")
    ).toBeTruthy();
    expect(screen.queryByText("Test Handbook Draft")).toBeNull();
    expect(router.state.location.search).toBe("?deleted=1");
  });
});
