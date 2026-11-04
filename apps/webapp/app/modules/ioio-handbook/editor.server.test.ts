import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRead: vi.fn(),
  findArticle: vi.fn(),
  createCategory: vi.fn(),
  publishArticle: vi.fn(),
  saveDraft: vi.fn(),
  submitDraftForReview: vi.fn(),
}));

// why: the action tests isolate role and draft ownership decisions from Shelf
// sessions and Prisma while exercising the real form-intent handling.
vi.mock("~/database/db.server", () => ({
  db: { handbookArticle: { findFirst: mocks.findArticle } },
}));
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireRead,
}));
vi.mock("./service.server", () => ({
  HandbookValidationError: class HandbookValidationError extends Error {},
  createHandbookCategory: mocks.createCategory,
  publishHandbookArticle: mocks.publishArticle,
  saveHandbookDraft: mocks.saveDraft,
  submitHandbookDraftForReview: mocks.submitDraftForReview,
}));

import { handbookEditorAction } from "./editor.server";

function actionArgs({
  role = "student",
  slug,
  intent = "save-draft",
  categoryId = "category-1",
  proposedCategoryName = "",
  revisionMode = false,
  revisionBaseVersionId = "",
}: {
  role?: "student" | "staff";
  slug?: string;
  intent?: string;
  categoryId?: string;
  proposedCategoryName?: string;
  revisionMode?: boolean;
  revisionBaseVersionId?: string;
} = {}) {
  const userId = role === "staff" ? "staff-1" : "student-1";
  const form = new FormData();
  form.set("intent", intent);
  form.set("title", "Test Handbook Draft Updated");
  form.set("handbookCategoryId", categoryId);
  form.set("proposedCategoryName", proposedCategoryName);
  form.set("categoryName", "Workshop Safety");
  form.set("content", "This is a draft editing test.");
  form.set("sourceUrls", "https://example.com");
  if (revisionMode) {
    form.set("revisionMode", "1");
    form.set("revisionBaseVersionId", revisionBaseVersionId);
  }
  return {
    context: { getSession: () => ({ userId }) },
    request: new Request("http://localhost/handbook/test/edit", {
      method: "POST",
      body: form,
    }),
    params: slug ? { slug } : {},
    slug,
  };
}

