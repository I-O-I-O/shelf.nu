import { useMemo } from "react";
import { OrganizationRoles, type InviteStatuses } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, redirect, Link, Outlet, useMatches, Form } from "react-router";
import { ioioRoleLabel } from "~/components/ioio-staff/role-label";
import ContextualModal from "~/components/layout/contextual-modal";
import type { HeaderData } from "~/components/layout/header/types";
import { List } from "~/components/list";
import { ListContentWrapper } from "~/components/list/content-wrapper";
import { Filters } from "~/components/list/filters";
import ImportUsersDialog from "~/components/settings/import-users-dialog/import-users-dialog";
import InviteUserDialog from "~/components/settings/invite-user-dialog";
import { Button } from "~/components/shared/button";
import { InfoTooltip } from "~/components/shared/info-tooltip";

import { Td, Th } from "~/components/table";
import { SSOUserBadge } from "~/components/user/sso-user-badge";
import { TeamUsersActionsDropdown } from "~/components/workspace/users-actions-dropdown";
import { db } from "~/database/db.server";
import { useSearchParams } from "~/hooks/search-params";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import {
  getStaffAnnualAccessApprovals,
  grantAnnualAccessToStudent,
  revokeAnnualAccessApproval,
} from "~/modules/ioio-student/annual-access.server";
import { getPaginatedAndFilterableSettingUsers } from "~/modules/settings/service.server";
import type { TeamMembersWithUserOrInvite } from "~/modules/settings/service.server";
import type { RouteHandleWithName } from "~/modules/types";
import { resolveUserAction } from "~/modules/user/utils.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { computeHasActiveFilters } from "~/utils/filter-params";
import { error, getCurrentSearchParams } from "~/utils/http.server";
import { Logger } from "~/utils/logger";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { tw } from "~/utils/tw";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    /**
     * requirePermission already fetches the current organization via
     * ORGANIZATION_SELECT_FIELDS, so we reuse it instead of making a
     * separate db.organization.findFirst() call.
     */
    const { organizationId, currentOrganization: organization } =
      await requirePermission({
        userId,
        request,
        entity: PermissionEntity.teamMember,
        action: PermissionAction.read,
      });

    /**
     * Personal workspaces can't manage registered users. Send them to the Team
     * page (which explains how to upgrade) instead of a contextless redirect.
     */
    if (organization?.type === "PERSONAL") {
      return redirect("/settings/team/nrm");
    }

    const searchParams = getCurrentSearchParams(request);
    const hasActiveFilters = computeHasActiveFilters(searchParams);

    const {
      page,
      perPage,
      search,
      items: userItems,
      totalItems: memberTotalItems,
    } = await getPaginatedAndFilterableSettingUsers({
      organizationId,
      request,
    });
    let annualAccessApprovals: Awaited<
      ReturnType<typeof getStaffAnnualAccessApprovals>
    > | null = null;
    let taUserIds = new Set<string>();
    try {
      const [accessApprovals, taMemberships] = await Promise.all([
        getStaffAnnualAccessApprovals({ organizationId }),
        db.ioioLabTA.findMany({
          where: {
            organizationId,
            userId: { in: userItems.flatMap((item) => item.userId ?? []) },
          },
          select: { userId: true },
        }),
      ]);
      annualAccessApprovals = accessApprovals;
      taUserIds = new Set(taMemberships.map((membership) => membership.userId));
    } catch (cause) {
      // The registered user directory is authoritative independently of the
      // optional borrowing-approval status column/table. Keep the directory
      // available if that supplementary lookup is temporarily unavailable.
      Logger.warn({
        event: "ioio_user_directory_access_status_unavailable",
        organizationId,
        cause,
      });
    }
    const accessByUserId = new Map(
      (annualAccessApprovals?.access ?? []).map((approval) => [
        approval.student.id,
        approval,
      ])
    );
    const pendingByUserId = new Map(
      (annualAccessApprovals?.pending ?? []).map((approval) => [
        approval.student.id,
        approval,
      ])
    );
    const items: UserWithBorrowingAccess[] = userItems.map((item) => {
      if (
        item.roleEnum !== OrganizationRoles.SELF_SERVICE ||
        !item.userId ||
        taUserIds.has(item.userId)
      ) {
        return { ...item, borrowingAccess: null };
      }

      if (!annualAccessApprovals) {
        return {
          ...item,
          borrowingAccess: { state: "UNAVAILABLE" as const, approvalId: null },
        };
      }

      const currentAccess = accessByUserId.get(item.userId);
      const pendingApproval = pendingByUserId.get(item.userId);
      const borrowingState =
        currentAccess?.accessState === "ACTIVE"
          ? ("ACTIVE" as const)
          : pendingApproval
          ? ("PENDING" as const)
          : currentAccess?.accessState ?? ("NONE" as const);
      return {
        ...item,
        borrowingAccess: {
          required: annualAccessApprovals.required,
          state: !annualAccessApprovals.required
            ? ("NOT_REQUIRED" as const)
            : borrowingState,
          approvalId:
            (borrowingState === "ACTIVE" ? currentAccess?.id : null) ??
            pendingApproval?.id ??
            currentAccess?.id ??
            null,
        },
      };
    });

    const totalItems = memberTotalItems;
    const totalPages = Math.ceil(memberTotalItems / perPage);

    const header: HeaderData = {
      title: `Settings - ${organization.name}`,
    };

    const modelName = {
      singular: "user",
      plural: "users",
    };

    return {
      header,
      items,
      totalItems,
      page,
      perPage,
      search,
      totalPages,
      modelName,
      hasActiveFilters,
      organization,
      searchFieldLabel: "Search by name or email",
      searchFieldTooltip: {
        title: "Search team members",
        text: "Search team members by first name, last name, or email address.",
      },
    };
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export async function action({ context, request }: ActionFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    await requireIoioStaffAccess({ context, request });
    const { organizationId, role } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.teamMember,
      action: PermissionAction.update,
    });

    const formData = await request.clone().formData();
    const intent = String(formData.get("intent") ?? "");
    if (intent === "grant-borrowing-access") {
      return data({
        ok: true as const,
        result: await grantAnnualAccessToStudent({
          organizationId,
          staffUserId: userId,
          studentUserId: String(formData.get("studentUserId") ?? ""),
        }),
      });
    }
    if (intent === "revoke-borrowing-access") {
      return data({
        ok: true as const,
        result: await revokeAnnualAccessApproval({
          organizationId,
          staffUserId: userId,
          requestId: String(formData.get("approvalId") ?? ""),
        }),
      });
    }
    return await resolveUserAction(request, organizationId, userId, role);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const handle = {
  name: "settings.team.users",
  breadcrumb: () => <Link to="/settings/team">IOIO Users</Link>,
};

