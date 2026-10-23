import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireIoioBorrowerAccess: vi.fn(),
  submitReturnItem: vi.fn(),
  cancelReturnItem: vi.fn(),
  prepareReturnItem: vi.fn(),
}));

// why: a route action needs an authenticated borrower, while session setup is
// outside the navigation behavior covered here.
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireIoioBorrowerAccess: mocks.requireIoioBorrowerAccess,
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

import {
  action,
  IOIO_RETURN_REPORT_TYPES,
} from "~/routes/_layout+/ioio.return";

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

function prepareProblemRequest(reportType: string) {
  const form = new FormData();
  form.set("intent", "prepare-return");
  form.set("bookingId", "booking-1");
  form.set("bookingAssetId", "booking-asset-1");
  form.set("assetId", "asset-1");
  form.set("quantity", "1");
  form.set("issueState", "problem");
  form.set("reportType", reportType);
  form.set("issueComment", "Student entered issue details.");
  return new Request("http://localhost/ioio/return", {
    method: "POST",
    body: form,
  });
}

describe("student guided return navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioBorrowerAccess.mockResolvedValue({
      userId: "student-1",
      organizationId: "org-1",
      role: "SELF_SERVICE",
    });
    mocks.submitReturnItem.mockResolvedValue({ ok: true });
  });

  it("keeps visible return issue labels mapped to explicit persisted enums", () => {
    expect(IOIO_RETURN_REPORT_TYPES).toEqual([
      { value: "ITEM_DAMAGED", label: "Broken or damaged" },
      { value: "PART_MISSING", label: "Missing parts" },
      { value: "ITEM_NOT_WORKING", label: "Not working" },
      { value: "OTHER", label: "Other" },
    ]);
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

  it.each([
    { label: "Broken or damaged", reportType: "ITEM_DAMAGED" },
    { label: "Missing parts", reportType: "PART_MISSING" },
    { label: "Not working", reportType: "ITEM_NOT_WORKING" },
    { label: "Other", reportType: "OTHER" },
  ])(
    "passes guided return issue $label as canonical $reportType",
    async ({ reportType }) => {
      const response = await action({
        context: {},
        request: prepareProblemRequest(reportType),
      } as never);

      expect(mocks.prepareReturnItem).toHaveBeenCalledWith(
        {
          booking_id: "booking-1",
          booking_asset_id: "booking-asset-1",
          asset_id: "asset-1",
          quantity: 1,
        },
        expect.objectContaining({ context: {}, auth: expect.anything() }),
        {
          issueState: "problem",
          reportType,
          issueComment: "Student entered issue details.",
        }
      );
      expect(response).toMatchObject({ data: { ok: true } });
    }
  );

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

  it("returns a Staff borrower's successful return to personal My Loans", async () => {
    mocks.requireIoioBorrowerAccess.mockResolvedValue({
      userId: "staff-1",
      organizationId: "org-1",
      role: "ADMIN",
    });

    const response = await action({
      context: { getSession: () => ({ userId: "staff-1" }) },
      request: returnRequest("finish-return"),
    } as never);

    expect(mocks.submitReturnItem).toHaveBeenCalledOnce();
    expect((response as Response).headers.get("Location")).toBe(
      "/ioio/loans?return=submitted"
    );
  });
});
