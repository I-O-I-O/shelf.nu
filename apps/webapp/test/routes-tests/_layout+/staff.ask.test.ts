import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  answerStaffAssistant: vi.fn(),
}));

// why: the staff role gate and provider-neutral assistant are isolated so this
// route can verify access and the useful fallback response without API keys.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/modules/ioio-staff/assistant.server", () => ({
  answerStaffAssistant: mocks.answerStaffAssistant,
}));
// why: the shared student UI imports scanner animation code that uses canvas
// APIs unavailable in happy-dom at module initialization.
vi.mock("lottie-react", () => ({ default: () => null }));

import { action, loader } from "~/routes/_layout+/staff.ask";

describe("staff Ask IOIO route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      userId: "staff-1",
      organizationId: "org-1",
      role: "OWNER",
    });
    mocks.answerStaffAssistant.mockResolvedValue({
      answer: "AI is not configured, so here is the current Shelf status.",
      provider: "fallback",
      toolsUsed: [],
      assets: [],
      entityContext: {},
    });
  });

  it("requires the staff access gate", async () => {
    mocks.requireIoioStaffAccess.mockRejectedValue(
      new Response("Staff access required", { status: 403 })
    );
    await expect(
      loader(
        createLoaderArgs({
          context: { getSession: () => ({ userId: "student-1" }) } as never,
          request: new Request("http://localhost/staff/ask"),
        })
      )
    ).rejects.toBeInstanceOf(Response);
  });

  it("returns a useful assistant fallback when no model provider is configured", async () => {
    const request = new Request("http://localhost/staff/ask", {
      method: "POST",
      body: new URLSearchParams({
        intent: "ask",
        question: "What is the lab status?",
      }),
    });
    const result = (await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
        request,
      })
    )) as unknown as {
      answer: { answer: string; provider: string };
      kind: string;
    };

    expect(result.answer.answer).toContain("AI is not configured");
    expect(result.answer.provider).toBe("fallback");
    expect(result.kind).toBe("assistant");
  });
});
