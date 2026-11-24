import type { ActionFunctionArgs } from "react-router";
import { data } from "react-router";
import { z } from "zod";
import { markAnnualAccessApprovalNotificationRead } from "~/modules/ioio-student/annual-access.server";
import { requireStudentAccountSettings } from "~/modules/ioio-student/route.server";
import { makeShelfError } from "~/utils/error";

const readNotificationSchema = z.object({
  notificationId: z.string().min(1).max(64),
});

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireStudentAccountSettings({ context, request });
    const parsed = readNotificationSchema.safeParse(
      Object.fromEntries(await request.formData())
    );
    if (!parsed.success) {
      return data(
        { ok: false as const, message: "This notification could not be read." },
        { status: 400 }
      );
    }

    await markAnnualAccessApprovalNotificationRead({
      organizationId: auth.organizationId,
      userId: auth.userId,
      notificationId: parsed.data.notificationId,
    });
    return data({ ok: true as const });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(
      { ok: false as const, message: reason.message },
      { status: reason.status }
    );
  }
}
