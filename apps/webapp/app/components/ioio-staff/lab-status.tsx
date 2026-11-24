import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Activity, AlertTriangle, Bell, ChevronRight } from "lucide-react";
import { Link } from "react-router";
import { NotificationPanel } from "~/components/ioio-shared/notification-panel";
import type {
  LabIssue,
  LabStatus,
} from "~/modules/ioio-staff/lab-status.server";

import { LabInventoryActions } from "./lab-inventory-actions";

function IssueRow({
  issue,
  onClick,
  controls,
}: {
  issue: LabIssue;
  onClick?: () => void;
  controls?: ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-center rounded-xl border border-gray-100 transition hover:border-red-200 hover:bg-red-50">
      <Link
        to={issue.href}
        onClick={onClick}
        aria-label={`${issue.title}: ${issue.detail}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-1"
      >
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span className="block text-sm font-bold text-gray-950">
            {issue.title}
          </span>
          <span className="mt-0.5 block text-xs text-gray-500">
            {issue.detail}
          </span>
          {controls && issue.inventoryTarget ? (
            <span className="mt-1 block text-xs font-semibold text-gray-700">
              {issue.inventoryTarget.pooled
                ? "Pooled stock"
                : issue.inventoryTarget.disabled
                ? "Disabled"
                : "Borrowing enabled"}
            </span>
          ) : null}
        </div>
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-gray-400"
        />
      </Link>
      {controls}
    </li>
  );
}

function getLabIssueReadKey(issue: LabIssue) {
  const fingerprint = JSON.stringify([issue.id, issue.title, issue.detail]);
  let hash = 2166136261;
  for (let index = 0; index < fingerprint.length; index++) {
    hash = Math.imul(hash ^ fingerprint.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
}

function countActionableItems(issues: LabIssue[], preparationTasks: number) {
  return (
    issues.length +
    (issues.some((issue) => issue.kind === "preparation")
      ? Math.max(0, preparationTasks - 1)
      : 0)
  );
}

function IssueSummary({
  status,
  pendingHandbookReviews,
}: {
  status: LabStatus;
  pendingHandbookReviews: number;
}) {
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
      label: "General",
      count: status.generalReports,
      href: "/operations?view=general",
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
    {
      label: "Handbook reviews",
      count: pendingHandbookReviews,
      href: "/handbook/review",
    },
  ] as const;
  return (
    <div className="mt-3 grid auto-rows-fr grid-cols-2 items-stretch gap-2 sm:mt-4 sm:grid-cols-4">
      {summaries.map(({ label, count, href }) => (
        <Link
          key={label}
          to={href}
          className="flex h-full min-w-0 flex-col rounded-xl bg-gray-50 px-2.5 py-2 transition hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-1 sm:px-3"
        >
          <p className="break-words text-[0.68rem] font-bold uppercase tracking-wide text-gray-500">
            {label}
          </p>
          <p className="mt-0.5 text-base font-black text-gray-950 sm:text-lg">
            {count}
          </p>
        </Link>
      ))}
    </div>
  );
}

export function LabStatusCard({
  status,
  pendingHandbookReviews = 0,
  canManageInventory = false,
}: {
  status: LabStatus;
  pendingHandbookReviews?: number;
  canManageInventory?: boolean;
}) {
  const visibleIssues = status.issues.slice(0, 3);
  const actionableItemCount = countActionableItems(
    status.issues,
    status.preparationTasks
  );
  return (
    <section
      aria-labelledby="lab-status-heading"
      id="lab-status"
      className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm sm:p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            id="lab-status-heading"
            className="mt-1 text-lg font-black tracking-tight text-gray-950 sm:text-xl"
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
          <Activity
            aria-label={`${actionableItemCount} current issues`}
            className="size-6 shrink-0 text-gray-500"
          />
        </div>
      </div>
      <IssueSummary
        status={status}
        pendingHandbookReviews={pendingHandbookReviews}
      />
      {status.totalIssues > 0 ? (
        <section aria-labelledby="lab-status-attention" className="mt-4">
          <h3
            id="lab-status-attention"
            className="text-sm font-bold text-gray-900"
          >
            Needs attention
          </h3>
          <p className="mt-1 text-sm font-semibold text-gray-800">
            {actionableItemCount} item
            {actionableItemCount === 1 ? " needs" : "s need"} action.
          </p>
          {canManageInventory &&
          status.issues.some((issue) => issue.inventoryTarget) ? (
            <LabInventoryActions
              issues={status.issues}
              renderIssue={(issue, controls) => (
                <IssueRow key={issue.id} issue={issue} controls={controls} />
              )}
            />
          ) : (
            <>
              <ul className="mt-4 space-y-2" aria-label="Current lab issues">
                {visibleIssues.map((issue) => (
                  <IssueRow key={issue.id} issue={issue} />
                ))}
              </ul>
              {status.issues.length > visibleIssues.length ? (
                <p className="mt-3 text-xs text-gray-500">
                  Showing 3 of {status.issues.length} items.
                </p>
              ) : null}
            </>
          )}
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
  mobile = false,
  readStateKey,
}: {
  status: LabStatus | null;
  mobile?: boolean;
  /** User and Team scoped browser storage key for the last seen issue keys. */
  readStateKey?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [seenState, setSeenState] = useState<{
    key: string | undefined;
    issueKeys: string[];
  }>({ key: readStateKey, issueKeys: [] });

  useEffect(() => {
    if (!readStateKey) {
      setSeenState({ key: readStateKey, issueKeys: [] });
      return;
    }

    try {
      const saved = JSON.parse(
        window.localStorage.getItem(readStateKey) ?? "[]"
      );
      setSeenState({
        key: readStateKey,
        issueKeys: Array.isArray(saved)
          ? saved.filter((id): id is string => typeof id === "string")
          : [],
      });
    } catch {
      setSeenState({ key: readStateKey, issueKeys: [] });
    }
  }, [readStateKey]);

  const currentIssueCount = status
    ? countActionableItems(status.issues, status.preparationTasks)
    : 0;
  const seenIssueKeys =
    seenState.key === readStateKey ? new Set(seenState.issueKeys) : new Set();
  const newIssues =
    status?.issues.filter(
      (issue) => !seenIssueKeys.has(getLabIssueReadKey(issue))
    ) ?? [];
  const newIssueCount = countActionableItems(
    newIssues,
    status?.preparationTasks ?? 0
  );

  function changeOpen(nextOpen: boolean) {
    if (nextOpen) {
      const currentIssueKeys = status?.issues.map(getLabIssueReadKey) ?? [];
      setSeenState({ key: readStateKey, issueKeys: currentIssueKeys });
      if (readStateKey) {
        try {
          window.localStorage.setItem(
            readStateKey,
            JSON.stringify(currentIssueKeys)
          );
        } catch {
          // The in-memory read state still applies when storage is unavailable.
        }
      }
    }
    setIsOpen(nextOpen);
  }

  const description = currentIssueCount
    ? `${currentIssueCount} current actionable item${
        currentIssueCount === 1 ? "" : "s"
      }; ${newIssueCount ? `${newIssueCount} new.` : "all have been seen."}`
    : "Nothing needs attention right now.";

  return (
    <NotificationPanel
      mobile={mobile}
      open={isOpen}
      onOpenChange={changeOpen}
      label="Open lab status notifications"
      title="Lab status"
      description={description}
      triggerClassName="flex size-11 cursor-pointer items-center justify-center rounded-xl border border-gray-200 text-gray-600 transition hover:border-red-200 hover:bg-red-50 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-1 md:size-10"
      headerIcon={
        status && status.severity !== "healthy" ? (
          <AlertTriangle
            aria-hidden="true"
            className={`size-4 shrink-0 ${
              status.severity === "critical"
                ? "text-red-700"
                : "text-orange-500"
            }`}
          />
        ) : null
      }
      trigger={
        <>
          <Bell aria-hidden="true" className="size-5 md:size-4" />
          {newIssueCount > 0 ? (
            <span
              className={
                "absolute -right-1 -top-1 min-w-5 rounded-full px-1 text-center text-[0.65rem] font-black leading-5 text-white " +
                "bg-red-700"
              }
            >
              {newIssueCount > 99 ? "99+" : newIssueCount}
            </span>
          ) : null}
        </>
      }
    >
      {status?.issues.length ? (
        <ul className="mt-3 space-y-2" aria-label="Lab status notifications">
          {status.issues.slice(0, 5).map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              onClick={() => setIsOpen(false)}
            />
          ))}
        </ul>
      ) : null}
      {status && status.issues.length > 5 ? (
        <p className="mt-3 text-xs text-gray-500">
          Showing 5 of {currentIssueCount} current actionable items.
        </p>
      ) : null}
      <Link
        to="/operations"
        onClick={() => setIsOpen(false)}
        className="mt-3 inline-flex items-center text-xs font-bold text-red-700 hover:text-red-800 hover:underline focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 max-md:min-h-11"
      >
        Open operations
      </Link>
    </NotificationPanel>
  );
}
