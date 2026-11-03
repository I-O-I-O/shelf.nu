import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireStudentRead: vi.fn(),
  getOptions: vi.fn(),
  submitObservation: vi.fn(),
}));

// why: route tests verify category form data reaches the contribution service
// without requiring a live Shelf session or database connection.
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireStudentRead: mocks.requireStudentRead,
}));
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  HandbookValidationError: class HandbookValidationError extends Error {},
  getHandbookContributionOptions: mocks.getOptions,
  submitHandbookObservation: mocks.submitObservation,
}));

import { action, loader } from "~/routes/_layout+/handbook.contribute";

const context = { getSession: () => ({ userId: "student-1" }) } as never;

describe("Handbook contribution category flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "org-1",
      isStudent: true,
    });
    mocks.getOptions.mockResolvedValue({
      articles: [],
      assetModels: [],
      kits: [],
      categories: [],
    });
    mocks.submitObservation.mockResolvedValue({
      id: "observation-1",
      title: "Safety note",
      duplicate: false,
      related: [],
    });
  });

  it("loads the contribution form when there are no Handbook categories", async () => {
    const result = await loader(
      createLoaderArgs({
        context,
        request: new Request("http://localhost/handbook/contribute"),
      })
    );

    expect(result).toMatchObject({ categories: [] });
    expect(mocks.getOptions).toHaveBeenCalledWith("org-1");
  });

  it("submits a proposed category with the pending student contribution", async () => {
    const form = new FormData();
    form.set("title", "Soldering safety note");
    form.set("content", "Wear eye protection while soldering.");
    form.set("proposedCategoryName", "Workshop Safety");

    const result = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/handbook/contribute", {
          method: "POST",
          body: form,
        }),
      })
    );

    expect(result).toMatchObject({ success: true });
    expect(mocks.submitObservation).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "student-1",
      title: "Soldering safety note",
      content: "Wear eye protection while soldering.",
      articleId: undefined,
      handbookCategoryId: undefined,
      proposedCategoryName: "Workshop Safety",
      assetModelId: undefined,
      kitId: undefined,
    });
  });

  it("requires the contribution form to choose or propose a category", async () => {
    const form = new FormData();
    form.set("title", "Soldering note");
    form.set("content", "Wear eye protection while soldering.");

    const result = await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/handbook/contribute", {
          method: "POST",
          body: form,
        }),
      })
    );

    expect(result).toMatchObject({
      success: false,
      message: "Choose a Handbook category or propose a new one.",
    });
    expect(mocks.submitObservation).not.toHaveBeenCalled();
  });
});
