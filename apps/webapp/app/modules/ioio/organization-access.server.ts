import { redirectDocument } from "react-router";
import { setSelectedOrganizationIdCookie } from "~/modules/organization/context.server";
import { setCookie } from "~/utils/cookies.server";
import { ShelfError } from "~/utils/error";
import { resolveIoioAccountMembership } from "~/utils/ioio-role-routing";

type IoioOrganizationMembership = {
  organizationId: string;
  roles: readonly string[];
  organization: { type: string };
  user?: { lastSelectedOrganizationId?: string | null };
};

/**
 * Keep IOIO requests on the authorized Team membership chosen by the existing
 * IOIO resolver. Reads with a stale Personal selection refresh Shelf's cookie;
 * writes fail closed until the Team selection is active.
 */
export async function ensureIoioTeamOrganizationForRequest({
  request,
  organizationId,
  currentOrganizationType,
  userOrganizations,
}: {
  request: Pick<Request, "method" | "url">;
  organizationId: string | null | undefined;
  currentOrganizationType: string | null | undefined;
  userOrganizations: readonly IoioOrganizationMembership[];
}) {
  const resolvedMembership = organizationId
    ? resolveIoioAccountMembership(
        userOrganizations,
        organizationId,
        currentOrganizationType ?? "",
        userOrganizations[0]?.user?.lastSelectedOrganizationId
      )
    : null;

  if (
    resolvedMembership?.organizationId === organizationId &&
    currentOrganizationType === "TEAM"
  ) {
    return;
  }

  if (
    resolvedMembership &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    const url = new URL(request.url);
    const cookie = await setSelectedOrganizationIdCookie(
      resolvedMembership.organizationId
    );
    throw redirectDocument(`${url.pathname}${url.search}`, {
      headers: [setCookie(cookie)],
    });
  }

  throw new ShelfError({
    cause: null,
    title: "IOIO Team organization required",
    message:
      "IOIO operational data can only be changed in an authorized Team workspace.",
    status: 403,
    label: "Organization",
    shouldBeCaptured: false,
  });
}
