import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";
import { db } from "~/database/db.server";
import { sendEmail } from "~/emails/mail.server";
import { SMTP_HOST } from "~/utils/env";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const sendLoanEmailSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(5000),
});

export async function action({ context, request, params }: ActionFunctionArgs) {
  const { userId } = context.getSession();

  try {
    const permission = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.read,
    });
    if (permission.isSelfServiceOrBase) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message: "Only staff can send loan emails.",
        label: "Booking",
        shouldBeCaptured: false,
        status: 403,
      });
    }

    const bookingId = z.string().min(1).parse(params.bookingId);
    const formData = Object.fromEntries(await request.formData());
    const parsed = sendLoanEmailSchema.parse(formData);
    const booking = await db.booking.findFirst({
      where: { id: bookingId, organizationId: permission.organizationId },
      select: {
        custodianUser: { select: { email: true } },
        custodianTeamMember: {
          select: { user: { select: { email: true } } },
        },
      },
    });

    if (!booking) {
      throw new ShelfError({
        cause: null,
        title: "Loan not found",
        message: "This loan is no longer available.",
        label: "Booking",
        shouldBeCaptured: false,
        status: 404,
      });
    }

    const recipient =
      booking.custodianUser?.email ?? booking.custodianTeamMember?.user?.email;
    if (!recipient) {
      throw new ShelfError({
        cause: null,
        title: "No borrower email",
        message:
          "This borrower does not have an email address on their account.",
        label: "Booking",
        shouldBeCaptured: false,
        status: 400,
      });
    }
    if (!SMTP_HOST) {
      throw new ShelfError({
        cause: null,
        title: "Email is not configured",
        message: "Configure email in Settings > Email before sending messages.",
        label: "Booking",
        shouldBeCaptured: false,
        status: 503,
      });
    }

    sendEmail({ to: recipient, subject: parsed.subject, text: parsed.message });
    return data({ ok: true as const });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
