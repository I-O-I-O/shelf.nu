import { useEffect, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  ClipboardList,
  CalendarDays,
  GripVertical,
  Home,
  MapPin,
  PackageOpen,
  Archive,
  Settings,
  Tags,
  Trash2,
  ShoppingBasket,
} from "lucide-react";
import {
  Form,
  Link,
  NavLink,
  Outlet,
  useLocation,
  useRouteLoaderData,
} from "react-router";
import {
  MobileBottomNavigation,
  MobileIoioHeader,
  type MobileNavigationItem,
} from "~/components/ioio-shared/mobile-navigation";
import { IoioPageContainer } from "~/components/ioio-shared/page-container";
import { StaffLabStatusBell } from "~/components/ioio-staff/lab-status";
import { StaffLogo } from "~/components/ioio-staff/staff-logo";
import { StudentCheckoutProvider } from "~/components/ioio-student/checkout-context";
import { StudentBorrowListIndicator } from "~/components/ioio-student/student-shell";
import {
  getStaffNavigationStorageKey,
  readStaffNavigationOrder,
  saveStaffNavigationOrder,
} from "~/modules/ioio-staff/navigation-preferences";
import { getMyLoansPath } from "~/modules/ioio-student/my-loans-navigation";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";

export const STAFF_NAVIGATION = [
  { to: "/home", label: "Dashboard", Icon: Home, end: true, group: "Home" },
  {
    to: "/handbook",
    label: "Handbook",
    Icon: ClipboardList,
    end: false,
    group: "Browse",
  },
  {
    to: "/assets",
    label: "Inventory",
    Icon: PackageOpen,
    end: false,
    group: "Browse",
  },
  {
    to: "/categories",
    label: "Categories",
    Icon: Tags,
    end: false,
    group: "Browse",
  },
  {
    to: "/locations",
    label: "Locations",
    Icon: MapPin,
    end: false,
    group: "Browse",
  },
  {
    to: "/bookings",
    label: "Loans",
    Icon: ClipboardList,
    end: false,
    group: "Loans",
  },
  {
    to: "/calendar",
    label: "Calendar",
    Icon: CalendarDays,
    end: true,
    group: "Loans",
  },
  {
    to: "/reports",
    label: "Analytics",
    Icon: BarChart3,
    end: false,
    group: "Reports",
  },
  {
    to: "/settings",
    label: "Settings",
    Icon: Settings,
    end: false,
    group: "Account",
  },
  {
    to: "/staff/archived",
    label: "Archive",
    Icon: Archive,
    end: true,
    group: "Records",
  },
  {
    to: "/staff/trash",
    label: "Trash",
    Icon: Trash2,
    end: true,
    group: "Records",
  },
] as const;

export const STAFF_LOAN_NAVIGATION = [
  {
    to: getMyLoansPath("staff"),
    label: "My Loans",
    Icon: ClipboardList,
    end: false,
    group: "Loans",
  },
] as const;

const mobilePrimaryItems: MobileNavigationItem[] = [
  { to: "/home", label: "Home", Icon: Home, end: true },
  { to: "/assets", label: "Assets", Icon: PackageOpen },
  { to: "/ioio/checkout", label: "Checkout", Icon: ShoppingBasket },
];

export function getStaffMobileMoreItems(
  navigationOrder: readonly string[],
  canViewLabTasks: boolean
): MobileNavigationItem[] {
  const primaryDestinations = new Set([
    mobilePrimaryItems[0].to,
    mobilePrimaryItems[1].to,
  ]);

  return navigationOrder.flatMap((to) => {
    const item = STAFF_NAVIGATION.find((candidate) => candidate.to === to);
    if (
      !item ||
      primaryDestinations.has(item.to) ||
      !canViewStaffNavigationItem(item.to, canViewLabTasks)
    ) {
      return [];
    }

    const destination: MobileNavigationItem = {
      to: item.to,
      label: item.label,
      Icon: item.Icon,
      end: item.end,
      group: item.group,
    };
    if (item.to !== "/bookings") return [destination];

    return [
      destination,
      ...STAFF_LOAN_NAVIGATION.map((nestedItem) => ({
        to: nestedItem.to,
        label: nestedItem.label,
        Icon: nestedItem.Icon,
        end: nestedItem.end,
        group: nestedItem.group,
      })),
    ];
  });
}

