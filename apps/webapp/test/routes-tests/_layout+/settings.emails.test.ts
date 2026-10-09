import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";
import { action, loader } from "~/routes/_layout+/settings.emails";
import type * as EnvModule from "~/utils/env";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  requireIoioStaffAccess: vi.fn(),
  getTemplates: vi.fn(),
  saveTemplate: vi.fn(),
  restoreTemplate: vi.fn(),
  updateOrganization: vi.fn(),
  sendNotification: vi.fn(),
  getEnv: vi.fn(),
}));

// why: email settings tests isolate organization-scoped services and avoid SMTP configuration.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/modules/email-templates/service.server", () => ({
  getEmailTemplatesForOrganization: mocks.getTemplates,
  saveEmailTemplate: mocks.saveTemplate,
  restoreEmailTemplate: mocks.restoreTemplate,
}));
vi.mock("~/modules/organization/service.server", () => ({
  updateOrganization: mocks.updateOrganization,
}));
vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: mocks.sendNotification,
}));
vi.mock("~/utils/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  getEnv: mocks.getEnv,
}));

const context = { getSession: () => ({ userId: "owner-1" }) } as never;

describe("IOIO Emails settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      userId: "owner-1",
      organizationId: "team-1",
    });
    mocks.getEnv.mockImplementation((name: string) =>
      name === "SMTP_FROM" ? "IOIO <lab@example.test>" : "smtp.example.test"
    );
    mocks.requirePermission.mockResolvedValue({
      organizationId: "team-1",
      currentOrganization: {
        id: "team-1",
        type: "TEAM",
        name: "IOIO Lab",
        customEmailFooter: "IOIO Lab support",
      },
    });
    mocks.getTemplates.mockResolvedValue([
      {
        key: "booking_reservation",
        name: "Course reservation created",
        category: "Borrowing",
        subject: "Reservation {{bookingName}}",
        body: "Hello {{displayName}}",
        editable: true,
        enabled: true,
        customized: false,
      },
    ]);
  });

  it("loads sender readiness, templates, and the custom footer", async () => {
    await expect(
      loader(
        createLoaderArgs({
          context,
          request: new Request("http://localhost/settings/emails"),
        })
      )
    ).resolves.toMatchObject({
      delivery: { configured: true, provider: "SMTP" },
      organization: { customEmailFooter: "IOIO Lab support" },
      templates: [{ key: "booking_reservation" }],
    });
    expect(mocks.getTemplates).toHaveBeenCalledWith("team-1");
  });

  it("renders an unavailable delivery state when SMTP is not configured", async () => {
    mocks.getEnv.mockReturnValue("");
    await expect(
      loader(
        createLoaderArgs({
          context,
          request: new Request("http://localhost/settings/emails"),
        })
      )
    ).resolves.toMatchObject({
      delivery: {
        configured: false,
        provider: "Not configured",
        senderName: "Provider default",
      },
    });
  });

  it("saves a template and can restore its built-in default", async () => {
    const saveRequest = new Request("http://localhost/settings/emails", {
      method: "POST",
      body: new URLSearchParams({
        intent: "save-template",
        templateKey: "booking_reservation",
        subject: "New reservation {{bookingName}}",
        body: "Hi {{displayName}}",
        enabled: "on",
      }),
    });
    await action(createActionArgs({ context, request: saveRequest }));
    expect(mocks.saveTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "team-1",
        key: "booking_reservation",
        enabled: true,
      })
    );

    const restoreRequest = new Request("http://localhost/settings/emails", {
      method: "POST",
      body: new URLSearchParams({
        intent: "restore-template",
        templateKey: "booking_reservation",
      }),
    });
    await action(createActionArgs({ context, request: restoreRequest }));
    expect(mocks.restoreTemplate).toHaveBeenCalledWith(
      "team-1",
      "booking_reservation"
    );
  });

  it("saves the custom footer and denies Students", async () => {
    await action(
      createActionArgs({
        context,
        request: new Request("http://localhost/settings/emails", {
          method: "POST",
          body: new URLSearchParams({
            intent: "save-footer",
            customEmailFooter: "Contact IOIO Lab at help@example.test",
          }),
        }),
      })
    );
    expect(mocks.updateOrganization).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "team-1",
        customEmailFooter: "Contact IOIO Lab at help@example.test",
      })
    );

    mocks.requireIoioStaffAccess.mockRejectedValue(
      new (await import("~/utils/error")).ShelfError({
        cause: null,
        message: "Staff only",
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      })
    );
    await expect(
      action(
        createActionArgs({
          context,
          request: new Request("http://localhost/settings/emails", {
            method: "POST",
            body: new URLSearchParams({ intent: "save-footer" }),
          }),
        })
      )
    ).resolves.toMatchObject({
      data: { error: { message: "Staff only" } },
    });
  });
});
