import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  getStaffCardAccessData: vi.fn(),
  addStaffCardAccessRequest: vi.fn(),
  markCardAccessApproved: vi.fn(),
  removeStaffCardAccessRequest: vi.fn(),
  sendTeacherCardAccessBatch: vi.fn(),
}));

// why: this route test isolates card-access persistence and never contacts staff or students.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/modules/ioio-staff/card-access.server", () => ({
  getStaffCardAccessData: mocks.getStaffCardAccessData,
  addStaffCardAccessRequest: mocks.addStaffCardAccessRequest,
  markCardAccessApproved: mocks.markCardAccessApproved,
  removeStaffCardAccessRequest: mocks.removeStaffCardAccessRequest,
  sendTeacherCardAccessBatch: mocks.sendTeacherCardAccessBatch,
}));

import { action, loader } from "~/routes/_layout+/settings.card-access";
import { ShelfError } from "~/utils/error";

const context = { getSession: () => ({ userId: "owner-1" }) } as never;

describe("IOIO Lab Access staff settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      userId: "owner-1",
      organizationId: "team-1",
    });
    mocks.getStaffCardAccessData.mockResolvedValue({
      requests: [],
      people: [],
      staff: [],
    });
  });

  it("loads an empty access queue safely", async () => {
    await expect(
      loader(
        createLoaderArgs({
          context,
          request: new Request("http://localhost/settings/card-access"),
        })
      )
    ).resolves.toMatchObject({ requests: [], people: [], staff: [] });
  });

  it("validates 10-digit cards before creating a request", async () => {
    const request = new Request("http://localhost/settings/card-access", {
      method: "POST",
      body: new URLSearchParams({
        intent: "add-person",
        applicantId: "student-1",
        cardNumber: "1234",
        consent: "true",
      }),
    });
    const result = await action(createActionArgs({ context, request }));
    expect(result).toMatchObject({
      data: {
        error: {
          additionalData: {
            validationErrors: {
              cardNumber: { message: "Card number must be exactly 10 digits." },
            },
          },
        },
      },
    });
    expect(mocks.addStaffCardAccessRequest).not.toHaveBeenCalled();
  });

  it("sends selected waiting requests as a batch and supports approval/removal", async () => {
    const batchForm = new FormData();
    batchForm.set("intent", "send-teacher");
    batchForm.set("recipientId", "admin-2");
    batchForm.append("requestId", "request-1");
    batchForm.append("requestId", "request-2");
    await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/settings/card-access", {
          method: "POST",
          body: batchForm,
        }),
      })
    );
    expect(mocks.sendTeacherCardAccessBatch).toHaveBeenCalledWith({
      organizationId: "team-1",
      staffUserId: "owner-1",
      recipientId: "admin-2",
      requestIds: ["request-1", "request-2"],
    });

    for (const intent of ["approve", "remove"] as const) {
      await action(
        createActionArgs({
          context,
          request: new Request("http://localhost/settings/card-access", {
            method: "POST",
            body: new URLSearchParams({ intent, requestId: "request-1" }),
          }),
        })
      );
    }
    expect(mocks.markCardAccessApproved).toHaveBeenCalledWith({
      organizationId: "team-1",
      requestId: "request-1",
    });
    expect(mocks.removeStaffCardAccessRequest).toHaveBeenCalledWith({
      organizationId: "team-1",
      requestId: "request-1",
    });
  });

  it("denies Student access at the route boundary", async () => {
    mocks.requireIoioStaffAccess.mockRejectedValue(
      new ShelfError({
        cause: null,
        message: "Staff only",
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      })
    );
    await expect(
      loader(
        createLoaderArgs({
          context,
          request: new Request("http://localhost/settings/card-access"),
        })
      )
    ).rejects.toMatchObject({ data: { error: { message: "Staff only" } } });
  });
});
