import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

// why: the route test isolates the modern permission and organization service boundaries.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/modules/ioio-student/annual-access.server", () => ({
  DEFAULT_ACCESS_APPROVAL_RENEWAL_MONTH: 9,
  getAccessApprovalSettings: mocks.getSettings,
  updateAccessApprovalSettings: mocks.updateSettings,
}));

import { action, loader } from "~/routes/_layout+/settings.access-approval";
import { ShelfError } from "~/utils/error";

const defaults = {
  required: true,
  renewalMode: "ACADEMIC_YEAR",
  renewalMonth: 9,
  customMonths: null,
  studentMessage: "Annual approval is required.",
};

describe("Staff borrowing approval settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      organizationId: "team-1",
      userId: "owner-1",
      role: "OWNER",
    });
    mocks.getSettings.mockResolvedValue(defaults);
  });

  it("loads the fresh Team defaults", async () => {
    const result = await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "owner-1" }) } as never,
        request: new Request("http://localhost/settings/access-approval"),
      })
    );
    expect(result).toMatchObject({ settings: defaults });
    expect(mocks.getSettings).toHaveBeenCalledWith("team-1");
  });

  it("saves the renewal policy and student-facing message", async () => {
    const request = new Request("http://localhost/settings/access-approval", {
      method: "POST",
      body: new URLSearchParams({
        required: "on",
        renewalMode: "CUSTOM",
        renewalMonth: "9",
        customMonths: "8",
        studentMessage: "Please request approval.",
      }),
    });
    await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "owner-1" }) } as never,
        request,
      })
    );
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      organizationId: "team-1",
      updatedByUserId: "owner-1",
      required: true,
      renewalMode: "CUSTOM",
      renewalMonth: 9,
      customMonths: 8,
      studentMessage: "Please request approval.",
    });
  });

  it("denies Students at the server route boundary", async () => {
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
          context: { getSession: () => ({ userId: "student-1" }) } as never,
          request: new Request("http://localhost/settings/access-approval"),
        })
      )
    ).rejects.toMatchObject({ data: { error: { message: "Staff only" } } });
  });
});
