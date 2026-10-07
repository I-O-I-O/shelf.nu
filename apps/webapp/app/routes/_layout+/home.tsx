/**
 * Staff dashboard at /home after auth.
 *
 * Dashboard widget data and status items continue to come from their
 * authoritative Staff modules; ordering is a per-user presentation preference.
 */
import type { ReactNode } from "react";
import type { Prisma } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Link, useLoaderData, useRouteLoaderData } from "react-router";
import { z } from "zod";
import { ErrorContent } from "~/components/errors";
import { DashboardCustomizer } from "~/components/ioio-staff/dashboard-customizer";
import { LabStatusCard } from "~/components/ioio-staff/lab-status";
import { StaffImportPanel } from "~/components/ioio-staff/staff-import-panel";
import { db } from "~/database/db.server";
import { answerStaffAssistant } from "~/modules/ioio-staff/assistant.server";
import {
  DEFAULT_STAFF_DASHBOARD_PREFERENCES,
  normalizeStaffDashboardPreferences,
  type StaffDashboardWidgetId,
} from "~/modules/ioio-staff/dashboard-preferences";
import {
  applyStaffInventoryImport,
  cancelStaffInventoryImport,
  getStaffInventoryImportProposal,
  prepareStaffInventoryImport,
} from "~/modules/ioio-staff/inventory-import.server";
import { getDashboardLabTasks } from "~/modules/ioio-staff/lab-tasks.server";
import { getPurchasingDashboardSummary } from "~/modules/ioio-staff/purchasing.server";
import { getTAHoursDashboardSummary } from "~/modules/ioio-staff/ta-hours.server";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { resolveUserDisplayName } from "~/utils/user";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const authSession = context.getSession();
  const { userId } = authSession;

  try {
    const { role, organizationId } = await requirePermission({
      userId,
      request,
      entity: PermissionEntity.dashboard,
      action: PermissionAction.read,
    });
    const isStaff = role === "ADMIN" || role === "OWNER";
    const [labTasks, taHours, purchasing, savedDashboardPreferences] = isStaff
      ? await Promise.all([
          getDashboardLabTasks({ organizationId, userId }),
          getTAHoursDashboardSummary(organizationId, userId),
          getPurchasingDashboardSummary(organizationId),
          db.user.findUnique({
            where: { id: userId },
            select: { staffDashboardPreferences: true },
          }),
        ])
      : [null, null, null, null];

    let importProposal = null;
    let importNotice = null;
    const operationId = new URL(request.url).searchParams.get(
      "importOperation"
    );
    if (isStaff && operationId) {
      try {
        importProposal = await getStaffInventoryImportProposal({
          context,
          request,
          operationId,
        });
      } catch (cause) {
        const reason = makeShelfError(cause);
        if (reason.message.includes("no longer available")) {
          importNotice =
            "This import proposal expired or is no longer available. Start a new import to continue.";
        } else {
          throw data(error(reason), { status: reason.status });
        }
      }
    }

    return payload({
      header: { title: "Home" },
      isStaff,
      labTasks,
      taHours,
      purchasing,
      dashboardPreferences: normalizeStaffDashboardPreferences(
        savedDashboardPreferences?.staffDashboardPreferences
      ),
      importProposal,
      importNotice,
    });
  } catch (cause) {
    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  try {
    const formData = await request.formData();
    const intent = z
      .enum([
        "ask",
        "analyze-file",
        "apply-import",
        "cancel-import",
        "save-dashboard",
        "reset-dashboard",
      ])
      .parse(formData.get("intent"));

    if (intent === "save-dashboard" || intent === "reset-dashboard") {
      const { role } = await requirePermission({
        userId: context.getSession().userId,
        request,
        entity: PermissionEntity.dashboard,
        action: PermissionAction.read,
      });
      if (role !== "ADMIN" && role !== "OWNER") {
        throw new ShelfError({
          cause: null,
          message: "Only Staff can customize this dashboard.",
          label: "Permission",
          status: 403,
          shouldBeCaptured: false,
        });
      }

      const preferences =
        intent === "reset-dashboard"
          ? DEFAULT_STAFF_DASHBOARD_PREFERENCES
          : (() => {
              const raw = z
                .string()
                .min(1)
                .max(5000)
                .parse(formData.get("preferences"));
              let value: unknown;
              try {
                value = JSON.parse(raw);
              } catch {
                throw new ShelfError({
                  cause: null,
                  message: "The dashboard layout could not be read. Try again.",
                  label: "Request validation",
                  status: 400,
                  shouldBeCaptured: false,
                });
              }
              return normalizeStaffDashboardPreferences(value);
            })();

      await db.user.update({
        where: { id: context.getSession().userId },
        data: {
          staffDashboardPreferences: preferences as Prisma.InputJsonValue,
        },
      });
      return payload({ kind: "dashboard-preferences-saved" });
    }

    if (intent === "ask") {
      const question = z
        .string()
        .trim()
        .min(1, "Ask a question about the workspace.")
        .max(500)
        .parse(formData.get("question"));
      const answer = await answerStaffAssistant({
        context,
        request,
        question,
      });
      return payload({ kind: "assistant", ...answer });
    }

    if (intent === "analyze-file") {
      const file = formData.get("file");
      if (!(file instanceof File)) {
        throw new ShelfError({
          cause: null,
          message: "Choose a CSV, XLSX, or PDF file to review.",
          label: "Assets",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      const proposal = await prepareStaffInventoryImport({
        context,
        request,
        file,
      });
      return payload({ kind: "import-proposal", proposal });
    }

    const operationId = z
      .string()
      .min(1)
      .max(100)
      .parse(formData.get("operationId"));
    if (intent === "cancel-import") {
      const result = await cancelStaffInventoryImport({
        context,
        request,
        operationId,
      });
      return payload({ kind: "import-cancelled", result });
    }
    const pdfDecisions = formData.get("pdfDecisions");
    const reviewDecisions = formData.get("reviewDecisions");
    const result = await applyStaffInventoryImport({
      context,
      request,
      operationId,
      pdfDecisions: typeof pdfDecisions === "string" ? pdfDecisions : null,
      reviewDecisions:
        typeof reviewDecisions === "string" ? reviewDecisions : null,
    });
    return payload({ kind: "import-result", result });
  } catch (cause) {
    const reason = makeShelfError(cause);
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = () => [
  { title: appendToMetaTitle("Home") },
];

export const handle = {
  breadcrumb: () => <Link to="/home">Home</Link>,
};

export default function HomePage() {
  const {
    dashboardPreferences,
    isStaff,
    importNotice,
    importProposal,
    labTasks,
    purchasing,
    taHours,
  } = useLoaderData<typeof loader>();
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );
  const labStatus = layoutData?.labStatus ?? null;
  const dashboardUser = layoutData?.user;
  const dashboardUserName =
    resolveUserDisplayName(dashboardUser) || "Your TA hours";
  const hiddenWidgets = new Set(dashboardPreferences.hidden);
  const widgets: Record<StaffDashboardWidgetId, ReactNode> = {
    operations: labStatus ? <LabStatusCard status={labStatus} /> : null,
    purchasing: purchasing ? (
      <section
        aria-labelledby="dashboard-purchasing-heading"
        className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2
              id="dashboard-purchasing-heading"
              className="text-lg font-black text-gray-950"
            >
              Purchasing
            </h2>
            <p className="text-sm text-gray-600">
              Academic year {purchasing.academicYear}
            </p>
          </div>
          <Link
            to="/purchasing"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Open purchasing
          </Link>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <DashboardHoursValue
            label="Annual budget"
            value={formatDashboardCurrency(
              purchasing.budget,
              purchasing.currency
            )}
          />
          <DashboardHoursValue
            label="Spent"
            value={formatDashboardCurrency(
              purchasing.spent,
              purchasing.currency
            )}
          />
          <DashboardHoursValue
            label="Open requests"
            value={String(purchasing.openRequests)}
          />
        </div>
      </section>
    ) : null,
    lab_tasks: labTasks ? (
      <section
        aria-labelledby="dashboard-lab-tasks-heading"
        className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2
              id="dashboard-lab-tasks-heading"
              className="text-lg font-black text-gray-950"
            >
              Lab tasks
            </h2>
            <p className="text-sm text-gray-600">
              {labTasks.openCount} open task
              {labTasks.openCount === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/operations/tasks?new=1"
              reloadDocument
              className="inline-flex items-center justify-center rounded-lg bg-red-700 px-3 py-2 text-sm font-bold text-white hover:bg-red-800"
            >
              Add task
            </Link>
            <Link
              to="/operations/tasks"
              reloadDocument
              className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
            >
              View all
            </Link>
          </div>
        </div>
        {labTasks.tasks.length ? (
          <ul className="mt-3 divide-y divide-gray-100">
            {labTasks.tasks.map(
              (
                task: Awaited<
                  ReturnType<typeof getDashboardLabTasks>
                >["tasks"][number]
              ) => (
                <li
                  key={task.id}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 first:pt-0 last:pb-0"
                >
                  <span className="min-w-0 text-sm font-semibold text-gray-900">
                    {task.title}
                  </span>
                  <span className="text-xs text-gray-500">
                    {task.assignedTo
                      ? task.assignedTo.displayName ||
                        [task.assignedTo.firstName, task.assignedTo.lastName]
                          .filter(Boolean)
                          .join(" ") ||
                        task.assignedTo.email
                      : "Unassigned"}
                    {task.dueDate
                      ? ` · Due ${new Intl.DateTimeFormat("en-GB", {
                          day: "numeric",
                          month: "short",
                          timeZone: "UTC",
                        }).format(task.dueDate)}`
                      : ""}
                    {task.isOverdue ? " · Overdue" : ""}
                  </span>
                </li>
              )
            )}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-gray-500">
            No open tasks. Add one when something needs doing.
          </p>
        )}
      </section>
    ) : null,
    ta_hours: taHours ? (
      <section
        aria-labelledby="dashboard-ta-hours-heading"
        className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="dashboard-ta-hours-heading"
            className="text-lg font-black text-gray-950"
          >
            TA hours
          </h2>
          <Link
            to={`/ta-hours?year=${encodeURIComponent(
              taHours.academicYear
            )}&view=overview`}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            View TA hours
          </Link>
        </div>
        <div className="mt-4 flex min-w-0 items-start gap-3">
          <img
            src={
              dashboardUser?.profilePicture || "/static/images/default_pfp.jpg"
            }
            alt=""
            className="size-9 shrink-0 rounded-full object-cover"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="min-w-0 truncate font-semibold text-gray-900">
                {dashboardUserName}
              </p>
              {taHours.personalAllocatedHours > 0 ? (
                <p
                  className={`shrink-0 text-base font-bold tabular-nums ${
                    taHours.personalHoursBalance < 0
                      ? "text-green-700"
                      : "text-gray-950"
                  }`}
                >
                  {formatHours(Math.abs(taHours.personalHoursBalance))}{" "}
                  {taHours.personalHoursBalance < 0 ? "overtime" : "left"}
                </p>
              ) : null}
            </div>
            {taHours.personalAllocatedHours > 0 ? (
              <>
                <p className="mt-0.5 text-sm text-gray-600">
                  {formatDashboardHourAmount(taHours.personalWorkedHours)} of{" "}
                  {formatHours(taHours.personalAllocatedHours)} worked
                </p>
                <div
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100"
                  role="progressbar"
                  aria-label={`${dashboardUserName}'s confirmed TA hours`}
                  aria-valuemin={0}
                  aria-valuemax={taHours.personalAllocatedHours}
                  aria-valuenow={Math.min(
                    taHours.personalWorkedHours,
                    taHours.personalAllocatedHours
                  )}
                >
                  <div
                    className="h-full rounded-full bg-red-600 transition-[width]"
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(
                          0,
                          (taHours.personalWorkedHours /
                            taHours.personalAllocatedHours) *
                            100
                        )
                      )}%`,
                    }}
                  />
                </div>
              </>
            ) : (
              <p className="mt-0.5 text-sm text-gray-600">
                No TA-hours allocation for {taHours.academicYear}.
              </p>
            )}
          </div>
        </div>
      </section>
    ) : null,
    inventory_import: (
      <StaffImportPanel
        actionPath="/home"
        initialNotice={importNotice}
        initialProposal={importProposal}
      />
    ),
  };

  return (
    <div className="-mx-4 min-h-full bg-white px-4 py-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-red-700">
              IOIO Lab / Staff
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-gray-950 sm:text-4xl">
              Staff Dashboard
            </h1>
          </div>
          {isStaff ? (
            <DashboardCustomizer preferences={dashboardPreferences} />
          ) : null}
        </header>

        <form
          action="/staff/ask"
          method="get"
          className="mt-7 rounded-2xl border border-gray-200 bg-white p-3 shadow-sm sm:p-4"
        >
          <label htmlFor="staff-dashboard-search" className="sr-only">
            Ask IOIO about inventory, loans, or reports
          </label>
          <div className="flex items-center gap-3">
            <input
              id="staff-dashboard-search"
              name="q"
              type="search"
              placeholder="Ask IOIO about inventory, loans, or reports..."
              autoComplete="off"
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 text-sm text-gray-950 outline-none placeholder:text-gray-500 focus:border-red-400 focus:ring-4 focus:ring-red-50"
            />
            <button
              type="submit"
              className="min-h-11 rounded-xl bg-red-700 px-4 text-sm font-bold text-white transition hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
            >
              Ask IOIO
            </button>
          </div>
        </form>

        {isStaff ? (
          <div className="mt-6 space-y-6">
            {dashboardPreferences.order.map(
              (widgetId: StaffDashboardWidgetId) =>
                hiddenWidgets.has(widgetId) ? null : (
                  <div key={widgetId}>{widgets[widgetId]}</div>
                )
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function DashboardHoursValue({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="rounded-xl bg-gray-50 px-3 py-2.5">
      <p className="text-xs font-semibold text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-black tabular-nums text-gray-950">
        {value}
      </p>
      {note ? <p className="mt-1 text-xs text-gray-500">{note}</p> : null}
    </div>
  );
}

function formatHours(value: number) {
  return `${new Intl.NumberFormat("en-SE", {
    maximumFractionDigits: 2,
  }).format(value)} h`;
}

function formatDashboardHourAmount(value: number) {
  return new Intl.NumberFormat("en-SE", {
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDashboardCurrency(amount: number, currency: string) {
  return new Intl.NumberFormat("en-SE", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

export const ErrorBoundary = () => <ErrorContent />;
