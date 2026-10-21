import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireStudentRead: vi.fn(),
  submitReturnItem: vi.fn(),
  cancelReturnItem: vi.fn(),
  prepareReturnItem: vi.fn(),
}));

// why: a route action needs an authenticated borrower, while session setup is
// outside the navigation behavior covered here.
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireStudentRead: mocks.requireStudentRead,
}));
// why: the durable Shelf return mutation is tested in return-item.server.test;
// this route test checks that navigation follows its actual success or failure.
vi.mock("~/modules/ioio-student/return-item.server", () => ({
  submitReturnItem: mocks.submitReturnItem,
  cancelReturnItem: mocks.cancelReturnItem,
  prepareReturnItem: mocks.prepareReturnItem,
}));
// why: the route's UI import includes an animation that needs browser canvas.
vi.mock("lottie-react", () => ({ default: () => null }));

import { action } from "~/routes/_layout+/ioio.return";

const confirmationToken = "123e4567-e89b-42d3-a456-426614174000";

function returnRequest(intent: "finish-return" | "cancel-return") {
  const form = new FormData();
  form.set("intent", intent);
  form.set("confirmationToken", confirmationToken);
  if (intent === "finish-return") form.set("quantity", "1");
  return new Request("http://localhost/ioio/return", {
    method: "POST",
    body: form,
  });
}

describe("student guided return navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "org-1",
      role: "SELF_SERVICE",
    });
    mocks.submitReturnItem.mockResolvedValue({ ok: true });
  });

  it("redirects a successful return to My Loans with its success notice", async () => {
    const request = returnRequest("finish-return");
    const response = await action({ context: {}, request } as never);

    expect(mocks.submitReturnItem).toHaveBeenCalledOnce();
    expect(mocks.submitReturnItem).toHaveBeenCalledWith(
      { confirmationToken, quantity: 1 },
      expect.objectContaining({ context: {}, request })
    );
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Location")).toBe(
      "/ioio/loans?return=submitted"
    );
  });

  it("keeps a failed return on the form with its error", async () => {
    mocks.submitReturnItem.mockRejectedValue(
      new Error("Return could not be submitted")
    );
    const response = await action({
      context: {},
      request: returnRequest("finish-return"),
    } as never);

    expect(mocks.submitReturnItem).toHaveBeenCalledOnce();
    expect(response).not.toBeInstanceOf(Response);
    expect(response).toMatchObject({
      data: { ok: false, error: "Sorry, something went wrong." },
    });
  });

  it("keeps cancellation returning to My Loans without submitting", async () => {
    const response = await action({
      context: {},
      request: returnRequest("cancel-return"),
    } as never);

    expect(mocks.cancelReturnItem).toHaveBeenCalledWith(
      confirmationToken,
      expect.objectContaining({ context: {} })
    );
    expect(mocks.submitReturnItem).not.toHaveBeenCalled();
    expect((response as Response).headers.get("Location")).toBe("/ioio/loans");
  });
});
