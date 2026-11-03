import type { ActionFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireStaffAccess: vi.fn(),
  createCategory: vi.fn(),
  saveDraft: vi.fn(),
  publishArticle: vi.fn(),
  findArticle: vi.fn(),
}));

// why: the action test isolates submitted form data and redirects from Shelf's
// session/permission loader and database behavior, covered at their boundaries.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireStaffAccess,
}));
// why: service behavior is tested separately; this mock lets the test verify
// exactly which fields the normal create action passes into that service.
vi.mock("./service.server", () => ({
  HandbookValidationError: class HandbookValidationError extends Error {},
  createHandbookCategory: mocks.createCategory,
  saveHandbookDraft: mocks.saveDraft,
  publishHandbookArticle: mocks.publishArticle,
}));
// why: edit actions perform an organization-scoped existence check before
// saving; create actions do not need database access in this focused test.
vi.mock("~/database/db.server", () => ({
  db: { handbookArticle: { findFirst: mocks.findArticle } },
}));

import { handbookEditorAction } from "./editor.server";

function actionArgs(formData: FormData) {
  return {
    context: {} as ActionFunctionArgs["context"],
    request: new Request("http://localhost/handbook/new", {
      method: "POST",
      body: formData,
    }),
    params: {},
  } as ActionFunctionArgs;
}

describe("Handbook editor action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStaffAccess.mockResolvedValue({
      currentOrganization: { type: "TEAM" },
      organizationId: "org-1",
      userId: "staff-1",
    });
    mocks.saveDraft.mockResolvedValue({
      id: "article-1",
      slug: "soldering-basics",
      status: "DRAFT",
    });
    mocks.createCategory.mockResolvedValue({
      id: "handbook-category-1",
      name: "Workshop Safety",
    });
    mocks.publishArticle.mockResolvedValue({
      articleId: "article-1",
      slug: "soldering-basics",
      versionNumber: 1,
    });
  });

  it("saves a draft without summary, section, Shelf product, or kit fields", async () => {
    const formData = new FormData();
    formData.set("intent", "save-draft");
    formData.set("title", "Soldering Basics");
    formData.set("handbookCategoryId", "handbook-category-electronics");
    formData.set("content", "Basic soldering guide.");
    formData.set("sourceUrls", "https://example.com/reference");

    const response = await handbookEditorAction(actionArgs(formData));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "/handbook/soldering-basics/edit?saved=1"
    );
    expect(mocks.saveDraft).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "staff-1",
      articleId: undefined,
      title: "Soldering Basics",
      handbookCategoryId: "handbook-category-electronics",
      content: "Basic soldering guide.",
      sourceUrls: ["https://example.com/reference"],
    });
  });

  it("publishes through the same category and reference flow", async () => {
    const formData = new FormData();
    formData.set("intent", "publish");
    formData.set("title", "Soldering Basics");
    formData.set("handbookCategoryId", "handbook-category-electronics");
    formData.set("content", "Basic soldering guide.");
    formData.set("sourceUrls", "https://example.com/reference");

    const response = await handbookEditorAction(actionArgs(formData));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/handbook/soldering-basics");
    expect(mocks.publishArticle).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "staff-1",
      articleId: "article-1",
    });
  });

  it("creates a Handbook category inline and returns it to the picker", async () => {
    const formData = new FormData();
    formData.set("intent", "create-category");
    formData.set("categoryName", "Workshop Safety");

    const response = await handbookEditorAction(actionArgs(formData));

    expect(response).toMatchObject({
      data: {
        ok: true,
        category: { id: "handbook-category-1", name: "Workshop Safety" },
      },
    });
    expect(mocks.createCategory).toHaveBeenCalledWith({
      organizationId: "org-1",
      name: "Workshop Safety",
    });
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });
});
