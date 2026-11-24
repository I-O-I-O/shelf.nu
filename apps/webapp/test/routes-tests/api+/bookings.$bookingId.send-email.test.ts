import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  findBooking: vi.fn(),
  sendEmail: vi.fn(),
  smtpHost: "smtp.dev.local",
}));

// why: the route is tested against a minimal organization without a database connection.
vi.mock("~/database/db.server", () => ({
  db: { booking: { findFirst: mocks.findBooking } },
}));
// why: permission checks are controlled here to verify staff/student behavior explicitly.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
// why: external email delivery must never occur during route tests.
vi.mock("~/emails/mail.server", () => ({ sendEmail: mocks.sendEmail }));
// why: provide a deterministic local mail-configuration state for the action.
vi.mock("~/utils/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/utils/env")>();
  return {
    ...actual,
    get SMTP_HOST() {
      return mocks.smtpHost;
    },
  };
});

import { action } from "~/routes/api+/bookings.$bookingId.send-email";

function makeRequest(
  fields: Record<string, string> = {
    subject: "Loan message",
    message: "Please return the equipment by Friday.",
  }
) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return new Request("http://localhost/api/bookings/loan-1/send-email", {
    method: "POST",
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.smtpHost = "smtp.dev.local";
  mocks.requirePermission.mockResolvedValue({
    organizationId: "org-1",
    isSelfServiceOrBase: false,
  });
  mocks.findBooking.mockResolvedValue({
    custodianUser: { email: "student@example.org" },
    custodianTeamMember: null,
  });
});

describe("IOIO staff loan email action", () => {
  it("sends to the borrower only after an organization-scoped booking lookup", async () => {
    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        params: { bookingId: "loan-1" },
        request: makeRequest(),
      })
    );

    expect(result).toMatchObject({ data: { ok: true } });
    expect(mocks.findBooking).toHaveBeenCalledWith({
      where: { id: "loan-1", organizationId: "org-1" },
      select: {
        custodianUser: { select: { email: true } },
        custodianTeamMember: {
          select: { user: { select: { email: true } } },
        },
      },
    });
    expect(mocks.sendEmail).toHaveBeenCalledWith({
      to: "student@example.org",
      subject: "Loan message",
      text: "Please return the equipment by Friday.",
    });
  });

  it("denies student users before looking up a booking", async () => {
    mocks.requirePermission.mockResolvedValueOnce({
      organizationId: "org-1",
      isSelfServiceOrBase: true,
    });

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "student-1" }) },
        params: { bookingId: "loan-1" },
        request: makeRequest(),
      })
    );

    expect(result.init?.status).toBe(403);
    expect(mocks.findBooking).not.toHaveBeenCalled();
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("returns not found for a loan outside the active organization", async () => {
    mocks.findBooking.mockResolvedValueOnce(null);

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        params: { bookingId: "foreign-loan" },
        request: makeRequest(),
      })
    );

    expect(result.init?.status).toBe(404);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("requires configured email delivery", async () => {
    mocks.smtpHost = "";

    const result = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "staff-1" }) },
        params: { bookingId: "loan-1" },
        request: makeRequest(),
      })
    );

    expect(result.init?.status).toBe(503);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });
});
