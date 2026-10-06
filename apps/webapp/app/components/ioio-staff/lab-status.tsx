import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Bell, CheckCircle2 } from "lucide-react";
import { Link, useFetcher, useRevalidator } from "react-router";
import type {
  LabIssue,
  LabStatus,
} from "~/modules/ioio-staff/lab-status.server";

function IssueRow({ issue }: { issue: LabIssue }) {
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const isResolving = fetcher.state !== "idle";

  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data &&
      typeof fetcher.data === "object" &&
      "success" in fetcher.data &&
      fetcher.data.success === true
    ) {
      void revalidator.revalidate();
    }
  }, [fetcher.data, fetcher.state, revalidator]);

  return (
    <li className="relative rounded-xl border border-gray-100 px-3 py-2.5 transition hover:border-red-200 hover:bg-red-50">
      <Link
        to={issue.href}
        aria-label={`${issue.title}: ${issue.detail}`}
        className="absolute inset-0 z-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-1"
      />
      <div className="pointer-events-none relative z-10 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <span className="block text-sm font-bold text-gray-950">
            {issue.title}
          </span>
          <span className="mt-0.5 block text-xs text-gray-500">
            {issue.detail}
          </span>
        </div>
        {issue.resolution ? (
          <fetcher.Form
            method="post"
            action="/api/ioio-staff-notifications"
            className="pointer-events-auto shrink-0"
          >
            <input type="hidden" name="intent" value="resolve" />
            <input
              type="hidden"
              name="operationId"
              value={issue.resolution.operationId}
            />
            <button
              type="submit"
              disabled={isResolving}
              className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-bold text-gray-600 transition hover:border-red-200 hover:text-red-800 disabled:cursor-wait disabled:opacity-60"
            >
              {isResolving ? "Saving" : "Mark complete"}
            </button>
          </fetcher.Form>
        ) : null}
      </div>
    </li>
  );
}

function IssueSummary({ status }: { status: LabStatus }) {
  const summaries = [
    {
      label: "Overdue loans",
      count: status.overdueLoans,
      href: "/operations?view=overdue",
    },
    {
      label: "Returns to check",
      count: status.returnChecks,
      href: "/operations?view=returns",
    },
    {
      label: "Returned with issues",
      count: status.returnedWithIssues,
      href: "/operations?view=returned-with-issues",
    },
    {
      label: "Broken items",
      count: status.unresolvedReports,
      href: "/operations?view=broken",
    },
    {
      label: "Items to prepare",
      count: status.preparationTasks,
      href: "/operations?view=to-prepare",
    },
    {
      label: "Cancelled pickups",
      count: status.cancelledPickups,
      href: "/operations?view=cancelled-pickups",
    },
    {
      label: "Ready for pickup",
      count: status.readyForPickup,
      href: "/operations?view=ready-for-pickup",
    },
    {
      label: "Student access approvals",
      count: status.annualAccessApprovals,
      href: "/operations?view=access-approvals",
    },
  ] as const;
  return (
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {summaries.map(({ label, count, href }) => (
        <Link
          key={label}
          to={href}
          className="rounded-xl bg-gray-50 px-3 py-2 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-1"
        >
          <p className="text-[0.68rem] font-bold uppercase tracking-wide text-gray-500">
            {label}
          </p>
          <p className="mt-0.5 text-lg font-black text-gray-950">{count}</p>
        </Link>
      ))}
    </div>
  );
}

