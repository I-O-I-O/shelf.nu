import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { z } from "zod";

import { assertIsPost, parseData, safeRedirect } from "~/utils/http.server";

export async function action({ context, request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { redirectTo } = parseData(
    await request.formData(),
    z.object({
      redirectTo: z.string().optional(),
    })
  );

  context.destroySession();
  return redirect(safeRedirect(redirectTo, "/login"));
}

export function loader() {
  return redirect("/");
}
