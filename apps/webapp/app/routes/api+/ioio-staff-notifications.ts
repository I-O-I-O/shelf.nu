import { data, type ActionFunctionArgs } from "react-router";
import { z } from "zod";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { resolveLabIssue } from "~/modules/ioio-staff/lab-status.server";
import { makeShelfError } from "~/utils/error";
import { assertIsPost, error, payload, parseData } from "~/utils/http.server";

const ResolveNotificationSchema = z.object({
  intent: z.literal("resolve"),
  operationId: z.string().min(1).max(100),
});

/** Resolves an existing report-backed Staff lab task. */
export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();

  try {
    assertIsPost(request);
    const { organizationId } = await requireIoioStaffAccess({
      context,
      request,
    });
    const { operationId } = parseData(
      await request.formData(),
      ResolveNotificationSchema
    );
    const result = await resolveLabIssue({ organizationId, operationId });

    return data(payload({ success: true, ...result }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}