describe("Handbook editor action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRead.mockImplementation(
      ({ context }: { context: { getSession: () => { userId: string } } }) => {
        const userId = context.getSession().userId;
        const isStudent = userId === "student-1";
        return {
          userId,
          organizationId: "org-1",
          currentOrganization: { type: "TEAM" },
          canEdit: !isStudent,
          isStudent,
        };
      }
    );
    mocks.findArticle.mockResolvedValue({
      id: "article-1",
      status: "DRAFT",
    });
    mocks.saveDraft.mockResolvedValue({
      id: "article-1",
      slug: "test-handbook-draft",
      status: "DRAFT",
    });
    mocks.publishArticle.mockResolvedValue({
      slug: "test-handbook-draft",
    });
    mocks.submitDraftForReview.mockResolvedValue({
      id: "observation-1",
      alreadyPending: false,
    });
  });

  it("updates the same owned article and preserves its references when saving", async () => {
    const args = actionArgs({ slug: "test-handbook-draft" });

    const result = await handbookEditorAction({
      ...args,
      slug: "test-handbook-draft",
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/test-handbook-draft/edit?saved=1"
    );
    expect(mocks.saveDraft).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "student-1",
      articleId: "article-1",
      ownerUserId: "student-1",
      title: "Test Handbook Draft Updated",
      handbookCategoryId: "category-1",
      content: "This is a draft editing test.",
      sourceUrls: ["https://example.com"],
    });
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });

  it("blocks Student publishing before saving or publishing", async () => {
    const args = actionArgs({ intent: "publish" });

    const result = await handbookEditorAction(args as never);

    expect(result).toMatchObject({ init: { status: 403 } });
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });

  it("lets Staff create a canonical category from the editor", async () => {
    mocks.createCategory.mockResolvedValue({
      id: "category-2",
      name: "Workshop Safety",
      alreadyExists: false,
    });
    const args = actionArgs({ role: "staff", intent: "create-category" });

    const result = await handbookEditorAction(args as never);

    expect(result).toMatchObject({
      data: {
        ok: true,
        category: { id: "category-2", name: "Workshop Safety" },
      },
    });
    expect(mocks.createCategory).toHaveBeenCalledWith({
      organizationId: "org-1",
      name: "Workshop Safety",
    });
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });

  it("does not let Students create a canonical category", async () => {
    const args = actionArgs({ intent: "create-category" });

    const result = await handbookEditorAction(args as never);

    expect(result).toMatchObject({ init: { status: 403 } });
    expect(mocks.createCategory).not.toHaveBeenCalled();
  });

  it("submits a Student draft for review without publishing", async () => {
    const args = actionArgs({ intent: "submit-for-review" });
    mocks.findArticle.mockResolvedValue(null);

    const result = await handbookEditorAction(args as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/my-work?submitted=1"
    );
    expect(mocks.submitDraftForReview).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "student-1",
      articleId: "article-1",
    });
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });

  it("submits a Student draft with a proposed category and no canonical category id", async () => {
    const args = actionArgs({
      intent: "submit-for-review",
      categoryId: "",
      proposedCategoryName: "Workshop Safety",
    });

    const result = await handbookEditorAction(args as never);

    expect(result).toBeInstanceOf(Response);
    expect(mocks.saveDraft).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "student-1",
      articleId: undefined,
      ownerUserId: "student-1",
      title: "Test Handbook Draft Updated",
      handbookCategoryId: undefined,
      content: "This is a draft editing test.",
      sourceUrls: ["https://example.com"],
    });
    expect(mocks.submitDraftForReview).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "student-1",
      articleId: "article-1",
      proposedCategoryName: "Workshop Safety",
    });
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });

  it("does not save a proposed Student category before review submission", async () => {
    const args = actionArgs({
      intent: "save-draft",
      categoryId: "",
      proposedCategoryName: "Workshop Safety",
    });

    const result = await handbookEditorAction(args as never);

    expect(result).toMatchObject({ init: { status: 400 } });
    expect(mocks.saveDraft).not.toHaveBeenCalled();
    expect(mocks.submitDraftForReview).not.toHaveBeenCalled();
  });

  it("does not update a draft that is not found within the Student's scope", async () => {
    const args = actionArgs({ slug: "someone-elses-draft" });
    mocks.findArticle.mockResolvedValue(null);

    const result = await handbookEditorAction({
      ...args,
      slug: "someone-elses-draft",
    } as never);

    expect(result).toMatchObject({ init: { status: 404 } });
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });

  it("lets Staff publish through the existing Handbook publication service", async () => {
    const args = actionArgs({
      role: "staff",
      slug: "test-handbook-draft",
      intent: "publish",
    });

    const result = await handbookEditorAction({
      ...args,
      slug: "test-handbook-draft",
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/test-handbook-draft"
    );
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "staff-1",
        articleId: "article-1",
        ownerUserId: undefined,
      })
    );
    expect(mocks.publishArticle).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "staff-1",
      articleId: "article-1",
    });
  });

  it("submits a Student improvement for review against the current version", async () => {
    mocks.findArticle.mockResolvedValue({
      id: "article-1",
      status: "PUBLISHED",
    });
    mocks.saveDraft.mockResolvedValue({
      id: "article-1",
      slug: "test-handbook-draft",
      status: "PUBLISHED",
    });
    const args = actionArgs({
      slug: "test-handbook-draft",
      intent: "submit-for-review",
      revisionMode: true,
      revisionBaseVersionId: "version-2",
    });

    const result = await handbookEditorAction({
      ...args,
      slug: "test-handbook-draft",
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/my-work?submitted=1"
    );
    expect(mocks.findArticle).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        slug: "test-handbook-draft",
        status: "PUBLISHED",
        publishedVersionId: "version-2",
      },
      select: { id: true, status: true },
    });
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: "article-1",
        revisionMode: true,
        revisionBaseVersionId: "version-2",
        revisionOwnerUserId: "student-1",
      })
    );
    expect(mocks.submitDraftForReview).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "student-1",
      articleId: "article-1",
      handbookCategoryId: "category-1",
      revisionMode: true,
      revisionBaseVersionId: "version-2",
    });
    expect(mocks.publishArticle).not.toHaveBeenCalled();
  });

  it("lets Staff publish an improved article as its next version", async () => {
    mocks.findArticle.mockResolvedValue({
      id: "article-1",
      status: "PUBLISHED",
    });
    mocks.saveDraft.mockResolvedValue({
      id: "article-1",
      slug: "test-handbook-draft",
      status: "PUBLISHED",
    });
    const args = actionArgs({
      role: "staff",
      slug: "test-handbook-draft",
      intent: "publish",
      revisionMode: true,
      revisionBaseVersionId: "version-2",
    });

    const result = await handbookEditorAction({
      ...args,
      slug: "test-handbook-draft",
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect(mocks.publishArticle).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "staff-1",
      articleId: "article-1",
      handbookCategoryId: "category-1",
    });
  });
});
