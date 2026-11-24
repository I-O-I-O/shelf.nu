import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { ShelfError } from "~/utils/error";

async function authorizeLegacyManagementRoute({
  context,
  request,
}: {
  context: LoaderFunctionArgs["context"];
  request: Request;
}) {
  const auth = await requireIoioStaffAccess({ context, request });
  if (auth.currentOrganization.type === "PERSONAL") {
    throw new ShelfError({
      cause: null,
      message: "Handbook management is available in IOIO Lab workspaces only.",
      label: "Handbook",
      status: 403,
      shouldBeCaptured: false,
    });
  }
}

export async function loader(args: LoaderFunctionArgs) {
  await authorizeLegacyManagementRoute(args);
  return redirect("/handbook/manage");
}

export async function action(args: ActionFunctionArgs) {
  await authorizeLegacyManagementRoute(args);
  return redirect("/handbook/manage");
}
