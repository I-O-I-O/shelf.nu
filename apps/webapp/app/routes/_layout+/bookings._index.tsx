import { BookingStatus, OrganizationRoles, TagUseFor } from "@prisma/client";
import type {
  MetaFunction,
  LoaderFunctionArgs,
  ShouldRevalidateFunction,
} from "react-router";
import {
  data,
  redirect,
  Link,
  Outlet,
  useLoaderData,
  useMatches,
  useRouteLoaderData,
} from "react-router";
import BookingFilters from "~/components/booking/booking-filters";
import BulkActionsDropdown from "~/components/booking/bulk-actions-dropdown";
import CreateBookingDialog from "~/components/booking/create-booking-dialog";
import { ExportBookingsButton } from "~/components/booking/export-bookings-button";
import { IoioLoanFilters } from "~/components/booking/ioio-loan-filters";
import {
  MobileListBookingsContent as IoioMobileLoanContent,
  default as IoioLoanContent,
  STAFF_LOAN_CELL_CLASS,
  STAFF_LOAN_COLUMNS,
  type ListBookingsContentProps as IoioLoanContentProps,
} from "~/components/booking/ioio-staff-loan-content";
import ListBookingsContent from "~/components/booking/list-bookings-content";
import { ErrorContent } from "~/components/errors";