export function LabStatusCard({ status }: { status: LabStatus }) {
  const visibleIssues = status.issues.slice(0, 8);
  return (
    <section
      aria-labelledby="lab-status-heading"
      id="lab-status"
      className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
            Operations
          </p>
          <h2
            id="lab-status-heading"
            className="mt-1 text-xl font-black tracking-tight text-gray-950"
          >
            Lab status
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Link
            to="/operations"
            className="text-sm font-bold text-red-700 hover:text-red-800 hover:underline focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
          >
            View all
          </Link>
          {status.severity === "healthy" ? (
            <CheckCircle2
              aria-label="No current issues"
              className="size-6 shrink-0 text-green-600"
            />
          ) : (
            <AlertTriangle
              aria-label={`${status.totalIssues} current issues`}
              className={
                "size-6 shrink-0 " +
                (status.severity === "critical"
                  ? "text-red-700"
                  : "text-orange-500")
              }
            />
          )}
        </div>
      </div>
      <IssueSummary status={status} />
      {status.totalIssues > 0 ? (
        <section aria-labelledby="lab-status-attention" className="mt-4">
          <h3
            id="lab-status-attention"
            className="text-sm font-bold text-gray-900"
          >
            Needs attention
          </h3>
          <p className="mt-1 text-sm font-semibold text-gray-800">
            {status.totalIssues} item{status.totalIssues === 1 ? "" : "s"} need
            action.
          </p>
          <ul className="mt-4 space-y-2" aria-label="Current lab issues">
            {visibleIssues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} />
            ))}
          </ul>
          {status.issues.length > visibleIssues.length ? (
            <p className="mt-3 text-xs text-gray-500">
              Showing the first {visibleIssues.length} issues.
            </p>
          ) : null}
        </section>
      ) : null}
      {status.readyForPickup > 0 ? (
        <section
          aria-labelledby="lab-status-activity"
          className="mt-4 rounded-xl bg-blue-50 px-4 py-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3
                id="lab-status-activity"
                className="text-sm font-bold text-gray-900"
              >
                Current activity
              </h3>
              <p className="mt-1 text-sm text-gray-800">
                {status.readyForPickup} item
                {status.readyForPickup === 1 ? " is" : "s are"} ready for
                pickup.
              </p>
              <p className="text-xs text-gray-600">
                Students can collect these items from the Pickup Zone.
              </p>
            </div>
            <Link
              to="/operations?view=ready-for-pickup"
              className="shrink-0 text-sm font-bold text-red-700 hover:underline focus:outline-none focus:ring-2 focus:ring-red-700"
            >
              View ready pickups
            </Link>
          </div>
        </section>
      ) : status.totalIssues === 0 ? (
        <p className="mt-4 text-sm text-gray-600">
          No items currently need staff action.
        </p>
      ) : null}
    </section>
  );
}

export function StaffLabStatusBell({
  status,
  assignedTaskCount = 0,
}: {
  status: LabStatus | null;
  assignedTaskCount?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

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

  if (!status && assignedTaskCount === 0) return null;
  const issueCount = status?.totalIssues ?? 0;
  const notificationCount = issueCount + assignedTaskCount;
  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Open lab status and task notifications"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
        className="flex size-10 cursor-pointer list-none items-center justify-center rounded-xl border border-gray-200 text-gray-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-1 [&::-webkit-details-marker]:hidden"
      >
        <Bell aria-hidden="true" className="size-4" />
        {notificationCount > 0 ? (
          <span
            className={
              "absolute -right-1 -top-1 min-w-5 rounded-full px-1 text-center text-[0.65rem] font-black leading-5 text-white " +
              "bg-red-700"
            }
          >
            {notificationCount > 99 ? "99+" : notificationCount}
          </span>
        ) : null}
      </button>
      {isOpen ? (
        <div className="absolute right-0 top-12 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-gray-200 bg-white p-4 shadow-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-black text-gray-950">
                {status ? "Lab status" : "Lab tasks"}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {status?.totalIssues
                  ? `${status.totalIssues} issue${
                      status.totalIssues === 1 ? "" : "s"
                    } need attention.`
                  : assignedTaskCount
                  ? `${assignedTaskCount} open task${
                      assignedTaskCount === 1 ? "" : "s"
                    } assigned to you.`
                  : "Nothing needs attention right now."}
              </p>
            </div>
            {status && status.severity !== "healthy" ? (
              <AlertTriangle
                aria-hidden="true"
                className={
                  "size-4 " +
                  (status.severity === "critical"
                    ? "text-red-700"
                    : "text-orange-500")
                }
              />
            ) : null}
          </div>
          {status?.issues.length ? (
            <ul
              className="mt-3 space-y-2"
              aria-label="Lab status notifications"
            >
              {status.issues.slice(0, 5).map((issue) => (
                <IssueRow key={issue.id} issue={issue} />
              ))}
            </ul>
          ) : null}
          {assignedTaskCount > 0 ? (
            <Link
              to="/operations/tasks?filter=mine"
              onClick={() => setIsOpen(false)}
              className="mt-3 flex items-center justify-between rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 transition hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-700"
            >
              <span>
                {assignedTaskCount} task{assignedTaskCount === 1 ? "" : "s"}{" "}
                assigned to you
              </span>
              <span aria-hidden="true">View tasks</span>
            </Link>
          ) : null}
          <Link
            to={status ? "/operations" : "/operations/tasks"}
            className="mt-3 inline-flex text-xs font-bold text-red-700 hover:text-red-800 hover:underline focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
          >
            {status ? "Open operations" : "Open Lab Tasks"}
          </Link>
        </div>
      ) : null}
    </div>
  );
}
