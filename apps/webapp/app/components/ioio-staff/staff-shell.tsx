import { useEffect, useRef, useState } from "react";
import {
  BarChart3,
  ChevronDown,
  ClipboardList,
  CalendarDays,
  Clock3,
  GripVertical,
  Home,
  MapPin,
  MessageCircle,
  PackageOpen,
  Archive,
  Settings,
  Tags,
  Trash2,
  ShoppingCart,
} from "lucide-react";
import {
  Form,
  Link,
  NavLink,
  Outlet,
  useLocation,
  useMatches,
  useRouteLoaderData,
} from "react-router";
import { StaffLabStatusBell } from "~/components/ioio-staff/lab-status";
import { ChatHistoryMenu } from "~/components/ioio-student/chat-history";
import { StudentCheckoutProvider } from "~/components/ioio-student/checkout-context";
import { StudentBorrowListIndicator } from "~/components/ioio-student/student-shell";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";

const navigation = [
  { to: "/home", label: "Dashboard", Icon: Home, end: true },
  { to: "/staff/ask", label: "Ask IOIO", Icon: MessageCircle, end: true },
  { to: "/handbook", label: "Handbook", Icon: ClipboardList, end: false },
  { to: "/assets", label: "Inventory", Icon: PackageOpen, end: false },
  { to: "/staff/archived", label: "Archive", Icon: Archive, end: true },
  { to: "/staff/trash", label: "Trash", Icon: Trash2, end: true },
  { to: "/categories", label: "Categories", Icon: Tags, end: false },
  { to: "/locations", label: "Locations", Icon: MapPin, end: false },
  { to: "/bookings", label: "Loans", Icon: ClipboardList, end: false },
  {
    to: "/operations/tasks",
    label: "Lab Tasks",
    Icon: ClipboardList,
    end: false,
  },
  { to: "/purchasing", label: "Purchasing", Icon: ShoppingCart, end: false },
  { to: "/ta-hours", label: "TA Hours", Icon: Clock3, end: false },
  { to: "/calendar", label: "Calendar", Icon: CalendarDays, end: true },
  { to: "/reports", label: "Analytics", Icon: BarChart3, end: false },
  { to: "/settings", label: "Settings", Icon: Settings, end: false },
] as const;

const navigationStorageKey = "ioio-staff-navigation-order";
const defaultNavigationOrder = navigation.map(({ to }) => to);
type NavigationItem = (typeof navigation)[number];

function readSavedNavigationOrder() {
  if (typeof window === "undefined") return defaultNavigationOrder;

  try {
    const saved = JSON.parse(
      window.localStorage.getItem(navigationStorageKey) ?? "null"
    );
    if (!Array.isArray(saved)) return defaultNavigationOrder;

    const valid = saved.filter((to): to is NavigationItem["to"] =>
      defaultNavigationOrder.includes(to)
    );
    const missing = defaultNavigationOrder.filter((to) => !valid.includes(to));
    return [...valid, ...missing];
  } catch {
    return defaultNavigationOrder;
  }
}

function StaffLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`flex aspect-[316/129] items-center justify-center overflow-hidden rounded-2xl bg-red-800 p-1.5 ${
        compact ? "w-24" : "w-32"
      }`}
    >
      <img
        src="/static/images/ioio-logo-white.png"
        alt="IOIO Lab"
        className="size-full object-contain"
      />
    </div>
  );
}

