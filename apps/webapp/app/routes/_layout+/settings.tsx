import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, Outlet, useLoaderData, useMatches } from "react-router";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import HorizontalTabs from "~/components/layout/horizontal-tabs";
import type { RouteHandleWithName } from "~/modules/types";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import { isPersonalOrg } from "~/utils/organization";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export const handle = {
  breadcrumb: () => <Link to="/settings">Settings</Link>,
};

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { currentOrganization, role } = await requirePermission({
      userId: authSession.userId,
      request,
      entity: PermissionEntity.generalSettings,
      action: PermissionAction.read,
    });

    if (role !== "OWNER" && role !== "ADMIN") {
      throw new ShelfError({
        cause: null,
        message: "Staff Settings are available to Owners and Admins only.",
        label: "Permission",
        status: 403,
        shouldBeCaptured: false,
      });
    }

    const title = "Settings";
    const subHeading = "Manage your preferences here.";
    const header = {
      title,
      subHeading,
    };

    return payload({
      header,
      _isPersonalOrg: isPersonalOrg(currentOrganization),
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const shouldRevalidate = () => false;

export function getIoioSettingsTabs(isPersonal: boolean) {
  return isPersonal
    ? [{ to: "backup", content: "Backup" }]
    : [
        { to: "emails", content: "Emails" },
        { to: "lab-information", content: "Lab information" },
        { to: "access-approval", content: "Access approval" },
        { to: "ai", content: "AI" },
        { to: "backup", content: "Backup" },
        { to: "card-access", content: "IOIO Lab Access" },
        { to: "team", content: "IOIO Users" },
      ];
}

export default function SettingsPage() {
  const { _isPersonalOrg } = useLoaderData<typeof loader>();
  const items = getIoioSettingsTabs(_isPersonalOrg);

  const matches = useMatches();
  const currentRoute: RouteHandleWithName = matches[matches.length - 1];
  return (
    <>
      <Header hidePageDescription />
      {!["$userId.assets", "$userId.bookings", "$userId.notes"].includes(
        currentRoute?.handle?.name
      ) ? (
        <HorizontalTabs items={items} />
      ) : null}
      <Outlet />
    </>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
