import type { Dispatch, SetStateAction } from "react";
import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import {
  Link,
  NavLink,
  Outlet,
  useFetcher,
  useLocation,
  useNavigate,
  useRouteLoaderData,
} from "react-router";
import { Form } from "~/components/custom-form";
import { getAnnualAccessNoticeEventKey } from "~/modules/ioio-student/annual-access";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";
import {
  StudentCheckoutProvider,
  useStudentCheckout,
} from "./checkout-context";

const navigation = [
  { to: "/ioio", label: "Home", end: true },
  { to: "/ioio/loans", label: "My Loans", end: false },
  { to: "/ioio/lab", label: "About the IOIO Lab", end: false },
  { to: "/handbook", label: "Handbook", end: false },
  { to: "/ioio/report", label: "Report", end: false },
  { to: "/ioio/settings", label: "Settings", end: false },
];

function Ioiologo({ compact = false }: { compact?: boolean }) {
  return (
    <img
      src="/static/images/ioio-logo-white.png"
      alt="IOIO"
      className={compact ? "h-8 w-auto" : "h-12 w-auto"}
    />
  );
}

function NavigationLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="space-y-1">
      {navigation.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center rounded-xl px-3 py-2.5 text-sm font-bold transition focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 ${
              isActive
                ? "bg-red-700 text-white shadow-sm"
                : "text-gray-700 hover:bg-red-50 hover:text-red-800"
            }`
          }
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}

export function StudentBorrowListIndicator() {
  const { items, recentlyAdded } = useStudentCheckout();
  const countLabel = items.length
    ? `, ${items.length} selected item${items.length === 1 ? "" : "s"}`
    : "";
  const justAdded = recentlyAdded !== null;

  return (
    <div className="relative">
      <Link
        to="/ioio/checkout"
        aria-label={`Open borrowing list${countLabel}`}
        title={
          items.length ? `Borrow list (${items.length})` : "Open borrowing list"
        }
        className={`relative inline-flex size-10 items-center justify-center rounded-xl border bg-white text-gray-700 transition-[transform,background-color,border-color,box-shadow,color] duration-300 hover:border-red-200 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 ${
          justAdded
            ? "ioio-borrow-list-pop border-red-300 bg-red-50 text-red-800 shadow-sm"
            : "border-gray-200"
        }`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="size-5"
        >
          <path d="M4 9h16l-1.1 10.1a1 1 0 0 1-1 .9H6.1a1 1 0 0 1-1-.9L4 9Z" />
          <path d="M8 9V7a4 4 0 0 1 8 0v2M8.5 13v3M12 13v3M15.5 13v3" />
        </svg>
        {items.length ? (
          <span className="absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-700 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
            {items.length}
          </span>
        ) : null}
      </Link>
      {recentlyAdded ? (
        <div
          key={`${recentlyAdded.id}-${recentlyAdded.addedAt}`}
          role="status"
          aria-live="polite"
          className="absolute right-0 top-12 z-40 w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-red-100 bg-white px-3 py-2 text-xs font-semibold text-gray-800 shadow-lg"
        >
          <span className="text-red-800">{recentlyAdded.title}</span> added to
          borrow list
        </div>
      ) : null}
    </div>
  );
}

export function StudentNotificationBell() {
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );
  const notifications = layoutData?.studentIoioNotifications ?? [];
  const readNotificationFetcher = useFetcher();
  const storageKey =
    layoutData?.user?.id && layoutData.currentOrganizationId
      ? `ioio-notification-read:${layoutData.currentOrganizationId}:${layoutData.user.id}`
      : null;
  const [isOpen, setIsOpen] = useState(false);
  const [readState, setReadState] = useState<{
    storageKey: string;
    ids: string[];
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!storageKey) {
      setReadState(null);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(
        window.localStorage.getItem(storageKey) ?? "[]"
      );
      setReadState({
        storageKey,
        ids: Array.isArray(parsed)
          ? parsed.filter((id): id is string => typeof id === "string")
          : [],
      });
    } catch {
      setReadState({ storageKey, ids: [] });
    }
  }, [storageKey]);
  const readIds = readState?.storageKey === storageKey ? readState.ids : [];
  const unreadNotifications =
    storageKey && readState?.storageKey === storageKey
      ? notifications.filter(
          (notification) => !readIds.includes(notification.id)
        )
      : [];

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Node &&
        containerRef.current &&
        !containerRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Open notifications"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="relative inline-flex size-10 items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
      >
        <Bell aria-hidden="true" className="size-5" />
        {unreadNotifications.length ? (
          <span className="absolute -right-1 -top-1 inline-flex min-w-5 items-center justify-center rounded-full bg-red-700 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
            {unreadNotifications.length > 99
              ? "99+"
              : unreadNotifications.length}
          </span>
        ) : null}
      </button>
      {isOpen ? (
        <div className="absolute right-0 top-12 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-gray-200 bg-white p-4 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-black text-gray-950">Notifications</p>
              <p className="mt-0.5 text-xs text-gray-500">
                {unreadNotifications.length
                  ? `${unreadNotifications.length} unread notification${
                      unreadNotifications.length === 1 ? "" : "s"
                    }.`
                  : "Nothing needs attention right now."}
              </p>
            </div>
            <Bell aria-hidden="true" className="size-4 text-red-700" />
          </div>
          {notifications.length ? (
            <ul className="mt-3 space-y-2" aria-label="Student notifications">
              {notifications.map((notification) => (
                <li key={notification.id}>
                  <Link
                    to={notification.href}
                    onClick={() => {
                      if (notification.annualAccessApprovalNotificationId) {
                        void readNotificationFetcher.submit(
                          {
                            notificationId:
                              notification.annualAccessApprovalNotificationId,
                          },
                          {
                            method: "post",
                            action: "/ioio/notification-read",
                          }
                        );
                      }
                      if (storageKey) {
                        const nextIds = readIds.includes(notification.id)
                          ? readIds
                          : [...readIds, notification.id];
                        setReadState({ storageKey, ids: nextIds });
                        try {
                          window.localStorage.setItem(
                            storageKey,
                            JSON.stringify(nextIds)
                          );
                        } catch {
                          // Keep the notification marked read for this mount.
                        }
                      }
                      setIsOpen(false);
                    }}
                    className={`block rounded-xl border px-3 py-2 transition hover:border-red-200 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-1 ${
                      unreadNotifications.some(
                        (item) => item.id === notification.id
                      )
                        ? "border-red-100 bg-red-50/50"
                        : "border-gray-100"
                    }`}
                  >
                    <span className="block text-sm font-bold text-gray-950">
                      {notification.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-gray-600">
                      {notification.message}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StudentAccountControls({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <section
      aria-label="Student account"
      className="mt-6 border-t border-gray-100 pt-4"
    >
      <p className="px-3 text-[0.68rem] font-bold uppercase tracking-[0.14em] text-gray-400">
        Signed in
      </p>
      <p className="px-3 pt-1 text-sm font-semibold text-gray-700">Student</p>
      <Form
        method="post"
        action="/logout"
        onSubmit={onNavigate}
        className="mt-2"
      >
        <button
          type="submit"
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-left text-sm font-semibold text-gray-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
          aria-label="Log out of IOIO Lab Shelf"
        >
          Log out
        </button>
      </Form>
    </section>
  );
}

function AnnualAccessBanner() {
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );
  const location = useLocation();
  const approval = layoutData?.annualAccessApproval;
  if (!approval || !approval.required || approval.status === "APPROVED") {
    return null;
  }

  const pending = approval.status === "PENDING";
  const expired = approval.status === "EXPIRED";
  if (location.pathname === "/ioio" && pending) return null;
  return (
    <section
      aria-labelledby="annual-access-title"
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3"
    >
      <div>
        <h2 id="annual-access-title" className="text-sm font-bold text-red-950">
          {pending
            ? "Approval request pending"
            : expired
            ? "IOIO borrowing approval has expired"
            : approval.status === "REVOKED"
            ? "Borrowing approval required"
            : "IOIO borrowing approval required"}
        </h2>
        <p className="mt-1 text-xs text-red-900">
          {pending
            ? approval.pendingMessage
            : expired
            ? "You can still browse equipment, but you need renewed approval before borrowing again."
            : approval.status === "REVOKED"
            ? "Your borrowing approval was revoked. Browsing remains available; current approval is required only to borrow."
            : approval.status === "DECLINED"
            ? "Your previous request was not approved. You can still browse equipment and submit a new request."
            : approval.studentMessage}
        </p>
      </div>
      <Link
        to="/ioio/settings/access-approval"
        className="shrink-0 rounded-xl border border-red-700 bg-red-700 px-3 py-2 text-xs font-bold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
      >
        {pending
          ? "View approval status"
          : approval.status === "REVOKED"
          ? "Reapply for approval"
          : "Request approval"}
      </Link>
    </section>
  );
}

function AnnualAccessStatusNotice() {
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );
  const approval = layoutData?.annualAccessApproval;
  const approvalNotification = (
    layoutData?.studentIoioNotifications ?? []
  ).find((notification) => notification.annualAccessApprovalNotificationId);
  const fetcher = useFetcher<{ ok?: boolean; message?: string }>();
  const navigate = useNavigate();
  const [revocationNotice, setRevocationNotice] = useState<{
    key: string | null;
    visible: boolean;
  }>({ key: null, visible: false });

  const revocationEventAt = approval?.reviewedAt ?? approval?.requestedAt;
  const revocationAcknowledgementKey =
    approval?.approvalId &&
    layoutData?.user?.id &&
    layoutData.currentOrganizationId &&
    approval.status === "REVOKED"
      ? `ioio-access-notice:${layoutData.currentOrganizationId}:${
          layoutData.user.id
        }:${getAnnualAccessNoticeEventKey({
          status: "REVOKED",
          approvalId: approval.approvalId,
          eventAt: revocationEventAt,
        })}`
      : null;

  useEffect(() => {
    if (!revocationAcknowledgementKey) {
      setRevocationNotice({ key: null, visible: false });
      return;
    }

    try {
      setRevocationNotice({
        key: revocationAcknowledgementKey,
        visible:
          window.localStorage.getItem(revocationAcknowledgementKey) !== "seen",
      });
    } catch {
      setRevocationNotice({ key: revocationAcknowledgementKey, visible: true });
    }
  }, [revocationAcknowledgementKey]);

  useEffect(() => {
    if (fetcher.data?.ok) void navigate("/ioio");
  }, [fetcher.data, navigate]);

  const acknowledgeRevocation = () => {
    try {
      if (revocationAcknowledgementKey) {
        window.localStorage.setItem(revocationAcknowledgementKey, "seen");
      }
    } catch {
      // The notice can still be dismissed for this render without storage.
    }
    setRevocationNotice({ key: revocationAcknowledgementKey, visible: false });
  };

  if (
    approval?.status === "REVOKED" &&
    revocationNotice.visible &&
    revocationNotice.key === revocationAcknowledgementKey
  ) {
    return (
      <section
        role="status"
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3"
      >
        <div>
          <h2 className="text-sm font-bold text-amber-950">
            Borrowing approval revoked
          </h2>
          <p className="mt-1 text-sm text-amber-900">
            Your borrowing approval was revoked. You can still browse equipment
            and report issues; current approval is required only to borrow.
          </p>
        </div>
        <button
          type="button"
          onClick={acknowledgeRevocation}
          className="inline-flex h-9 items-center justify-center rounded-lg border border-amber-300 bg-white px-3 text-sm font-semibold text-amber-950 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2"
        >
          Dismiss
        </button>
      </section>
    );
  }

  if (
    approval?.status !== "APPROVED" ||
    !approvalNotification?.annualAccessApprovalNotificationId
  ) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-gray-950/35 p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="access-approved-title"
        className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-5 shadow-xl"
      >
        <h2
          id="access-approved-title"
          className="text-lg font-black tracking-tight text-gray-950"
        >
          Borrowing access approved
        </h2>
        <p className="mt-1.5 text-sm text-gray-600">
          You can now borrow IOIO Lab equipment.
        </p>
        {fetcher.data && !fetcher.data.ok ? (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {fetcher.data.message ?? "Could not dismiss this notification."}
          </p>
        ) : null}
        <fetcher.Form
          method="post"
          action="/ioio/notification-read"
          className="mt-4"
        >
          <input
            type="hidden"
            name="notificationId"
            value={approvalNotification.annualAccessApprovalNotificationId}
          />
          <button
            type="submit"
            disabled={fetcher.state !== "idle"}
            className="inline-flex h-10 items-center justify-center rounded-xl bg-red-700 px-4 text-sm font-bold text-white transition hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:opacity-60"
          >
            {fetcher.state !== "idle" ? "Continuing…" : "Continue"}
          </button>
        </fetcher.Form>
      </section>
    </div>
  );
}

export default function StudentShell() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <StudentCheckoutProvider>
      <StudentShellContent
        mobileMenuOpen={mobileMenuOpen}
        setMobileMenuOpen={setMobileMenuOpen}
      />
    </StudentCheckoutProvider>
  );
}

function StudentShellContent({
  mobileMenuOpen,
  setMobileMenuOpen,
}: {
  mobileMenuOpen: boolean;
  setMobileMenuOpen: Dispatch<SetStateAction<boolean>>;
}) {
  return (
    <div className="min-h-screen overflow-x-hidden bg-white text-gray-950">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-red-100 bg-white p-4 md:flex">
        <Link
          to="/ioio"
          className="flex justify-center rounded-2xl bg-red-800 px-3 py-4 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
          aria-label="IOIO Lab home"
        >
          <Ioiologo />
        </Link>
        <p className="px-2 pb-4 pt-5 text-xs font-bold uppercase tracking-[0.16em] text-gray-400">
          Student desk
        </p>
        <nav aria-label="IOIO student navigation" className="flex-1">
          <NavigationLinks />
        </nav>
        <StudentAccountControls />
      </aside>

      <div className="md:pl-56">
        <header className="border-b border-red-100 bg-white md:hidden">
          <div className="flex items-center justify-between gap-3 p-4">
            <Link
              to="/ioio"
              className="flex justify-center rounded-xl bg-red-800 px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
              aria-label="IOIO Lab home"
            >
              <Ioiologo compact />
            </Link>
            <div className="flex items-center gap-2">
              <StudentNotificationBell />
              <StudentBorrowListIndicator />
              <button
                type="button"
                aria-expanded={mobileMenuOpen}
                aria-controls="ioio-mobile-navigation"
                onClick={() => setMobileMenuOpen((open) => !open)}
                className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm font-bold text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
              >
                {mobileMenuOpen ? "Close" : "Menu"}
              </button>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 pb-10 pt-6 sm:px-6 lg:px-8">
          <div className="mb-3 hidden justify-end gap-2 md:flex">
            <StudentNotificationBell />
            <StudentBorrowListIndicator />
          </div>
          <AnnualAccessBanner />
          <AnnualAccessStatusNotice />
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
            id="ioio-mobile-navigation"
            className="absolute inset-y-0 right-0 w-[min(19rem,88vw)] overflow-y-auto border-l border-red-100 bg-white p-4 shadow-2xl"
          >
            <div className="mb-5 flex items-center justify-between">
              <div className="flex justify-center rounded-xl bg-red-800 px-3 py-2.5">
                <Ioiologo compact />
              </div>
              <span className="text-xs font-bold uppercase tracking-[0.16em] text-gray-400">
                Student desk
              </span>
            </div>
            <nav aria-label="IOIO student navigation">
              <NavigationLinks onNavigate={() => setMobileMenuOpen(false)} />
            </nav>
            <StudentAccountControls
              onNavigate={() => setMobileMenuOpen(false)}
            />
          </aside>
        </div>
      ) : null}
    </div>
  );
}