function StaffNavigation({
  onNavigate,
  navigationOrder,
  onReorder,
  canViewLabTasks,
  toolsOnly,
}: {
  onNavigate?: () => void;
  navigationOrder: readonly string[];
  onReorder: (dragged: string, target: string) => void;
  canViewLabTasks: boolean;
  toolsOnly: boolean;
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
    .map((to) => navigation.find((item) => item.to === to))
    .filter((item): item is NavigationItem => Boolean(item))
    .filter((item) => {
      const isLabTool = [
        "/operations/tasks",
        "/purchasing",
        "/ta-hours",
      ].includes(item.to);
      return toolsOnly ? isLabTool : !isLabTool;
    })
    .filter((item) => item.to !== "/operations/tasks" || canViewLabTasks);
  const activePath = navigation
    .filter(({ to, end }) => {
      const [pathname, query] = to.split("?");
      const pathMatches = end
        ? location.pathname === pathname
        : location.pathname === pathname ||
          location.pathname.startsWith(`${pathname}/`);
      const mineQuery = new URLSearchParams(location.search).get("mine");
      const queryMatches = query ? mineQuery === "1" : mineQuery !== "1";
      return pathMatches && queryMatches;
    })
    .sort((left, right) => right.to.length - left.to.length)[0]?.to;

  return (
    <nav aria-label="IOIO staff navigation" className="space-y-0.5">
      {orderedNavigation.map(({ to, label, Icon, end }) => {
        const active = activePath === to;

        if (to === "/bookings") {
          return (
            <div key={to} className="space-y-0.5">
              <div className="flex min-w-0 items-center gap-1">
                <NavLink
                  to="/bookings"
                  end
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
                  className={`flex min-h-9 min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-1 ${
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
                  <NavLink
                    to="/ioio/loans"
                    end
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `block rounded-lg px-3 py-1.5 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-1 ${
                        isActive
                          ? "bg-red-50 text-red-800"
                          : "text-gray-600 hover:bg-red-50 hover:text-red-800"
                      }`
                    }
                  >
                    My Loans
                  </NavLink>
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
            className={`flex min-h-9 min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-1 ${
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
  accountLabel = "Staff",
}: {
  onNavigate?: () => void;
  accountLabel?: string;
}) {
  return (
    <section
      aria-label="Staff account"
      className="mt-3 border-t border-gray-100 pt-3"
    >
      <p className="px-3 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-gray-400">
        Signed in
      </p>
      <p className="px-3 pt-1 text-sm font-semibold text-gray-700">
        {accountLabel}
      </p>
      <Form
        method="post"
        action="/logout"
        onSubmit={onNavigate}
        className="mt-1.5"
      >
        <button
          type="submit"
          aria-label="Log out of IOIO Lab Shelf"
          className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-left text-sm font-semibold text-gray-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
        >
          Log out
        </button>
      </Form>
    </section>
  );
}

export default function StaffShell({
  toolsOnly = false,
}: {
  toolsOnly?: boolean;
}) {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [navigationOrder, setNavigationOrder] = useState<readonly string[]>(
    defaultNavigationOrder
  );
  const navigationLoaded = useRef(false);
  const location = useLocation();
  const isLabelGeneratorRoute = location.pathname === "/labels";
  const homeHref = toolsOnly
    ? location.pathname === "/purchasing"
      ? "/purchasing"
      : location.pathname === "/ta-hours"
      ? "/ta-hours"
      : "/operations/tasks"
    : "/home";
  const shellTitle = toolsOnly
    ? location.pathname === "/purchasing"
      ? "Purchasing"
      : location.pathname === "/ta-hours"
      ? "TA Hours"
      : "Lab tasks"
    : "Staff desk";

  useEffect(() => {
    setNavigationOrder(readSavedNavigationOrder());
    navigationLoaded.current = true;
  }, []);

  useEffect(() => {
    if (!navigationLoaded.current) return;
    window.localStorage.setItem(
      navigationStorageKey,
      JSON.stringify(navigationOrder)
    );
  }, [navigationOrder]);

  function reorderNavigation(dragged: string, target: string) {
    setNavigationOrder((current) => {
      const next = [...current];
      const fromIndex = next.indexOf(dragged);
      if (fromIndex < 0 || next.indexOf(target) < 0) return current;
      next.splice(fromIndex, 1);
      next.splice(next.indexOf(target) + 1, 0, dragged);
      return next;
    });
  }

  const matches = useMatches();
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );
  const canViewLabTasks = Boolean(
    layoutData?.isIoioStaff || layoutData?.isIoioTA
  );
  const labStatus = layoutData?.labStatus ?? null;
  const assignedLabTaskCount = layoutData?.assignedLabTaskCount ?? 0;
  const askMatch = matches.find((match) => match.pathname === "/staff/ask");
  const chatScope = (askMatch?.data as { chatScope?: string } | undefined)
    ?.chatScope;

  return (
    <StudentCheckoutProvider>
      <div
        className={`ioio-staff-surface -mx-4 min-h-full overflow-x-clip bg-white text-gray-950 ${
          isLabelGeneratorRoute ? "ioio-label-route-surface" : ""
        }`}
      >
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-red-100 bg-white p-3 md:flex">
          <div className="flex items-center gap-2">
            <Link
              to={homeHref}
              aria-label={
                toolsOnly
                  ? `IOIO Lab ${shellTitle.toLowerCase()}`
                  : "IOIO Lab staff dashboard"
              }
              className="flex min-w-0 flex-1 items-center justify-center rounded-xl bg-red-800 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
            >
              <StaffLogo />
            </Link>
          </div>
          <p className="px-2 py-3 text-xs font-bold uppercase tracking-[0.16em] text-gray-400">
            {toolsOnly ? "Lab tools" : "Staff desk"}
          </p>
          <div className="flex-1 overflow-y-auto">
            <StaffNavigation
              navigationOrder={navigationOrder}
              onReorder={reorderNavigation}
              canViewLabTasks={canViewLabTasks}
              toolsOnly={toolsOnly}
            />
          </div>
          <StaffAccountControls accountLabel={toolsOnly ? "Lab TA" : "Staff"} />
        </aside>

        <div className="md:pl-60">
          <header className="sticky top-0 z-20 border-b border-red-100 bg-white">
            <div className="flex items-center justify-between gap-3 p-4">
              <Link
                to={homeHref}
                aria-label={
                  toolsOnly
                    ? `IOIO Lab ${shellTitle.toLowerCase()}`
                    : "IOIO Lab staff dashboard"
                }
                className="flex items-center justify-center rounded-lg bg-red-800 p-2 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 md:hidden"
              >
                <StaffLogo compact />
              </Link>
              <div className="ml-auto flex items-center gap-3">
                <StaffLabStatusBell
                  status={labStatus}
                  assignedTaskCount={assignedLabTaskCount}
                />
                {!toolsOnly ? <StudentBorrowListIndicator /> : null}
                <button
                  type="button"
                  aria-expanded={mobileMenuOpen}
                  aria-controls="ioio-staff-mobile-navigation"
                  onClick={() => setMobileMenuOpen((open) => !open)}
                  className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm font-bold text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 md:hidden"
                >
                  {mobileMenuOpen ? "Close" : "Menu"}
                </button>
              </div>
            </div>
          </header>

          <main className="mx-auto max-w-7xl px-4 pb-10 pt-2 sm:px-6 lg:px-8">
            <Outlet />
          </main>
        </div>

        {mobileMenuOpen ? (
          <div className="fixed inset-0 z-40 md:hidden">
            <button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-gray-950/20"
              onClick={() => setMobileMenuOpen(false)}
            />
            <aside
              id="ioio-staff-mobile-navigation"
              className="absolute inset-y-0 right-0 w-[min(20rem,88vw)] overflow-y-auto border-l border-red-100 bg-white p-4 shadow-2xl"
            >
              <div className="mb-5 flex items-center justify-between gap-3">
                <div className="rounded-xl bg-red-800 p-2">
                  <StaffLogo compact />
                </div>
                <span className="text-xs font-bold uppercase tracking-[0.16em] text-gray-400">
                  {toolsOnly ? "Lab tools" : "Staff desk"}
                </span>
              </div>
              <StaffNavigation
                navigationOrder={navigationOrder}
                onReorder={reorderNavigation}
                onNavigate={() => setMobileMenuOpen(false)}
                canViewLabTasks={canViewLabTasks}
                toolsOnly={toolsOnly}
              />
              {!toolsOnly ? (
                <ChatHistoryMenu
                  namespace="staff"
                  scope={chatScope}
                  to="/staff/ask"
                  onNavigate={() => setMobileMenuOpen(false)}
                />
              ) : null}
              <StaffAccountControls
                onNavigate={() => setMobileMenuOpen(false)}
                accountLabel={toolsOnly ? "Lab TA" : "Staff"}
              />
            </aside>
          </div>
        ) : null}
      </div>
    </StudentCheckoutProvider>
  );
}