export const DEFAULT_STAFF_NAVIGATION_ORDER = STAFF_NAVIGATION.map(
  ({ to }) => to
);
type NavigationItem = (typeof STAFF_NAVIGATION)[number];

function canViewStaffNavigationItem(path: string, canViewLabTasks: boolean) {
  return path !== "/operations/tasks" || canViewLabTasks;
}

export function StaffNavigation({
  onNavigate,
  navigationOrder,
  onReorder,
  canViewLabTasks,
}: {
  onNavigate?: () => void;
  navigationOrder: readonly string[];
  onReorder: (dragged: string, target: string) => void;
  canViewLabTasks: boolean;
}) {
  const location = useLocation();
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [loansExpanded, setLoansExpanded] = useState(
    () =>
      location.pathname.startsWith("/bookings") ||
      location.pathname === "/ioio/loans"
  );
  useEffect(() => {
    if (
      location.pathname.startsWith("/bookings") ||
      location.pathname === "/ioio/loans"
    ) {
      setLoansExpanded(true);
    }
  }, [location.pathname]);
  const orderedNavigation = navigationOrder
    .map((to) => STAFF_NAVIGATION.find((item) => item.to === to))
    .filter((item): item is NavigationItem => Boolean(item))
    .filter((item) => canViewStaffNavigationItem(item.to, canViewLabTasks));
  const activePath = STAFF_NAVIGATION.filter(({ to, end }) => {
    const [pathname, query] = to.split("?");
    const pathMatches = end
      ? location.pathname === pathname
      : location.pathname === pathname ||
        location.pathname.startsWith(`${pathname}/`);
    const mineQuery = new URLSearchParams(location.search).get("mine");
    const isBookingList = to === "/bookings" && location.pathname === pathname;
    const queryMatches = query
      ? mineQuery === "1"
      : !isBookingList || mineQuery !== "1";
    return pathMatches && queryMatches;
  }).sort((left, right) => right.to.length - left.to.length)[0]?.to;
  const activeLoanSubnavigation = STAFF_LOAN_NAVIGATION.find(
    (item) => item.to === location.pathname
  );

  return (
    <nav aria-label="IOIO staff navigation" className="space-y-0.5">
      {orderedNavigation.map(({ to, label, Icon, end }) => {
        const active = activePath === to;

        if (to === "/bookings") {
          return (
            <div key={to} className="space-y-0.5">
              <div className="flex min-w-0 items-center gap-1">
                <Link
                  to="/bookings"
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  draggable
                  title="Click to open. Drag and hold to place this section underneath another section."
                  onDragStart={(event) => {
                    setDraggedPath(to);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", to);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source =
                      draggedPath ?? event.dataTransfer.getData("text/plain");
                    if (source && source !== to) onReorder(source, to);
                    setDraggedPath(null);
                  }}
                  onDragEnd={() => setDraggedPath(null)}
                  className={`flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-1 md:min-h-9 ${
                    active
                      ? "bg-red-50 text-red-800"
                      : "text-gray-700 hover:bg-red-50 hover:text-red-800"
                  } ${draggedPath === to ? "opacity-50" : ""}`}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <GripVertical
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-gray-300"
                  />
                </Link>
                <button
                  type="button"
                  aria-label={`${loansExpanded ? "Collapse" : "Expand"} Loans`}
                  aria-expanded={loansExpanded}
                  onClick={() => setLoansExpanded((expanded) => !expanded)}
                  className="rounded-lg p-2 text-gray-500 hover:bg-red-50 hover:text-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700"
                >
                  <ChevronDown
                    aria-hidden="true"
                    className={`size-4 transition-transform ${
                      loansExpanded ? "rotate-180" : ""
                    }`}
                  />
                </button>
              </div>
              {loansExpanded ? (
                <div className="ml-7 space-y-0.5 border-l border-red-100 pl-2">
                  {STAFF_LOAN_NAVIGATION.map((item) => {
                    const isActive = activeLoanSubnavigation?.to === item.to;
                    return (
                      <Link
                        key={item.to}
                        to={item.to}
                        aria-current={isActive ? "page" : undefined}
                        onClick={onNavigate}
                        className={`block min-h-11 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-1 md:min-h-9 md:py-1.5 ${
                          isActive
                            ? "bg-red-50 text-red-800"
                            : "text-gray-600 hover:bg-red-50 hover:text-red-800"
                        }`}
                      >
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        }

        return (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            draggable
            title="Click to open. Drag and hold to place this section underneath another section."
            onDragStart={(event) => {
              setDraggedPath(to);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", to);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const source =
                draggedPath ?? event.dataTransfer.getData("text/plain");
              if (source && source !== to) onReorder(source, to);
              setDraggedPath(null);
            }}
            onDragEnd={() => setDraggedPath(null)}
            className={`flex min-h-11 min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-1 md:min-h-9 ${
              active
                ? "bg-red-50 text-red-800"
                : "text-gray-700 hover:bg-red-50 hover:text-red-800"
            } ${draggedPath === to ? "opacity-50" : ""}`}
          >
            <Icon aria-hidden="true" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <GripVertical
              aria-hidden="true"
              className="size-3.5 shrink-0 text-gray-300"
            />
          </NavLink>
        );
      })}
    </nav>
  );
}

function StaffAccountControls({
  onNavigate,
  compact = false,
}: {
  onNavigate?: () => void;
  compact?: boolean;
}) {
  return (
    <section
      aria-label="Staff account"
      className={
        compact
          ? "mt-2 border-t border-gray-100 pt-2"
          : "mt-3 border-t border-gray-100 pt-3"
      }
    >
      <p className="px-3 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-gray-400">
        Signed in
      </p>
      <p className="px-3 pt-1 text-sm font-semibold text-gray-700">Staff</p>
      <Form
        method="post"
        action="/logout"
        onSubmit={onNavigate}
        className={compact ? "mt-1" : "mt-1.5"}
      >
        <button
          type="submit"
          aria-label="Log out of IOIO Lab Shelf"
          className={`w-full rounded-lg border border-gray-200 px-3 py-1.5 text-left text-sm font-semibold text-gray-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 ${
            compact ? "min-h-11" : ""
          }`}
        >
          Log out
        </button>
      </Form>
    </section>
  );
}

export default function StaffShell() {
  const location = useLocation();
  const isLabelGeneratorRoute = location.pathname === "/labels";
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );
  const navigationStorageKey =
    layoutData?.user?.id && layoutData.currentOrganizationId
      ? getStaffNavigationStorageKey(
          layoutData.user.id,
          layoutData.currentOrganizationId
        )
      : null;
  const [savedNavigation, setSavedNavigation] = useState<{
    storageKey: string | null;
    order: readonly string[];
    loaded: boolean;
  }>(() => ({
    storageKey: navigationStorageKey,
    order: DEFAULT_STAFF_NAVIGATION_ORDER,
    loaded: navigationStorageKey === null,
  }));
  const navigationOrder =
    savedNavigation.storageKey === navigationStorageKey
      ? savedNavigation.order
      : DEFAULT_STAFF_NAVIGATION_ORDER;

  useEffect(() => {
    if (!navigationStorageKey) {
      setSavedNavigation({
        storageKey: null,
        order: DEFAULT_STAFF_NAVIGATION_ORDER,
        loaded: true,
      });
      return;
    }

    setSavedNavigation({
      storageKey: navigationStorageKey,
      order: readStaffNavigationOrder(
        navigationStorageKey,
        DEFAULT_STAFF_NAVIGATION_ORDER
      ),
      loaded: true,
    });
  }, [navigationStorageKey]);

  useEffect(() => {
    if (
      !navigationStorageKey ||
      !savedNavigation.loaded ||
      savedNavigation.storageKey !== navigationStorageKey
    ) {
      return;
    }

    saveStaffNavigationOrder(navigationStorageKey, savedNavigation.order);
  }, [navigationStorageKey, savedNavigation]);

  function reorderNavigation(dragged: string, target: string) {
    setSavedNavigation((currentSaved) => {
      const current =
        currentSaved.storageKey === navigationStorageKey
          ? currentSaved.order
          : DEFAULT_STAFF_NAVIGATION_ORDER;
      const next = [...current];
      const fromIndex = next.indexOf(dragged);
      if (fromIndex < 0 || next.indexOf(target) < 0) return currentSaved;
      next.splice(fromIndex, 1);
      next.splice(next.indexOf(target) + 1, 0, dragged);
      return {
        storageKey: navigationStorageKey,
        order: next,
        loaded: true,
      };
    });
  }

  const canViewLabTasks = Boolean(layoutData?.isIoioStaff);
  const labStatus = layoutData?.labStatus ?? null;

  return (
    <StudentCheckoutProvider>
      <div
        className={`ioio-staff-surface min-h-full w-full min-w-0 max-w-full overflow-x-clip bg-white text-gray-950 md:-mx-4 ${
          isLabelGeneratorRoute ? "ioio-label-route-surface" : ""
        }`}
      >
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-red-100 bg-white p-3 md:flex">
          <div className="flex items-center gap-2">
            <Link
              to="/home"
              aria-label="IOIO Lab staff dashboard"
              className="flex min-w-0 flex-1 items-center justify-center rounded-xl bg-red-800 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
            >
              <StaffLogo />
            </Link>
          </div>
          <p className="px-2 py-3 text-xs font-bold uppercase tracking-[0.16em] text-gray-400">
            Staff desk
          </p>
          <div className="flex-1 overflow-y-auto">
            <StaffNavigation
              navigationOrder={navigationOrder}
              onReorder={reorderNavigation}
              canViewLabTasks={canViewLabTasks}
            />
          </div>
          <StaffAccountControls />
        </aside>

        <div className="md:pl-60">
          <MobileIoioHeader
            homeHref="/home"
            notifications={
              <StaffLabStatusBell
                mobile
                status={labStatus}
                readStateKey={
                  layoutData?.user?.id && layoutData.currentOrganizationId
                    ? `ioio-staff-lab-status-seen:${layoutData.currentOrganizationId}:${layoutData.user.id}`
                    : undefined
                }
              />
            }
            basket={<StudentBorrowListIndicator showLabel />}
          />

          <header className="sticky top-0 z-20 hidden bg-white md:block">
            <div className="flex items-center justify-end gap-3 p-4">
              <StaffLabStatusBell
                status={labStatus}
                readStateKey={
                  layoutData?.user?.id && layoutData.currentOrganizationId
                    ? `ioio-staff-lab-status-seen:${layoutData.currentOrganizationId}:${layoutData.user.id}`
                    : undefined
                }
              />
              <StudentBorrowListIndicator showLabel />
            </div>
          </header>

          <IoioPageContainer className="max-w-7xl pb-[calc(5rem+env(safe-area-inset-bottom))] pt-2 sm:px-6 md:pb-10 lg:px-8">
            <Outlet />
          </IoioPageContainer>
        </div>

        <MobileBottomNavigation
          label="IOIO staff mobile navigation"
          items={mobilePrimaryItems}
          moreItems={getStaffMobileMoreItems(navigationOrder, canViewLabTasks)}
          account={<StaffAccountControls compact />}
        />
      </div>
    </StudentCheckoutProvider>
  );
}
