import { useState, useRef, useMemo } from "react";
import dayGridPlugin from "@fullcalendar/daygrid";
import listPlugin from "@fullcalendar/list";
// Named-timezone support for FullCalendar. v6 only understands "local"/"UTC"
// out of the box; a named IANA `timeZone` (e.g. "Asia/Tokyo") silently falls
// back to UTC — rendering every non-UTC user's events at the wrong local time —
// UNLESS this Luxon connector is registered in the plugins array below. luxon
// is already a project dependency, so this connector is lightweight.
import luxonPlugin from "@fullcalendar/luxon3";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import { type BookingStatus, type Tag } from "@prisma/client";
import { Plus } from "lucide-react";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { data, Link, Outlet, useLoaderData, useLocation } from "react-router";
import { ClientOnly } from "remix-utils/client-only";
import { CalendarNavigation } from "~/components/calendar/calendar-navigation";
import renderEventCard from "~/components/calendar/event-card";
import { IoioCalendarFilters } from "~/components/calendar/ioio-calendar-filters";
import TitleContainer from "~/components/calendar/title-container";
import { ViewButtonGroup } from "~/components/calendar/view-button-group";
import FallbackLoading from "~/components/dashboard/fallback-loading";
import { ErrorContent } from "~/components/errors";
import Header from "~/components/layout/header";
import { Spinner } from "~/components/shared/spinner";
import type { TeamMemberForBadge } from "~/components/user/team-member-badge";
import { useSearchParams } from "~/hooks/search-params";
import { useDateFormatter } from "~/hooks/use-date-formatter";
import { useDisabled } from "~/hooks/use-disabled";
import { useViewportHeight } from "~/hooks/use-viewport-height";
import { getBookingsForCalendar } from "~/modules/booking/service.server";
import { IOIO_STAFF_RESERVATION_DESCRIPTION } from "~/modules/ioio-student/availability.server";
import calendarStyles from "~/styles/layout/calendar.css?url";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import {
  getCalendarTitleAndSubtitle,
  getStatusClasses,
  handleEventClick,
  handleEventMouseEnter,
  handleEventMouseLeave,
  isOneDayEvent,
} from "~/utils/calendar";
import { getWeekStartingAndEndingDates } from "~/utils/date-fns";
import { makeShelfError, ShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import { isPersonalOrg } from "~/utils/organization";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export function links() {
  return [{ rel: "stylesheet", href: calendarStyles }];
}

export const handle = {
  breadcrumb: () => <Link to="/calendar">Calendar</Link>,
};

/** One folded BookingAsset pivot slice on a collapsed availability bar.
 * `assetKitId === null` ⇒ standalone (free pool); non-null ⇒ kit-driven.
 * `quantity` is booked units (BookingAsset.quantity). Availability view only.
 *
 * why: out of this rule — no `sourceKitId` fallback for detached kit residue.
 * This view is asset-centric (one bar per booking of ONE asset) rather than a
 * grouping of a booking's rows by kit, so `kitName` is a per-slice annotation,
 * not the structure a snapshot would restore. */
export type AvailabilitySlice = {
  assetKitId: string | null;
  kitName: string | null;
  quantity: number;
};

export type CalendarExtendedProps = {
  id: string;
  status: BookingStatus;
  name: string;
  description: string | null;
  start: string;
  end: string;
  custodian: TeamMemberForBadge;
  creator: TeamMemberForBadge;
  tags: Pick<Tag, "id" | "name">[];
  /** Availability view only: per-slice breakdown of one (asset, booking).
   * Absent on the booking calendar (which never sets it). */
  slices?: AvailabilitySlice[];
  /** Number of folded slices (>1 ⇒ show glyph count on the bar). */
  sliceCount?: number;
  /** Sum of BookingAsset.quantity across folded slices (booked-units total). */
  bookedTotal?: number;
  /** True only for QUANTITY_TRACKED assets. INDIVIDUAL assets are single
   * physical units (always qty 1), so the calendar hides the per-slice `Qty`
   * and the booked-units total for them — the number is redundant noise. */
  quantityTracked?: boolean;
  /** Availability view only: true when every folded slice of this asset has
   * been checked in from the booking. The bar then ends at `returnedAt` and
   * is styled as complete, while `status` keeps the booking's real status
   * for the popover badge. Absent on the booking calendar. */
  returned?: boolean;
  /** Availability view only: ISO instant of the latest check-in among the
   * folded slices; null unless `returned`. */
  returnedAt?: string | null;
  /** Calendar-only label details for IOIO staff reservations. */
  assetNames?: string[];
  isIoioReservation?: boolean;
};

// Loader Function to Return Bookings Data
export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const {
      currentOrganization,
      organizationId,
      canSeeAllBookings,
      canSeeAllCustody,
      role,
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
        status: 403,
        shouldBeCaptured: false,
      });
    }

    const header = {
      title: `Calendar`,
    };

    const allEvents = await getBookingsForCalendar({
      request,
      organizationId,
      userId,
      canSeeAllBookings,
      canSeeAllCustody,
    });

    // IOIO Calendar is the staff reservation planner. Generic Shelf loans
    // remain available from Loans and should not be mixed into this view.
    const events = allEvents
      .filter(
        (event) =>
          event.extendedProps?.description ===
          IOIO_STAFF_RESERVATION_DESCRIPTION
      )
      .map((event) => {
        const details = event.extendedProps;
        if (!details) return event;

        return {
          ...event,
          title: [
            ...(details.assetNames ?? []),
            details.name,
            details.creator.name,
          ]
            .filter(Boolean)
            .join(" - "),
          extendedProps: {
            ...details,
            isIoioReservation: true,
            url: `/calendar/new-reservation?bookingId=${encodeURIComponent(
              details.id
            )}`,
          },
        };
      });

    const modelName = {
      singular: "booking",
      plural: "bookings",
    };

    return payload({
      header,
      events,
      canManageIoioReservations: role === "ADMIN" || role === "OWNER",
      search: "",
      modelName,
    });
  } catch (cause) {
    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
};
export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.header.title) },
];