import ContextualModal from "~/components/layout/contextual-modal";
import Header from "~/components/layout/header";
import type { HeaderData } from "~/components/layout/header/types";
import { List } from "~/components/list";
import { ListContentWrapper } from "~/components/list/content-wrapper";
import { Button } from "~/components/shared/button";
import { Th } from "~/components/table";
import { db } from "~/database/db.server";
import { hasGetAllValue } from "~/hooks/use-model-filters";
import { useUserRoleHelper } from "~/hooks/user-user-role-helper";
import { getPhysicalUnitNumberFromTitle } from "~/modules/asset/physical-unit";
import { resolveAssetImagesForPresentation } from "~/modules/asset/service.server";
import { getBookingDateBounds } from "~/modules/booking/date-range";
import { decorateBookingsForList } from "~/modules/booking/list-flags.server";
import {
  custodianScopeClause,
  getBookings,
  getBookingsFilterData,
  resolveCustodianScope,
} from "~/modules/booking/service.server";
import { getPickupLocationDisplay } from "~/modules/ioio-staff/pickup-zone.server";
import { IOIO_STAFF_RESERVATION_DESCRIPTION } from "~/modules/ioio-student/availability.server";
import { getIoioKitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import { setSelectedOrganizationIdCookie } from "~/modules/organization/context.server";
import { TAG_WITH_COLOR_SELECT } from "~/modules/tag/constants";
import {
  getTeamMemberForCustodianFilter,
  getTeamMemberForForm,
  getTeamMembersForNotify,
} from "~/modules/team-member/service.server";
import type { RouteHandleWithName } from "~/modules/types";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { setCookie, userPrefs } from "~/utils/cookies.server";
import { makeShelfError, ShelfError } from "~/utils/error";
import { computeHasActiveFilters } from "~/utils/filter-params";
import { payload, error } from "~/utils/http.server";
import { parseMarkdownToReact } from "~/utils/md";
import { isPersonalOrg } from "~/utils/organization";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export const bookingsSearchFieldTooltipText = `
Search loans by different fields. Separate your keywords by a comma(,) to search with OR condition. Supported fields are:
- Name
- Description
- Asset names
- Asset barcodes or qr code
`;

type BookingRowExtraProps = {
  ioioStaff?: boolean;
  compactStaffLoans?: boolean;
};

function BookingListItem({
  item,
  extraProps,
}: {
  item: IoioLoanContentProps["item"];
  extraProps?: BookingRowExtraProps;
}) {
  return extraProps?.ioioStaff ? (
    <IoioLoanContent
      item={item}
      ioioStaff
      compactStaffLoans={extraProps.compactStaffLoans}
    />
  ) : (
    <ListBookingsContent item={item} />
  );
}

function MobileBookingListItem({
  item,
  extraProps,
}: {
  item: IoioLoanContentProps["item"];
  extraProps?: BookingRowExtraProps;
}) {
  return (
    <IoioMobileLoanContent
      item={item}
      ioioStaff={extraProps?.ioioStaff}
      compactStaffLoans={extraProps?.compactStaffLoans}
    />
  );
}

export type BookingsIndexLoaderData = typeof loader;

function shouldResetSavedBookingFilters(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  // Status links from the IOIO dashboard are deliberate deep links. My Loans
  // and a bare Loans entry start clean instead of inheriting an old filter.
  return !searchParams.has("status");
}

async function getLoanDateYears({
  organizationId,
  mineOnly,
  custodianScope,
}: {
  organizationId: string;
  mineOnly: boolean;
  custodianScope: { userId: string; teamMemberIds: string[] } | null;
}) {
  const rows = await db.booking.findMany({
    where: {
      organizationId,
      status: { notIn: [BookingStatus.ARCHIVED, BookingStatus.CANCELLED] },
      AND: [
        {
          OR: [
            { description: { not: IOIO_STAFF_RESERVATION_DESCRIPTION } },
            { description: null },
          ],
        },
        ...(mineOnly && custodianScope
          ? [custodianScopeClause(custodianScope)]
          : []),
      ],
    },
    select: { from: true },
  });

  return Array.from(
    new Set(
      rows
        .map(({ from }) => (from ? from.getFullYear() : null))
        .filter((year): year is number => year !== null)
    )
  ).sort((left, right) => right - left);
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const {
      organizationId,
      currentOrganization,
      isSelfServiceOrBase,
      canSeeAllBookings,
      canSeeAllCustody,
    } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.booking,
      action: PermissionAction.read,
    });

    if (isPersonalOrg(currentOrganization)) {
      throw new ShelfError({
        cause: null,
        title: "Not allowed",
        message:
          "You cannot use bookings in a personal workspaces. Please create a Team workspace to create bookings.",
        label: "Booking",
        shouldBeCaptured: false,
      });
    }
    const mineOnly = new URL(request.url).searchParams.get("mine") === "1";
    const {
      page,
      perPage,
      search,
      status,
      teamMemberIds,
      orderBy,
      orderDirection,
      selfServiceData,
      searchParams,
      cookie,
      filtersCookie,
      filters,
      redirectNeeded,
      tags: filterTags,
    } = await getBookingsFilterData({
      request,
      canSeeAllBookings,
      organizationId,
      userId,
      ignoreStoredFilters: shouldResetSavedBookingFilters(request),
    });

    // My Loans is a restriction in addition to any search/status filters.
    // The service ANDs both user and legacy team-member links into the query.
    const mineCustodianScope = mineOnly
      ? await resolveCustodianScope({ userId, organizationId })
      : null;
    const hasActiveFilters = computeHasActiveFilters(searchParams);
    const dateBounds = getBookingDateBounds(searchParams.get("dateRange"));

    /** We only do that when we are on the index page */
    if (filters && redirectNeeded) {
      const cookieParams = new URLSearchParams(filters);
      if (mineOnly) cookieParams.set("mine", "1");
      if (searchParams.has("dateRange")) {
        cookieParams.set("dateRange", searchParams.get("dateRange") ?? "");
      }
      return redirect(`/bookings?${cookieParams.toString()}`);
    }

    const [
      { bookings, bookingCount },
      teamMembersData,
      teamMembersForFormData,
      tags,
      notifyData,
      dateYears,
    ] = await Promise.all([
      getBookings({
        organizationId,
        page,
        perPage,
        search,
        userId: userId,
        ...(status && {
          // If status is in the params, we filter based on it
          statuses: [status],
        }),
        custodianTeamMemberIds: teamMemberIds,
        ...selfServiceData,
        // Preserve restricted-user scoping and make My Loans explicit for
        // admins, whose ordinary booking view is organization-wide.
        ...(mineCustodianScope ? { custodianScope: mineCustodianScope } : {}),
        excludeBookingDescriptions: [IOIO_STAFF_RESERVATION_DESCRIPTION],
        fromDateStart: dateBounds?.start,
        fromDateEnd: dateBounds?.end,
        orderBy,
        orderDirection,
        tags: filterTags,
        extraInclude: {
          // Asset count for the row's drawer trigger, now that the pivot rows
          // themselves are no longer loaded.
          _count: { select: { bookingAssets: true } },
          tags: TAG_WITH_COLOR_SELECT,
          // Include outstanding model-level reservations so the
          // assets-sidebar drawer can render the "Unassigned model
          // reservations (N)" section — and so the drawer trigger opens
          // for pure book-by-model bookings (0 concrete assets, N
          // reserved models).
          modelRequests: {
            include: {
              assetModel: {
                select: { id: true, name: true },
              },
            },
          },
          bookingAssets: {
            select: {
              id: true,
              assetId: true,
              sourceKitId: true,
              checkedOutAt: true,
              checkedInAt: true,
              checkedOutQuantity: true,
              quantity: true,
            },
          },
          consumptionLogs: {
            select: { category: true, quantity: true, createdAt: true },
          },
          custodianTeamMember: { include: { user: true } },
        },
        includeAssets: false,
      }),

      // team members for filter dropdown
      getTeamMemberForCustodianFilter({
        organizationId,
        selectedTeamMembers: teamMemberIds,
        getAll:
          searchParams.has("getAll") &&
          hasGetAllValue(searchParams, "teamMember"),
        filterByUserId: !canSeeAllCustody, // If they cant see custody, we dont render the filters anyways, however we still add this for performance reasons so we dont load all team members. This way we only load the current user's team member as that is the only one they can see
        userId,
      }),

      // team members for booking form - BASE/SELF_SERVICE users need their team member guaranteed
      isSelfServiceOrBase
        ? getTeamMemberForForm({
            organizationId,
            userId,
            isSelfServiceOrBase,
            getAll:
              searchParams.has("getAll") &&
              hasGetAllValue(searchParams, "teamMember"),
          })
        : Promise.resolve(null), // ADMIN users reuse teamMembersData

      db.tag.findMany({
        where: {
          organizationId,
          OR: [
            { useFor: { isEmpty: true } },
            { useFor: { has: TagUseFor.BOOKING } },
          ],
        },
        orderBy: { name: "asc" },
      }),
      getTeamMembersForNotify({ organizationId }),
      getLoanDateYears({
        organizationId,
        mineOnly,
        custodianScope: mineCustodianScope,
      }),
    ]);

    const totalPages = Math.ceil(bookingCount / perPage);

    /**
     * The two row pills — amber "Stock conflict" (≥1 over-committed
     * QUANTITY_TRACKED asset in this booking's window) and "Includes
     * unavailable assets" — both need a query the booking row cannot answer.
     * `decorateBookingsForList` runs them concurrently, bounded to the current
     * page's bookings. See `~/modules/booking/list-flags.server`.
     */
    const decoratedBookings = await decorateBookingsForList({
      bookings,
      organizationId,
    });

    const pendingReturnOperations = await db.ioioWriteOperation.findMany({
      where: {
        organizationId,
        operationType: "RETURN_ITEM",
        status: "SUBMITTED",
        bookingId: { not: null },
      },
      select: {
        id: true,
        bookingId: true,
        bookingAssetId: true,
        reportType: true,
      },
    });
    const pendingReturnBookingAssetIds = pendingReturnOperations
      .map((operation) => operation.bookingAssetId)
      .filter((id): id is string => Boolean(id));
    const pendingReturnBookingAssets = pendingReturnBookingAssetIds.length
      ? await db.bookingAsset.findMany({
          where: {
            id: { in: pendingReturnBookingAssetIds },
            booking: { organizationId },
          },
          select: {
            id: true,
            checkedInAt: true,
            asset: { select: { returnHandling: true } },
          },
        })
      : [];
    const pendingReturnBookingAssetById = new Map(
      pendingReturnBookingAssets.map((bookingAsset) => [
        bookingAsset.id,
        bookingAsset,
      ])
    );
    const pendingReturnTasks = pendingReturnOperations.filter((operation) => {
      const bookingAsset = operation.bookingAssetId
        ? pendingReturnBookingAssetById.get(operation.bookingAssetId)
        : null;
      if (bookingAsset?.checkedInAt) return false;
      return (
        operation.reportType !== "RETURN_ITEM" ||
        bookingAsset?.asset.returnHandling === "RETURN_TO_RETURN_ZONE"
      );
    });
    const pendingReturnBookingIds = new Set(
      pendingReturnTasks
        .map(({ bookingId }) => bookingId)
        .filter((bookingId): bookingId is string => Boolean(bookingId))
    );
    const pendingReturnOperationByBookingId = new Map(
      pendingReturnTasks
        .filter(
          (operation): operation is typeof operation & { bookingId: string } =>
            Boolean(operation.bookingId)
        )
        .map((operation) => [operation.bookingId, operation.id])
    );

    const sourceKitIds = Array.from(
      new Set(
        decoratedBookings.flatMap((booking) =>
          (booking.bookingAssets ?? [])
            .map((bookingAsset) => bookingAsset.sourceKitId)
            .filter((id): id is string => Boolean(id))
        )
      )
    );
    const sourceKits = sourceKitIds.length
      ? await db.kit.findMany({
          where: { organizationId, id: { in: sourceKitIds } },
          select: { id: true, name: true },
        })
      : [];
    const sourceKitNameById = new Map(
      sourceKits.map((kit) => [kit.id, getIoioKitDisplayName(kit)])
    );
    const bookingAssetIds = Array.from(
      new Set(
        decoratedBookings.flatMap((booking) =>
          (booking.bookingAssets ?? []).map(
            (bookingAsset) => bookingAsset.assetId
          )
        )
      )
    );
    const rawBookingAssets = bookingAssetIds.length
      ? await db.asset.findMany({
          where: { organizationId, id: { in: bookingAssetIds } },
          select: {
            id: true,
            title: true,
            type: true,
            quantity: true,
            sequentialId: true,
            mainImage: true,
            thumbnailImage: true,
            mainImageStoragePath: true,
            thumbnailImageStoragePath: true,
            assetModel: {
              select: {
                image: true,
                thumbnailImage: true,
                imageStoragePath: true,
                thumbnailImageStoragePath: true,
              },
            },
          },
        })
      : [];
    const resolvedBookingAssets =
      await resolveAssetImagesForPresentation(rawBookingAssets);
    const assetById = new Map(
      resolvedBookingAssets.map((asset) => [asset.id, asset])
    );
    const bookingIds = decoratedBookings.map((booking) => booking.id);
    const readyPreparationOperations = bookingIds.length
      ? await db.ioioWriteOperation.findMany({
          where: {
            organizationId,
            operationType: "IOIO_PREPARATION",
            status: "READY_FOR_PICKUP",
            bookingId: { in: bookingIds },
          },
          select: {
            bookingId: true,
            assetId: true,
            locationId: true,
          },
        })
      : [];
    const readyLocationIds = Array.from(
      new Set(
        readyPreparationOperations
          .map((operation) => operation.locationId)
          .filter((id): id is string => Boolean(id))
      )
    );
    const readyLocations = new Map(
      await Promise.all(
        readyLocationIds.map(async (locationId) => [
          locationId,
          (await getPickupLocationDisplay({ organizationId, locationId }))
            .label,
        ])
      )
    );
    const readyPickupByBookingId = new Map<
      string,
      Array<{ unit: string; location: string | null }>
    >();
    for (const operation of readyPreparationOperations) {
      if (!operation.bookingId) continue;
      const unitAsset = operation.assetId
        ? assetById.get(operation.assetId)
        : null;
      const unitNumber = unitAsset
        ? getPhysicalUnitNumberFromTitle(unitAsset.title)
        : null;
      const entries = readyPickupByBookingId.get(operation.bookingId) ?? [];
      entries.push({
        unit: unitNumber ? `#${unitNumber}` : unitAsset?.title ?? "Assigned",
        location: operation.locationId
          ? readyLocations.get(operation.locationId) ?? null
          : null,
      });
      readyPickupByBookingId.set(operation.bookingId, entries);
    }
    const borrowerUserIds = Array.from(
      new Set(
        decoratedBookings
          .map((booking) => booking.custodianUserId)
          .filter((id): id is string => Boolean(id))
      )
    );
    const borrowerMemberships = borrowerUserIds.length
      ? await db.userOrganization.findMany({
          where: { organizationId, userId: { in: borrowerUserIds } },
          select: { userId: true, roles: true },
        })
      : [];
    const borrowerRoleByUserId = new Map(
      borrowerMemberships.map(({ userId: borrowerId, roles }) => [
        borrowerId,
        roles.includes(OrganizationRoles.ADMIN) ||
        roles.includes(OrganizationRoles.OWNER)
          ? ("Staff" as const)
          : roles.includes(OrganizationRoles.SELF_SERVICE)
          ? ("Student" as const)
          : null,
      ])
    );
    const bookingsWithReturnState = decoratedBookings.map((booking) => ({
      ...booking,
      bookingAssets: booking.bookingAssets?.map((bookingAsset) => {
        const asset = assetById.get(bookingAsset.assetId);
        return {
          ...bookingAsset,
          asset: asset
            ? {
                ...asset,
                logicalProductName: bookingAsset.sourceKitId
                  ? sourceKitNameById.get(bookingAsset.sourceKitId) ?? null
                  : null,
              }
            : null,
        };
      }),
      borrowerRole: booking.custodianUserId
        ? borrowerRoleByUserId.get(booking.custodianUserId) ?? null
        : null,
      hasPendingIoioReturn: pendingReturnBookingIds.has(booking.id),
      readyForPickup: readyPickupByBookingId.get(booking.id) ?? [],
      pendingIoioReturnOperationId: pendingReturnOperationByBookingId.get(
        booking.id
      ),
    }));

    const header: HeaderData = {
      title: mineOnly
        ? `My Loans - ${bookingCount}`
        : `Loans - ${bookingCount}`,
    };
    const modelName = mineOnly
      ? { singular: "loan", plural: "loans" }
      : { singular: "booking", plural: "bookings" };

    return data(
      payload({
        header,
        currentOrganization,
        items: bookingsWithReturnState,
        search,
        page,
        totalItems: bookingCount,
        totalPages,
        perPage,
        modelName,
        hasActiveFilters,
        mineOnly,
        dateYears,
        ...teamMembersData,
        // For BASE/SELF_SERVICE users, provide dedicated form team members
        // For ADMIN users, reuse the filter team members
        teamMembersForForm:
          teamMembersForFormData?.teamMembers ?? teamMembersData.teamMembers,
        isSelfServiceOrBase,
        ...notifyData,
        tags,
        totalTags: tags.length,
        searchFieldTooltip: {
          title: mineOnly ? "Search your loans" : "Search your bookings",
          text: parseMarkdownToReact(bookingsSearchFieldTooltipText),
        },
      }),
      {
        headers: [
          setCookie(await userPrefs.serialize(cookie)),
          setCookie(await setSelectedOrganizationIdCookie(organizationId)),
          ...(filtersCookie ? [setCookie(filtersCookie)] : []),
        ],
      }
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: data ? appendToMetaTitle(data.header.title) : "" },
];