export default function UserTeamSetting() {
  /**
   * We have 4 cases when we should render index:
   * 1. When we are on the index route
   * 2. When we are on the .new route - the reason we do this is because we want to have the .new modal overlaying the index.
   * 3. When we are on the assets.$assetId.bookings page
   * 4. When we are on the settings.team.users.$userId.bookings
   */
  const matches = useMatches();
  const currentRoute: RouteHandleWithName = matches[matches.length - 1];
  const allowedRoutes = [
    "settings.team.users", // users index
    "settings.team.invites.invite-user", // invite user modal
  ];

  const shouldRenderIndex = allowedRoutes.includes(currentRoute?.handle?.name);

  return shouldRenderIndex ? (
    <div>
      <ContextualModal />

      <p className="mb-6 text-xs text-gray-600">
        Users by default have a mail registered in shelf and can get reminders,
        log in or perform other actions. Read more about our{" "}
        <Link
          to="https://www.shelf.nu/knowledge-base/user-roles-and-their-permissions"
          target="_blank"
          className="underline"
        >
          permissions here
        </Link>
        .
      </p>

      <ListContentWrapper>
        {/* innerWrapperClassName: the search wrapper defaults to w-full, which
        squeezes the actions slot to leftovers. Content-size it on md+ so the
        three action buttons get the actual free space. */}
        <Filters innerWrapperClassName="md:w-auto">
          <UserRoleFilter />
          {/* Three buttons don't always fit one row: stack them full-width on
          mobile, and let the row wrap on tighter md screens. The container owns
          the spacing and the stretch — children must NOT add their own `mt-*`
          or `w-full`, or the gaps stop being uniform. */}
          <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row md:flex-wrap md:items-center md:justify-end">
            <ImportUsersDialog />
            <InviteUserDialog
              trigger={
                <Button type="button" variant="primary">
                  <span className="whitespace-nowrap">Invite a user</span>
                </Button>
              }
            />
          </div>
        </Filters>

        <List
          className="overflow-x-visible md:overflow-x-auto"
          customEmptyStateContent={{
            title: "No team members yet",
            text: "Invite team members to collaborate on asset management within your workspace.",
          }}
          ItemComponent={UserRow}
          headerChildren={
            <>
              <Th>
                <div className="flex items-center gap-1 [&_svg]:size-[15px]">
                  Custodies{" "}
                  <InfoTooltip content="Custodies count includes only direct asset custodies and doesn't count any assets assigned via bookings." />
                </div>
              </Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>
                <div className="flex items-center gap-1 [&_svg]:size-[15px]">
                  Lab access{" "}
                  <InfoTooltip content="This controls new borrowing only. It does not remove the Student from IOIO Users or block browsing and reports." />
                </div>
              </Th>
              <Th>Actions</Th>
            </>
          }
        />
      </ListContentWrapper>
    </div>
  ) : (
    <Outlet />
  );
}

function UserRoleFilter() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedRole = searchParams.get("role") ?? "all";

  return (
    <label className="flex shrink-0 items-center gap-2 text-sm text-gray-600">
      <span className="whitespace-nowrap">Account type</span>
      <select
        aria-label="Filter users by account type"
        className="border-gray-300 text-sm"
        value={selectedRole}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setSearchParams((previous) => {
            const next = new URLSearchParams(previous);
            if (value === "all") next.delete("role");
            else next.set("role", value);
            next.delete("page");
            return next;
          });
        }}
      >
        <option value="all">All users</option>
        <option value="staff">Staff</option>
        <option value="student">Students</option>
      </select>
    </label>
  );
}

