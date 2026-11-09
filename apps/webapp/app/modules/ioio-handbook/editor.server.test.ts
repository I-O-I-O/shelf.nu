import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRead: vi.fn(),
  findArticle: vi.fn(),
  createCategory: vi.fn(),
  publishArticle: vi.fn(),
  saveDraft: vi.fn(),
  submitDraftForReview: vi.fn(),
  createAttachmentSource: vi.fn(),
  removeUnattachedAttachmentSources: vi.fn(),
  setDraftAttachments: vi.fn(),
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
  createHandbookAttachmentSource: mocks.createAttachmentSource,
  publishHandbookArticle: mocks.publishArticle,
  removeUnattachedHandbookAttachmentSources:
    mocks.removeUnattachedAttachmentSources,
  saveHandbookDraft: mocks.saveDraft,
  setHandbookDraftAttachments: mocks.setDraftAttachments,
  submitHandbookDraftForReview: mocks.submitDraftForReview,
}));

import { handbookEditorAction } from "./editor.server";

function actionArgs({
  role = "student",
  slug,
  intent = "save-draft",
  categoryId = "category-1",
  proposedCategoryName = "",
  content = "This is a draft editing test.",
  revisionMode = false,
  revisionBaseVersionId = "",
  visibility,
}: {
  role?: "student" | "staff";
  slug?: string;
  intent?: string;
  categoryId?: string;
  proposedCategoryName?: string;
  content?: string;
  revisionMode?: boolean;
  revisionBaseVersionId?: string;
  visibility?: "everyone" | "staff-only";
} = {}) {
  const userId = role === "staff" ? "staff-1" : "student-1";
  const form = new FormData();
  form.set("intent", intent);
  form.set("title", "Test Handbook Draft Updated");
  form.set("handbookCategoryId", categoryId);
  form.set("proposedCategoryName", proposedCategoryName);
  form.set("categoryName", "Workshop Safety");
  form.set("content", content);
  form.set("sourceUrls", "https://example.com");
  if (visibility) form.set("visibility", visibility);
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
    mocks.createAttachmentSource.mockResolvedValue("attachment-1");
    mocks.setDraftAttachments.mockResolvedValue(undefined);
  });

  it("saves long article content beyond the former 30,000-character limit", async () => {
    const content = `## Long article\n\n${"x".repeat(30_001)}`;
    await handbookEditorAction(actionArgs({ content }) as never);

    const submittedContent = `## Long article\r\n\r\n${"x".repeat(30_001)}`;
    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ content: submittedContent })
    );
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

  it("ignores a forged staff-only visibility from a Student editor post", async () => {
    const args = actionArgs({ visibility: "staff-only" });

    await handbookEditorAction(args as never);

    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.not.objectContaining({ staffOnly: true })
    );
  });

  it("saves the selected staff-only visibility for authorized Staff", async () => {
    const args = actionArgs({ role: "staff", visibility: "staff-only" });

    await handbookEditorAction(args as never);

    expect(mocks.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ staffOnly: true })
    );
  });

  it("stores supported attachments on a Student's Handbook draft before review", async () => {
    const args = actionArgs({ intent: "submit-for-review" });
    const form = await args.request.formData();
    form.append(
      "attachments",
      new File(["void setup() {}"], "test-sketch.ino", { type: "text/plain" })
    );
    form.append(
      "attachments",
      new File(["Wiring notes"], "notes.txt", { type: "text/plain" })
    );
    mocks.createAttachmentSource
      .mockResolvedValueOnce("attachment-1")
      .mockResolvedValueOnce("attachment-2");

    const result = await handbookEditorAction({
      ...args,
      request: new Request(args.request.url, { method: "POST", body: form }),
    } as never);

    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/my-work?submitted=1"
    );
    expect(mocks.createAttachmentSource).toHaveBeenCalledTimes(2);
    expect(mocks.setDraftAttachments).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "student-1",
      articleId: "article-1",
      sourceIds: ["attachment-1", "attachment-2"],
      newlyUploadedSourceIds: ["attachment-1", "attachment-2"],
    });
    expect(mocks.submitDraftForReview).toHaveBeenCalled();
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
        staffOnly: false,
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

  it("does not allow a Student to submit an improvement for a staff-only article", async () => {
    mocks.findArticle.mockResolvedValue(null);
    const args = actionArgs({
      slug: "printer-maintenance",
      intent: "submit-for-review",
      revisionMode: true,
      revisionBaseVersionId: "version-2",
    });

    const result = await handbookEditorAction({
      ...args,
      slug: "printer-maintenance",
    } as never);

    expect(result).toMatchObject({ init: { status: 404 } });
    expect(mocks.findArticle).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ staffOnly: false }),
      })
    );
    expect(mocks.saveDraft).not.toHaveBeenCalled();
  });
});
