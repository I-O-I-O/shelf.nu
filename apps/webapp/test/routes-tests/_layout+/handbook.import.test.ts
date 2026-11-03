import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRead: vi.fn(),
  listCategories: vi.fn(),
  importPdf: vi.fn(),
  submitObservation: vi.fn(),
  editorAction: vi.fn(),
}));

// why: this route test focuses on upload validation and permission-specific
// handoff; Shelf session resolution is covered by the access module tests.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireRead,
}));
// why: deterministic PDF page extraction is tested in the parser suite; the
// route should only pass verified PDF bytes into that shared boundary.
vi.mock("~/modules/ioio-handbook/pdf-import.server", () => ({
  HANDBOOK_PDF_MAX_BYTES: 5 * 1024 * 1024,
  HandbookPdfImportError: class HandbookPdfImportError extends Error {},
  importHandbookPdf: mocks.importPdf,
}));
// why: database writes and category scoping are separately tested in the
// Handbook service tests; this verifies the route forwards the right fields.
vi.mock("~/modules/ioio-handbook/service.server", () => ({
  HandbookValidationError: class HandbookValidationError extends Error {},
  listHandbookCategories: mocks.listCategories,
  submitHandbookObservation: mocks.submitObservation,
}));
// why: Staff editor persistence is covered by editor.server.test.ts; this
// confirms the import route delegates staff save/publish actions unchanged.
vi.mock("~/modules/ioio-handbook/editor.server", () => ({
  handbookEditorAction: mocks.editorAction,
}));

import { action, loader } from "~/routes/_layout+/handbook.import";

function requestArgs(form: FormData) {
  return {
    context: {
      getSession: () => ({ userId: "user-1" }),
    } as ActionFunctionArgs["context"],
    request: new Request("http://localhost/handbook/import", {
      method: "POST",
      body: form,
    }),
    params: {},
  } as ActionFunctionArgs;
}

describe("Handbook PDF import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRead.mockResolvedValue({
      organizationId: "org-1",
      userId: "user-1",
      canEdit: true,
      isStudent: false,
      currentOrganization: { type: "TEAM" },
    });
    mocks.listCategories.mockResolvedValue([]);
    mocks.importPdf.mockResolvedValue({
      title: "Soldering Basics",
      content: "## Safety\n\nWear eye protection.",
      sourceUrls: ["https://example.com/manual"],
    });
    mocks.submitObservation.mockResolvedValue({ duplicate: false });
    mocks.editorAction.mockResolvedValue({ status: 302 });
  });

  it("loads only organization-scoped Handbook categories, including the empty state", async () => {
    const result = await loader({
      context: {
        getSession: () => ({ userId: "user-1" }),
      } as LoaderFunctionArgs["context"],
      request: new Request("http://localhost/handbook/import"),
      params: {},
    } as LoaderFunctionArgs);

    expect(result).toMatchObject({
      categories: [],
      isStudent: false,
      organizationId: "org-1",
    });
    expect(mocks.listCategories).toHaveBeenCalledWith("org-1");
  });

  it("rejects non-PDF uploads with a local message", async () => {
    const form = new FormData();
    form.set("intent", "upload-pdf");
    form.set(
      "file",
      new File(["not pdf"], "notes.txt", { type: "text/plain" })
    );

    const result = await action(requestArgs(form));

    expect(result).toMatchObject({
      data: { kind: "error", message: "Only PDF files are supported." },
    });
    expect(mocks.importPdf).not.toHaveBeenCalled();
  });

  it("enforces the PDF size limit while parsing the upload", async () => {
    const form = new FormData();
    form.set("intent", "upload-pdf");
    form.set(
      "file",
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "large.pdf", {
        type: "application/pdf",
      })
    );

    const result = await action(requestArgs(form));

    expect(result).toMatchObject({
      init: { status: 413 },
      data: { kind: "error", message: "PDF files must be 5 MB or smaller." },
    });
    expect(mocks.importPdf).not.toHaveBeenCalled();
  });

  it("returns extracted text for preview without creating or publishing an article", async () => {
    const form = new FormData();
    form.set("intent", "upload-pdf");
    form.set(
      "file",
      new File(["%PDF-1.4 content"], "guide.pdf", { type: "application/pdf" })
    );

    const result = await action(requestArgs(form));

    expect(result).toMatchObject({
      data: {
        kind: "preview",
        draft: {
          title: "Soldering Basics",
          content: "## Safety\n\nWear eye protection.",
          sourceUrls: ["https://example.com/manual"],
        },
      },
    });
    expect(mocks.submitObservation).not.toHaveBeenCalled();
    expect(mocks.editorAction).not.toHaveBeenCalled();
  });

  it("submits a student review contribution with its Handbook category proposal and references", async () => {
    mocks.requireRead.mockResolvedValue({
      organizationId: "org-1",
      userId: "student-1",
      canEdit: false,
      isStudent: true,
      currentOrganization: { type: "TEAM" },
    });
    const form = new FormData();
    form.set("intent", "submit-review");
    form.set("title", "Soldering Basics");
    form.set("content", "Wear eye protection before soldering.");
    form.set("proposedCategoryName", "Workshop Safety");
    form.set("handbookCategoryId", "");
    form.set("sourceUrls", "https://example.com/manual");

    const result = await action(requestArgs(form));

    expect(result).toMatchObject({ data: { kind: "submitted" } });
    expect(mocks.submitObservation).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "student-1",
      title: "Soldering Basics",
      content:
        "Wear eye protection before soldering.\n\nExternal references:\n- https://example.com/manual",
      handbookCategoryId: undefined,
      proposedCategoryName: "Workshop Safety",
    });
    expect(mocks.editorAction).not.toHaveBeenCalled();
  });

  it("delegates Staff publish intent to the existing Handbook editor workflow", async () => {
    const form = new FormData();
    form.set("intent", "publish");
    form.set("title", "Soldering Basics");
    form.set("content", "Wear eye protection.");
    form.set("handbookCategoryId", "handbook-category-1");

    await action(requestArgs(form));

    expect(mocks.editorAction).toHaveBeenCalledTimes(1);
  });
});
