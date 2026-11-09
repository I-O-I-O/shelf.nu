import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  getGuidelines: vi.fn(),
  saveGuidelines: vi.fn(),
}));

// why: route tests isolate the organization-scoped AI settings persistence services.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/modules/ioio-ai-guidelines/service.server", () => ({
  getIoioAiGuidelines: mocks.getGuidelines,
  saveIoioAiGuidelines: mocks.saveGuidelines,
}));

import {
  action as guidelinesAction,
  loader as guidelinesLoader,
} from "~/routes/_layout+/settings.ai.guidelines";
import { loader as knowledgeLoader } from "~/routes/_layout+/settings.ai.knowledge";

const context = { getSession: () => ({ userId: "owner-1" }) } as never;

describe("IOIO AI settings routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      userId: "owner-1",
      organizationId: "team-1",
      currentOrganization: { type: "TEAM" },
      role: "OWNER",
    });
    mocks.getGuidelines.mockResolvedValue({
      sections: {
        generalBehaviour: "",
        inventory: "",
        borrowing: "",
        locations: "",
        studentSupport: "",
        staffSupport: "",
        actions: "",
      },
      updatedAt: null,
      updatedBy: null,
    });
  });

  it("loads empty guideline defaults and saves validated guidance", async () => {
    await expect(
      guidelinesLoader(
        createLoaderArgs({
          context,
          request: new Request("http://localhost/settings/ai/guidelines"),
        })
      )
    ).resolves.toMatchObject({ sections: { generalBehaviour: "" } });

    const form = new URLSearchParams({
      generalBehaviour: "Keep answers concise.",
      inventory: "",
      borrowing: "",
      locations: "",
      studentSupport: "",
      staffSupport: "",
      actions: "",
    });
    await guidelinesAction(
      createActionArgs({
        context,
        request: new Request("http://localhost/settings/ai/guidelines", {
          method: "POST",
          body: form,
        }),
      })
    );
    expect(mocks.saveGuidelines).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "team-1",
        userId: "owner-1",
        sections: expect.objectContaining({
          generalBehaviour: "Keep answers concise.",
        }),
      })
    );
  });

  it("keeps AI knowledge settings informational and out of Handbook moderation", async () => {
    await expect(
      knowledgeLoader(
        createLoaderArgs({
          context,
          request: new Request("http://localhost/settings/ai/knowledge"),
        })
      )
    ).resolves.toBeNull();
  });
});
