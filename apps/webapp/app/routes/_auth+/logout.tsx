import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { z } from "zod";
import { endSessionByRefreshToken } from "~/modules/auth/service.server";

import { assertIsPost, parseData, safeRedirect } from "~/utils/http.server";

export async function action({ context, request }: ActionFunctionArgs) {
  assertIsPost(request);
  const { redirectTo } = parseData(
    await request.formData(),
    z.object({
      redirectTo: z.string().optional(),
    })
  );

  if (context.isAuthenticated) {
    // Revocation is best-effort; clear the browser cookie even if Supabase is
    // unavailable. The token lookup targets this browser's session, even when
    // its access-token JWT has expired, and preserves other user sessions.
    await endSessionByRefreshToken(context.getSession().refreshToken);
  }
  context.destroySession();
  return redirect(safeRedirect(redirectTo, "/login"));
}

export function loader() {
  return redirect("/");
}
