import { redirect } from "react-router";
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { z } from "zod";
import { db } from "~/database/db.server";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import { createReport } from "~/modules/report-found/service.server";
import { makeShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";

const FoundSchema = z.object({
  assetId: z.string().optional(),
  kitId: z.string().optional(),
  content: z.string().trim().min(3).max(2000),
});

export async function loader({ context, request }: LoaderFunctionArgs) {
  await requireStudentRead({
    context,
    request,
  });
  return redirect("/ioio/report?mode=found");
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId, organizationId } = await requireStudentRead({
    context,
    request,
  });
  try {
    const formData = await request.formData();
    const values = parseData(formData, FoundSchema);
    const [user, asset, kit] = await Promise.all([
      db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      }),
      values.assetId
        ? db.asset.findFirst({
            where: { id: values.assetId, organizationId },
            select: { id: true },
          })
        : null,
      values.kitId
        ? db.kit.findFirst({
            where: { id: values.kitId, organizationId },
            select: { id: true },
          })
        : null,
    ]);
    if (values.assetId && !asset)
      throw new Error("The selected asset is not in this workspace.");
    if (values.kitId && !kit)
      throw new Error("The selected kit is not in this workspace.");
    await createReport({
      email: user.email,
      content: `[IOIO student found report] ${values.content}`,
      assetId: asset?.id,
      kitId: kit?.id,
    });
    return payload({ ok: true });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, organizationId });
    return data(error(reason), { status: reason.status });
  }
}

export default function IoioFound() {
  return null;
}