export const handle = {
  name: "bookings.index",
  breadcrumb: () => <Link to="/bookings">Loans</Link>,
};

export const shouldRevalidate: ShouldRevalidateFunction = ({
  actionResult,
  nextUrl,
  defaultShouldRevalidate,
}) => {
  /** Don't revalidate on manage-assets route */
  const isManageAssetsRoute = nextUrl.pathname.includes("manage-assets");

  if (isManageAssetsRoute || actionResult?.isTogglingSidebar) {
    return false;
  }
  return defaultShouldRevalidate;
};

export default function BookingsIndexPage({
  className,
  disableBulkActions = false,
}: {
  className?: string;
  disableBulkActions?: boolean;
}) {
  const matches = useMatches();
  const { isBaseOrSelfService } = useUserRoleHelper();
  const { mineOnly = false, dateYears = [] } = useLoaderData<typeof loader>();
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );

  const currentRoute: RouteHandleWithName = matches[matches.length - 1];

  /**
   * We have 4 cases when we should render index:
   * 1. When we are on the index route
   * 2. When we are on the .new route - the reason we do this is because we want to have the .new modal overlaying the index.
   * 3. When we are on the assets.$assetId.bookings page
   * 4. When we are on the settings.team.users.$userId.bookings
   */

  const allowedRoutes = [
    "bookings.index",
    "bookings.new",
    "$assetId.bookings",
    "$userId.bookings",
    "bookings.update-existing",
    "me.bookings",
    "$kitId.bookings",
  ];

  const shouldRenderIndex = allowedRoutes.includes(currentRoute?.handle?.name);

  /** A bookings page that is a child of another nested layout */
  const isChildBookingsPage = [
    "$assetId.bookings",
    "$userId.bookings",
    "me.bookings",
    "$kitId.bookings",
  ].includes(currentRoute?.handle?.name);

  const isBookingUpdateExisting =
    currentRoute?.handle?.name === "bookings.update-existing";
  const isIoioStaffLoans =
    layoutData?.isIoioStaff === true &&
    currentRoute?.handle?.name === "bookings.index";
  const loanRowExtraProps = {
    ioioStaff: layoutData?.isIoioStaff === true,
    compactStaffLoans: isIoioStaffLoans,
  };

  return shouldRenderIndex ? (
    //when we are clicking on book actions dropdown. it is picking styles from global scope. to bypass that adding this wrapper.(dailog styles)
    <div
      className={`${
        isBookingUpdateExisting ? "booking-update-existing-wrapper" : ""
      }`}
    >
      {!isChildBookingsPage ? (
        <Header hideQuickFind={isIoioStaffLoans}>
          {!mineOnly && !isIoioStaffLoans ? (
            <CreateBookingDialog
              trigger={
                <Button
                  type="button"
                  aria-label="new booking"
                  data-test-id="createNewBooking"
                  prefetch="none"
                >
                  New booking
                </Button>
              }
            />
          ) : null}
        </Header>
      ) : null}
      <ListContentWrapper className={className}>
        {mineOnly ? (
          <div
            className="mb-3 flex items-center gap-2 text-sm"
            aria-label="My Loans view"
          >
            <Link
              to="/bookings"
              className="font-semibold text-red-700 hover:text-red-800 hover:underline"
            >
              Loans
            </Link>
            <span aria-hidden="true" className="text-gray-400">
              /
            </span>
            <span className="font-semibold text-gray-700">My Loans</span>
          </div>
        ) : (
          <></>
        )}
        {isIoioStaffLoans ? (
          <IoioLoanFilters
            dateYears={dateYears}
            actions={mineOnly ? null : <ExportBookingsButton />}
          />
        ) : (
          <BookingFilters />
        )}

        <List
          bulkActions={
            disableBulkActions ||
            isIoioStaffLoans ||
            isBaseOrSelfService ||
            mineOnly ? undefined : (
              <BulkActionsDropdown />
            )
          }
          customEmptyStateContent={{
            title: mineOnly ? "No matching loans" : "No loans yet",
            text: mineOnly
              ? "Loans assigned to you will appear here."
              : isIoioStaffLoans
              ? "No active loans match the current filters."
              : "Loans let your team reserve assets for specific dates. Create a booking to schedule equipment checkouts and returns.",
            newButtonRoute:
              mineOnly || isIoioStaffLoans ? undefined : "/bookings/new",
            newButtonContent: mineOnly
              ? undefined
              : isIoioStaffLoans
              ? undefined
              : "Create your first loan",
          }}
          ItemComponent={
            isIoioStaffLoans ? BookingListItem : ListBookingsContent
          }
          MobileItemComponent={
            isIoioStaffLoans ? MobileBookingListItem : undefined
          }
          extraItemComponentProps={loanRowExtraProps}
          hideListTitle={isIoioStaffLoans}
          hideFirstHeaderColumn={isIoioStaffLoans}
          tableClassName={isIoioStaffLoans ? "table-fixed" : undefined}
          disableTableOverflowGradient={isIoioStaffLoans}
          headerChildren={
            isIoioStaffLoans ? (
              <>
                <Th
                  className={`${STAFF_LOAN_COLUMNS.item} ${STAFF_LOAN_CELL_CLASS}`}
                >
                  Item
                </Th>
                <Th
                  className={`${STAFF_LOAN_COLUMNS.borrower} ${STAFF_LOAN_CELL_CLASS}`}
                >
                  Borrower
                </Th>
                <Th
                  className={`${STAFF_LOAN_COLUMNS.status} ${STAFF_LOAN_CELL_CLASS}`}
                >
                  Status
                </Th>
                <Th
                  className={`${STAFF_LOAN_COLUMNS.period} ${STAFF_LOAN_CELL_CLASS}`}
                >
                  Loan period
                </Th>
                <Th
                  className={`${STAFF_LOAN_COLUMNS.actions} ${STAFF_LOAN_CELL_CLASS} whitespace-nowrap text-center`}
                >
                  Actions
                </Th>
              </>
            ) : (
              <>
                <Th />
                <Th>Assets</Th>
                <Th>Description</Th>
                <Th>From</Th>
                <Th>To</Th>
                <Th>Tags</Th>
                <Th>Custodian</Th>
                <Th>Created by</Th>
              </>
            )
          }
          headerExtraContent={
            isIoioStaffLoans ? null : <ExportBookingsButton />
          }
        />
      </ListContentWrapper>
      <ContextualModal />
    </div>
  ) : (
    <Outlet />
  );
}

export const ErrorBoundary = () => <ErrorContent />;