// Calendar Component
export default function Calendar() {
  const location = useLocation();
  return location.pathname === "/calendar" ? <CalendarPage /> : <Outlet />;
}

function CalendarPage() {
  const { isMd } = useViewportHeight();
  const { prefs } = useDateFormatter();
  // Drive FullCalendar's clock (12h vs 24h) from the user's time-format pref.
  const hour12 = prefs.timeFormat === "H12";
  const [startingDay, endingDay] = getWeekStartingAndEndingDates(
    new Date(),
    prefs
  );
  const [searchParams, setSearchParams] = useSearchParams();
  const [isInitialLoad, setIsInitialLoad] = useState(true);
  const { events, canManageIoioReservations } = useLoaderData<typeof loader>();
  const isLoading = useDisabled();
  const [calendarHeader, setCalendarHeader] = useState<{
    title?: string;
    subtitle?: string;
  }>({
    title: "",
    subtitle: isMd ? undefined : `${startingDay} - ${endingDay}`,
  });

  const [calendarView, setCalendarView] = useState(
    isMd ? "dayGridMonth" : "listWeek"
  );

  // Get initial date from URL params if available
  const initialDate = useMemo(() => {
    const startParam = searchParams.get("start");
    if (startParam) {
      const parsedDate = new Date(startParam);
      if (!Number.isNaN(parsedDate.getTime())) return parsedDate;
    }
    return new Date(); // Default to current date
  }, [searchParams]);

  const calendarRef = useRef<FullCalendar>(null);

  function updateTitle(viewType = calendarView) {
    const calendarApi = calendarRef.current?.getApi();
    if (calendarApi) {
      setCalendarHeader(
        getCalendarTitleAndSubtitle({ viewType, calendarApi, prefs })
      );
    }
  }

  const handleWindowResize = () => {
    const calendar = calendarRef?.current?.getApi();
    if (calendar) {
      calendar.changeView(isMd ? calendarView : "listWeek");
    }
  };

  const handleViewChange = (view: string) => {
    setCalendarView(view);
    const calendarApi = calendarRef.current?.getApi();
    calendarApi?.changeView(view);
    updateTitle(view);
  };

  const updateViewClasses = (
    calendarContainer: HTMLElement | null,
    viewType: string
  ) => {
    if (!calendarContainer) return;
    calendarContainer.classList.remove("month-view", "week-view", "day-view");
    if (viewType === "dayGridMonth") {
      calendarContainer.classList.add("month-view");
    } else if (viewType === "timeGridWeek") {
      calendarContainer.classList.add("week-view");
    } else if (viewType === "timeGridDay") {
      calendarContainer.classList.add("day-view");
    }
  };

  return (
    <>
      <Header subHeading="Plan upcoming equipment reservations.">
        {canManageIoioReservations ? (
          <Link
            to="/calendar/new-reservation"
            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-red-700 px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
          >
            <Plus className="size-4 shrink-0" aria-hidden="true" />
            New reservation
          </Link>
        ) : null}
      </Header>

      <IoioCalendarFilters className="mt-4" />

      <div className="mt-5 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 bg-gray-50/70 p-3 sm:px-4">
          <div className="flex items-center gap-2">
            <TitleContainer
              calendarTitle={calendarHeader.title}
              calendarSubtitle={calendarHeader.subtitle}
              calendarView={calendarView}
            />
            {isLoading && (
              <div className="mr-3 flex justify-center">
                <Spinner />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <CalendarNavigation
              calendarRef={calendarRef}
              updateTitle={() => updateTitle(calendarView)}
            />

            {isMd ? (
              <ViewButtonGroup
                views={[
                  { label: "Month", value: "dayGridMonth" },
                  { label: "Week", value: "timeGridWeek" },
                  { label: "Day", value: "timeGridDay" },
                ]}
                currentView={calendarView}
                onViewChange={handleViewChange}
                size="xs"
                activeClassName="!border-red-700 !bg-red-700 !text-white"
                className="rounded-lg border border-gray-200 bg-white [&>button]:!h-9 [&>button]:!py-0"
              />
            ) : null}
          </div>
        </div>
        <div className="ioio-calendar-shell">
          <ClientOnly fallback={<FallbackLoading className="size-[150px]" />}>
            {() => (
              <FullCalendar
                ref={calendarRef}
                // luxonPlugin registers named-IANA-timezone resolution so
                // `timeZone={prefs.timeZone}` below renders events in the user's
                // chosen zone instead of falling back to UTC (see import note).
                plugins={[
                  dayGridPlugin,
                  listPlugin,
                  timeGridPlugin,
                  luxonPlugin,
                ]}
                initialView={calendarView}
                initialDate={initialDate}
                expandRows={true}
                height="auto"
                // Week start, display timezone, and 12/24h clock all follow the
                // acting user's resolved formatting prefs (see useDateFormatter).
                firstDay={prefs.weekStartsOn}
                timeZone={prefs.timeZone}
                nowIndicator
                headerToolbar={false}
                events={events}
                slotEventOverlap={true}
                dayMaxEvents={3}
                dayMaxEventRows={4}
                moreLinkClick="popover"
                eventMouseEnter={handleEventMouseEnter("dayGridMonth")}
                eventMouseLeave={handleEventMouseLeave("dayGridMonth")}
                eventClick={handleEventClick}
                windowResize={handleWindowResize}
                eventContent={renderEventCard}
                eventTimeFormat={{
                  hour: "numeric",
                  minute: "2-digit",
                  meridiem: "short",
                  hour12,
                }}
                // Slot labels (timeGrid Week/Day axis) also honor the 12/24h pref.
                slotLabelFormat={{
                  hour: "numeric",
                  minute: "2-digit",
                  omitZeroMinute: true,
                  meridiem: "short",
                  hour12,
                }}
                viewDidMount={(args) => {
                  const calendarContainer = args.el;
                  const viewType = args.view.type;
                  updateViewClasses(calendarContainer, viewType);
                  updateTitle(viewType);
                }}
                datesSet={(args) => {
                  const calendarContainer =
                    document.querySelector<HTMLElement>(".fc");
                  const viewType = args.view.type;

                  updateViewClasses(calendarContainer, viewType);

                  // Only update URL params after initial load
                  if (!isInitialLoad) {
                    setSearchParams((prev) => {
                      const newParams = new URLSearchParams(prev);
                      newParams.set("start", args.start.toISOString());
                      newParams.set("end", args.end.toISOString());
                      return newParams;
                    });
                  } else {
                    setIsInitialLoad(false);
                  }
                }}
                eventClassNames={(eventInfo) => {
                  const viewType = eventInfo.view.type;
                  const isOneDay = isOneDayEvent(
                    eventInfo.event.start,
                    eventInfo.event.end
                  );
                  return getStatusClasses(
                    eventInfo.event.extendedProps.status,
                    isOneDay,
                    viewType
                  );
                }}
              />
            )}
          </ClientOnly>
        </div>
      </div>
    </>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
