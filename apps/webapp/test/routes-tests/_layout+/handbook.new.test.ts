import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireIoioHandbookRead: vi.fn(),
  saveHandbookRevision: vi.fn(),
  submitHandbookRevision: vi.fn(),
  publishHandbookRevision: vi.fn(),
}));

// why: exercise the route's server-side role boundary without requiring a Shelf
// session or database connection.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireIoioHandbookRead,
}));
// why: ensure article create and publish actions do not load Claude review.
vi.mock("~/modules/ioio-handbook/handbook-review.server", () => {
  throw new Error("Claude helper unavailable");
});
// why: persistence is outside this authorization-focused route test.
vi.mock("~/modules/ioio-handbook/workflow.server", () => ({
  getHandbookFormOptions: vi.fn(),
  saveHandbookRevision: mocks.saveHandbookRevision,
  submitHandbookRevision: mocks.submitHandbookRevision,
  publishHandbookRevision: mocks.publishHandbookRevision,
}));
vi.mock("~/modules/ioio-handbook/handbook.types", () => ({
  HANDBOOK_ARTICLE_TYPES: ["Guide"],
}));

import { action } from "~/routes/_layout+/handbook.new";

function buildArgs(intent: string) {
  const form = new FormData();
  form.set("intent", intent);
  form.set("title", "Soldering Basics");
  form.set("summary", "Practical soldering guide.");
  form.set("content", "Use a clean, temperature-controlled iron.");
  form.set("category", "Electronics");
  form.set("topic", "Soldering");
  form.set("articleType", "Guide");
  const request = new Request("https://app.shelf.nu/handbook/new", {
    method: "POST",
    body: form,
  });
  const context = { getSession: () => ({ userId: "student-1" }) };
  return { request, context } as unknown as Parameters<typeof action>[0];
}

describe("Handbook proposal route authorization", () => {
  it("rejects a student publish request on the server", async () => {
    mocks.requireIoioHandbookRead.mockResolvedValue({
      organizationId: "org-1",
      userId: "student-1",
      canEdit: false,
      isStudent: true,
    });

    const result = await action(buildArgs("publish"));

    expect(result).toMatchObject({
      data: {
        ok: false,
        message: "Only staff can publish Handbook articles.",
      },
      init: { status: 403 },
    });
    expect(mocks.saveHandbookRevision).not.toHaveBeenCalled();
    expect(mocks.publishHandbookRevision).not.toHaveBeenCalled();
  });

  it("allows staff to publish directly without requiring Claude", async () => {
    mocks.requireIoioHandbookRead.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
      canEdit: true,
      isStudent: false,
    });
    mocks.saveHandbookRevision.mockResolvedValue({
      id: "revision-1",
      slug: "soldering-basics",
    });
    mocks.publishHandbookRevision.mockResolvedValue({
      slug: "soldering-basics",
      versionNumber: 1,
    });

    const result = await action(buildArgs("publish"));

    expect(mocks.saveHandbookRevision).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: "org-1", userId: "staff-1" })
    );
    expect(mocks.publishHandbookRevision).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "staff-1",
      revisionId: "revision-1",
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get("Location")).toBe(
      "/handbook/soldering-basics"
    );
  });
});