type UserWithBorrowingAccess = TeamMembersWithUserOrInvite & {
  borrowingAccess: {
    state:
      | "ACTIVE"
      | "REVOKED"
      | "EXPIRED"
      | "PENDING"
      | "NONE"
      | "NOT_REQUIRED"
      | "UNAVAILABLE";
    approvalId: string | null;
  } | null;
};

function UserRow({ item }: { item: UserWithBorrowingAccess }) {
  return (
    <>
      <Td className="w-full whitespace-normal p-0 md:p-0">
        {item.status === "ACCEPTED" ? (
          <Link to={`${item.id}/assets`}>
            <TeamMemberDetails details={item} />
          </Link>
        ) : (
          <TeamMemberDetails details={item} />
        )}
      </Td>
      <Td>{item.custodies || 0}</Td>
      <Td>{ioioRoleLabel(item.roleEnum)}</Td>
      <Td>
        <InviteStatusBadge status={item.status} />
      </Td>
      <Td>
        {item.borrowingAccess ? (
          item.borrowingAccess.state === "UNAVAILABLE" ? (
            <span className="text-xs text-gray-500">
              Approval status unavailable
            </span>
          ) : item.borrowingAccess.state === "NOT_REQUIRED" ? (
            <span className="text-xs text-gray-500">Not required</span>
          ) : (
            <div className="flex min-w-36 flex-col items-start gap-1.5">
              <span
                className={tw(
                  "inline-flex rounded-full px-2 py-0.5 text-xs font-semibold",
                  item.borrowingAccess.state === "ACTIVE"
                    ? "bg-success-50 text-success-700"
                    : item.borrowingAccess.state === "PENDING"
                    ? "bg-amber-50 text-amber-800"
                    : "bg-gray-100 text-gray-700"
                )}
              >
                {item.borrowingAccess.state === "ACTIVE"
                  ? "Active"
                  : item.borrowingAccess.state === "PENDING"
                  ? "Pending"
                  : item.borrowingAccess.state === "EXPIRED"
                  ? "Expired"
                  : "No access"}
              </span>
              {item.borrowingAccess.state === "ACTIVE" &&
              item.borrowingAccess.approvalId ? (
                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="revoke-borrowing-access"
                  />
                  <input
                    type="hidden"
                    name="approvalId"
                    value={item.borrowingAccess.approvalId}
                  />
                  <button
                    type="submit"
                    className="text-xs font-semibold text-red-800 underline underline-offset-2 hover:text-red-950"
                  >
                    Revoke access
                  </button>
                </Form>
              ) : (
                <Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="grant-borrowing-access"
                  />
                  <input
                    type="hidden"
                    name="studentUserId"
                    value={item.userId ?? ""}
                  />
                  <button
                    type="submit"
                    className="text-xs font-semibold text-red-800 underline underline-offset-2 hover:text-red-950"
                  >
                    Grant access
                  </button>
                </Form>
              )}
            </div>
          )
        ) : (
          <span className="text-xs text-gray-400">—</span>
        )}
      </Td>
      <Td className="text-right">
        {item.role !== "Owner" ? (
          <TeamUsersActionsDropdown
            inviteStatus={item.status}
            userId={item.userId}
            name={item.name}
            email={item.email} // In this case we can assume that inviteeEmail is defined because we only render this dropdown for existing users
            isSSO={item.sso || false}
            role={item.role}
            roleEnum={item.roleEnum}
          />
        ) : null}
      </Td>
    </>
  );
}

const InviteStatusBadge = ({ status }: { status: InviteStatuses }) => {
  const colorClasses = useMemo(() => {
    switch (status) {
      case "PENDING":
        return "bg-gray-200 text-gray-700";
      case "ACCEPTED":
        return "bg-success-50 text-success-700";
      case "REJECTED":
        return "bg-error-50 text-error-700";
      default:
        return "bg-gray-200 text-gray-700";
    }
  }, [status]);

  return (
    <span
      className={tw(
        "inline-flex justify-center rounded-2xl bg-gray-100 px-2 py-[2px] text-center text-[12px] font-medium text-gray-700",
        colorClasses
      )}
    >
      <span>{status}</span>
    </span>
  );
};

const TeamMemberDetails = ({
  details,
}: {
  details: TeamMembersWithUserOrInvite;
}) => (
  <div className="flex justify-between gap-3 p-4 md:justify-normal md:px-6">
    <div className="flex items-center gap-3">
      <div className="flex size-12 shrink-0 items-center justify-center">
        <img src={details.img} alt="custodian" className="size-10 rounded" />
      </div>
      <div className="min-w-[130px]">
        <span className="word-break mb-1 block font-medium">
          {details.name}
        </span>

        <div>
          {details.email}
          <SSOUserBadge sso={details.sso} userId={details.id} />
        </div>
      </div>
    </div>
  </div>
);
