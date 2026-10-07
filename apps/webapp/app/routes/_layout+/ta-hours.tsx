import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  Popover,
  PopoverContent,
  PopoverPortal,
  PopoverTrigger,
} from "@radix-ui/react-popover";
import {
  ChevronDown,
  Clock3,
  MoreHorizontal,
  Pencil,
  Plus,
} from "lucide-react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  Link,
  redirect,
  useFetcher,
  useActionData,
  useLoaderData,
  useNavigate,
} from "react-router";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/forms/select";
import { Dialog } from "~/components/layout/dialog";
import { getAcademicYear } from "~/modules/ioio-lab-information/service.server";
import {
  calculateTAHoursBalance,
  getScheduledHours,
} from "~/modules/ioio-staff/ta-hours";
import {
  cancelTAShift,
  createNextTAHoursPeriod,
  createTAShift,
  getTAHoursPageData,
  logTAHoursWorked,
  parseTAHoursAcademicYear,
  requireTAHoursAccess,
  saveTAHoursActual,
  saveTAHoursAllocation,
  undoLastTAHoursLog,
  updateTAHoursBudget,
  updateTAShift,
} from "~/modules/ioio-staff/ta-hours.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ShelfError } from "~/utils/error";
import { generateClientId } from "~/utils/id/client-id";

const title = "TA Hours";
const VIEWS = ["overview", "schedule", "timesheets"] as const;
type View = (typeof VIEWS)[number];
type PageData = Awaited<ReturnType<typeof getTAHoursPageData>> & {
  view: View;
  notice: string | null;
};

function getView(value: string | null): View {
  return VIEWS.includes(value as View) ? (value as View) : "overview";
}

function noticeText(notice: string | null) {
  const notices: Record<string, string> = {
    budget: "TA hour budget saved.",
    allocation: "TA allocation saved.",
    shift: "Shift saved.",
    cancelled: "Shift cancelled.",
    confirmed: "Worked hours saved.",
    period:
      "Next academic-year period created with an empty budget and no allocations.",
  };
  return notice ? notices[notice] ?? null : null;
}

export const meta: MetaFunction = () => [{ title: appendToMetaTitle(title) }];

export const handle = {
  breadcrumb: () => "TA Hours",
};

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  const access = await requireTAHoursAccess({ userId, request });
  const url = new URL(request.url);
  const academicYear = access.isStaff
    ? parseTAHoursAcademicYear(url.searchParams.get("year"))
    : getAcademicYear();
  const page = await getTAHoursPageData({
    organizationId: access.organizationId,
    academicYear,
    userId,
    isStaff: access.isStaff,
    isTA: access.isTA,
  });
  return {
    ...page,
    view: access.isStaff ? getView(url.searchParams.get("view")) : "overview",
    notice: noticeText(url.searchParams.get("notice")),
  };
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const access = await requireTAHoursAccess({ userId, request });
    const form = await request.formData();
    const intent = String(form.get("intent") ?? "");
    const academicYear = parseTAHoursAcademicYear(
      String(
        form.get("academicYear") ??
          new URL(request.url).searchParams.get("year")
      )
    );
    const view = getView(String(form.get("view") ?? "overview"));
    const returnPath = `/ta-hours?year=${encodeURIComponent(
      academicYear
    )}&view=${view}`;
    const confirmedOverBudget = form.get("confirmedOverBudget") === "1";

    if (intent === "saveActual") {
      await saveTAHoursActual({
        organizationId: access.organizationId,
        shiftId: String(form.get("shiftId") ?? ""),
        actorUserId: userId,
        isStaff: access.isStaff,
        actualHours: form.get("actualHours"),
        reason: form.get("reason"),
      });
      return redirect(`${returnPath}&notice=confirmed`);
    }
    if (intent === "logWorkedHours") {
      const result = await logTAHoursWorked({
        organizationId: access.organizationId,
        actorUserId: userId,
        targetTAUserId: form.get("targetTAUserId"),
        isTA: access.isTA,
        isStaff: access.isStaff,
        academicYear,
        hours: form.get("hoursWorked"),
        workDate: form.get("workDate"),
        submissionKey: form.get("submissionKey"),
        allowAdditional: form.get("allowAdditional") === "1",
      });
      return data({ quickEntry: result });
    }
    if (intent === "undoLastLog") {
      await undoLastTAHoursLog({
        organizationId: access.organizationId,
        actorUserId: userId,
        targetTAUserId: form.get("targetTAUserId"),
        isTA: access.isTA,
        isStaff: access.isStaff,
        academicYear,
        shiftId: form.get("shiftId"),
      });
      return data({ undoLog: true });
    }
    if (!access.isStaff) {
      throw new ShelfError({
        cause: null,
        message: "Only authorized Staff can manage TA hours and schedules.",
        label: "TA Hours",
        status: 403,
        shouldBeCaptured: false,
      });
    }
    if (intent === "createNextPeriod") {
      const nextPeriod = await createNextTAHoursPeriod({
        organizationId: access.organizationId,
      });
      return redirect(
        `/ta-hours?year=${encodeURIComponent(
          nextPeriod.academicYear
        )}&view=overview&notice=period`
      );
    }
    if (intent === "saveBudget") {
      await updateTAHoursBudget({
        organizationId: access.organizationId,
        academicYear,
        userId,
        mode: form.get("budgetMode"),
        totalHoursBudget: form.get("totalHoursBudget"),
        budgetAmountSek: form.get("budgetAmountSek"),
        hourlyRateSekPerHour: form.get("hourlyRateSekPerHour"),
        reason: form.get("reason"),
        confirmedOverBudget,
      });
      return redirect(`${returnPath}&notice=budget`);
    }
    if (intent === "saveAllocation") {
      await saveTAHoursAllocation({
        organizationId: access.organizationId,
        academicYear,
        userId,
        taUserId: String(form.get("taUserId") ?? ""),
        hours: form.get("allocatedHours"),
        confirmedOverBudget,
      });
      return redirect(`${returnPath}&notice=allocation`);
    }
    if (intent === "createShift") {
      await createTAShift({
        organizationId: access.organizationId,
        academicYear,
        userId,
        taUserId: String(form.get("taUserId") ?? ""),
        date: form.get("scheduledDate"),
        startTime: form.get("scheduledStartTime"),
        endTime: form.get("scheduledEndTime"),
        confirmedOverBudget,
      });
      return redirect(`${returnPath}&notice=shift`);
    }
    if (intent === "updateShift") {
      await updateTAShift({
        organizationId: access.organizationId,
        shiftId: String(form.get("shiftId") ?? ""),
        taUserId: String(form.get("taUserId") ?? ""),
        date: form.get("scheduledDate"),
        startTime: form.get("scheduledStartTime"),
        endTime: form.get("scheduledEndTime"),
        confirmedOverBudget,
      });
      return redirect(`${returnPath}&notice=shift`);
    }
    if (intent === "cancelShift") {
      await cancelTAShift({
        organizationId: access.organizationId,
        shiftId: String(form.get("shiftId") ?? ""),
      });
      return redirect(`${returnPath}&notice=cancelled`);
    }
    throw new ShelfError({
      cause: null,
      message: "That TA hours action is not available.",
      label: "TA Hours",
      status: 400,
      shouldBeCaptured: false,
    });
  } catch (cause) {
    if (cause instanceof ShelfError) {
      return data({ error: cause.message }, { status: cause.status });
    }
    throw cause;
  }
}

function hours(value: number | string | null | undefined) {
  const amount = Number(value ?? 0);
  return `${new Intl.NumberFormat("en-SE", {
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0)} h`;
}

function displayDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function compactDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    SCHEDULED: "Scheduled",
    AWAITING_CONFIRMATION: "Awaiting confirmation",
    CONFIRMED: "Confirmed",
    ADJUSTED: "Adjusted",
  };
  return labels[status] ?? status;
}

function statusClass(status: string) {
  if (status === "AWAITING_CONFIRMATION")
    return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "ADJUSTED") return "border-blue-200 bg-blue-50 text-blue-900";
  if (status === "CONFIRMED")
    return "border-green-200 bg-green-50 text-green-900";
  return "border-gray-200 bg-gray-50 text-gray-700";
}

function viewHref(page: PageData, view: View) {
  return `/ta-hours?year=${encodeURIComponent(
    page.period.academicYear
  )}&view=${view}`;
}

function TAAllocationCard({
  allocation,
  page,
  onLogHours,
}: {
  allocation: PageData["allocations"][number];
  page: PageData;
  onLogHours: (userId: string) => void;
}) {
  const [editingAllocation, setEditingAllocation] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const undoFetcher = useFetcher<typeof action>();
  const allocated = Number(allocation.allocatedHours);
  const worked = Number(allocation.workedHours);
  const balance = calculateTAHoursBalance(allocated, worked);
  const canLogHours = page.period.academicYear === page.activeAcademicYear;
  const canUndo = Boolean(allocation.recentLog) && canLogHours;

  return (
    <article className="grid grid-cols-1 items-center gap-4 py-4 md:grid-cols-[minmax(12rem,1fr)_minmax(18rem,1.5fr)_auto]">
      <div className="flex min-w-0 items-center gap-3">
        <img
          src={allocation.profilePicture || "/static/images/default_pfp.jpg"}
          alt=""
          className="size-10 shrink-0 rounded-full object-cover"
          onError={(event) => {
            event.currentTarget.src = "/static/images/default_pfp.jpg";
          }}
        />
        <div className="min-w-0">
          <p className="truncate font-bold text-gray-950">{allocation.name}</p>
          <p className="truncate text-xs text-gray-500">{allocation.email}</p>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3 sm:gap-5">
        <div>
          <p className="text-xs text-gray-500">Allocated</p>
          <p className="font-semibold tabular-nums text-gray-900">
            {hours(allocated)}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Worked</p>
          <p className="font-semibold tabular-nums text-gray-900">
            {hours(worked)}
          </p>
        </div>
        <div>
          <p className="text-xs text-gray-500">Remaining</p>
          {balance.overtime > 0 ? (
            <p className="font-semibold tabular-nums text-green-700">
              {hours(balance.overtime)} overtime
            </p>
          ) : (
            <p className="font-semibold tabular-nums text-gray-900">
              {hours(balance.hoursLeft)}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={() => onLogHours(allocation.userId)}
          disabled={!canLogHours}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-300 px-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Clock3 className="size-4" aria-hidden="true" /> Log hours
        </button>
        <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={`Actions for ${allocation.name}`}
              className="inline-flex size-9 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600"
            >
              <MoreHorizontal className="size-5" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent
              align="end"
              sideOffset={4}
              className="z-[100] min-w-48 rounded-lg border border-gray-200 bg-white p-1 shadow-lg"
            >
              <button
                type="button"
                onClick={() => {
                  setActionsOpen(false);
                  setEditingAllocation(true);
                }}
                className="block w-full rounded-md px-3 py-2 text-left text-sm text-gray-800 hover:bg-gray-50"
              >
                Edit allocation
              </button>
              {canUndo && allocation.recentLog ? (
                <UndoLastLogForm
                  page={page}
                  fetcher={undoFetcher}
                  shiftId={allocation.recentLog.shiftId}
                  targetTAUserId={allocation.userId}
                  menuItem
                />
              ) : null}
            </PopoverContent>
          </PopoverPortal>
        </Popover>
      </div>
      {editingAllocation ? (
        <Dialog
          open
          onClose={() => setEditingAllocation(false)}
          title={<h2 className="text-lg font-bold">Edit allocation</h2>}
          className="w-full max-w-lg"
        >
          <Form
            method="post"
            action={viewHref(page, "overview")}
            className="space-y-4 p-6"
            onSubmit={(event) =>
              confirmAllocationOverage(event, page, allocation)
            }
          >
            <FormCommon page={page} intent="saveAllocation" />
            <input type="hidden" name="taUserId" value={allocation.userId} />
            <input type="hidden" name="confirmedOverBudget" value="0" />
            <label className="block text-sm font-semibold text-gray-700">
              Total allocation
              <input
                name="allocatedHours"
                type="number"
                min="0"
                max="100000"
                step="0.25"
                required
                defaultValue={allocation.allocatedHours}
                className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3"
              />
              <span className="mt-1 block text-xs font-normal text-gray-500">
                Set the person’s total allocated hours for this period.
              </span>
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingAllocation(false)}
                className="h-10 rounded-lg border border-gray-300 px-4 text-sm font-semibold"
              >
                Cancel
              </button>
              <button className="h-10 rounded-lg bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800">
                Save allocation
              </button>
            </div>
          </Form>
        </Dialog>
      ) : null}
    </article>
  );
}

function UndoLastLogForm({
  page,
  fetcher,
  shiftId,
  targetTAUserId,
  menuItem = false,
}: {
  page: PageData;
  fetcher: ReturnType<typeof useFetcher<typeof action>>;
  shiftId: string;
  targetTAUserId?: string;
  menuItem?: boolean;
}) {
  const result = fetcher.data as
    | { undoLog?: boolean; error?: string }
    | undefined;
  return (
    <div
      className={
        menuItem ? "" : "inline-flex flex-wrap items-center gap-x-2 gap-y-1"
      }
    >
      <fetcher.Form
        method="post"
        action={viewHref(page, "overview")}
        onSubmit={(event) => {
          if (
            !window.confirm(
              "Remove the latest hours log and restore the previous hours?"
            )
          ) {
            event.preventDefault();
          }
        }}
      >
        <FormCommon page={page} intent="undoLastLog" />
        <input type="hidden" name="shiftId" value={shiftId} />
        {targetTAUserId ? (
          <input type="hidden" name="targetTAUserId" value={targetTAUserId} />
        ) : null}
        <button
          type="submit"
          disabled={fetcher.state !== "idle"}
          className={
            menuItem
              ? "block w-full rounded-md px-3 py-2 text-left text-sm text-gray-800 hover:bg-gray-50 disabled:opacity-60"
              : "font-semibold text-red-700 underline-offset-2 hover:underline disabled:opacity-60"
          }
        >
          {fetcher.state !== "idle" ? "Removing…" : "Remove last log"}
        </button>
      </fetcher.Form>
      {result?.undoLog ? (
        <span role="status" className="text-green-700">
          Hours restored.
        </span>
      ) : null}
      {result?.error ? (
        <span role="alert" className="text-red-700">
          {result.error}
        </span>
      ) : null}
    </div>
  );
}

function PersonalQuickLog({ page }: { page: PageData }) {
  const fetcher = useFetcher<typeof action>();
  const undoFetcher = useFetcher<typeof action>();
  const formRef = useRef<HTMLFormElement>(null);
  const result = fetcher.data as
    | {
        quickEntry?: { kind: "logged"; actualHours: string; entryId: string };
        error?: string;
      }
    | undefined;
  const loggedEntryId = result?.quickEntry?.entryId;

  useEffect(() => {
    if (loggedEntryId) formRef.current?.reset();
  }, [loggedEntryId]);

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <fetcher.Form
        ref={formRef}
        method="post"
        action={viewHref(page, "overview")}
        className="flex flex-wrap items-center gap-2"
      >
        <FormCommon page={page} intent="logWorkedHours" />
        <input
          type="hidden"
          name="submissionKey"
          value={page.quickEntryKey}
          readOnly
        />
        <input type="hidden" name="allowAdditional" value="1" />
        <label className="inline-flex h-10 items-center gap-2 text-sm font-semibold text-gray-700">
          Hours worked
          <input
            name="hoursWorked"
            type="number"
            min="0.01"
            max="9999.99"
            step="0.01"
            required
            className="h-10 w-28 rounded-lg border border-gray-300 px-3 text-sm tabular-nums"
          />
        </label>
        <button
          type="submit"
          disabled={fetcher.state !== "idle"}
          className="h-10 rounded-lg bg-red-700 px-3 text-sm font-bold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {fetcher.state !== "idle" ? "Logging…" : "Log hours"}
        </button>
        {result?.quickEntry ? (
          <span role="status" className="text-sm font-semibold text-green-700">
            {hours(result.quickEntry.actualHours)} logged
          </span>
        ) : null}
        {result?.error ? (
          <span role="alert" className="text-sm font-medium text-red-700">
            {result.error}
          </span>
        ) : null}
      </fetcher.Form>
      {page.personalRecentLog ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
          <span>
            Last logged · {compactDate(page.personalRecentLog.date)} ·{" "}
            {hours(page.personalRecentLog.hours)}
          </span>
          {page.period.academicYear === page.activeAcademicYear ? (
            <UndoLastLogForm
              page={page}
              fetcher={undoFetcher}
              shiftId={page.personalRecentLog.shiftId}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export default function TAHoursPage() {
  const page = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as
    | { error?: string }
    | undefined;
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-red-700">
            IOIO Lab / TA hours
          </p>
          <h1 className="mt-1 text-3xl font-black tracking-tight text-gray-950">
            {page.isStaff ? "TA hours" : "My TA hours"}
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {page.isStaff
              ? "Plan shifts and manage confirmed hours."
              : "Confirm recent shifts and check your hours balance."}
          </p>
        </div>
        {page.isStaff ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1 text-sm font-semibold text-gray-700">
              <label htmlFor="ta-hours-academic-year">Academic year</label>
              <Select
                value={page.period.academicYear}
                onValueChange={(year) =>
                  navigate(
                    `/ta-hours?year=${encodeURIComponent(year)}&view=${
                      page.view
                    }`
                  )
                }
              >
                <SelectTrigger
                  id="ta-hours-academic-year"
                  hideArrow
                  className="inline-flex h-10 w-44 shrink-0 items-center justify-between gap-2 px-3 py-0 text-sm font-semibold leading-none text-gray-800 focus:border-red-600 focus:ring-red-100"
                >
                  <SelectValue />
                  <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
                </SelectTrigger>
                <SelectContent position="popper" align="end">
                  {page.years.map((year) => (
                    <SelectItem
                      key={year}
                      value={year}
                      className="min-h-10 px-3 data-[state=checked]:bg-red-50 [&>div>span>svg]:!size-3.5 [&>div>span]:ml-3 [&>div>span]:mr-0 [&>div>span]:text-red-700"
                    >
                      {year}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {page.isStaff ? (
              <Form method="post">
                <input type="hidden" name="intent" value="createNextPeriod" />
                <input
                  type="hidden"
                  name="academicYear"
                  value={page.period.academicYear}
                />
                <input type="hidden" name="view" value={page.view} />
                <button className="h-10 rounded-lg border border-gray-300 bg-white px-3 text-sm font-semibold text-gray-800 hover:bg-gray-50">
                  Create next period
                </button>
              </Form>
            ) : null}
          </div>
        ) : null}
      </header>

      {page.notice ? (
        <div
          role="status"
          className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm font-medium text-green-900"
        >
          {page.notice}
        </div>
      ) : null}
      {actionData?.error ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-900"
        >
          {actionData.error}
        </div>
      ) : null}

      {page.isStaff ? (
        <nav
          aria-label="TA Hours views"
          className="flex gap-1 border-b border-gray-200"
        >
          {VIEWS.map((view) => (
            <Link
              key={view}
              to={viewHref(page, view)}
              className={`border-b-2 px-3 py-2 text-sm font-semibold capitalize ${
                page.view === view
                  ? "border-red-700 text-red-800"
                  : "border-transparent text-gray-600 hover:text-gray-950"
              }`}
            >
              {view}
            </Link>
          ))}
        </nav>
      ) : null}

      {page.view === "overview" ? (
        <Overview page={page} />
      ) : page.view === "schedule" ? (
        <Schedule page={page} />
      ) : (
        <Timesheets page={page} />
      )}
    </div>
  );
}

function Overview({ page }: { page: PageData }) {
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [allocateOpen, setAllocateOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [selectedLogUser, setSelectedLogUser] = useState("");
  const [selectedAllocateUser, setSelectedAllocateUser] = useState("");
  const [allocatedInput, setAllocatedInput] = useState("0");
  const [logSubmissionKey, setLogSubmissionKey] = useState("");
  const logFetcher = useFetcher<typeof action>();
  const logResult = logFetcher.data as
    | {
        quickEntry?: { kind: "logged" | "alreadyLogged"; actualHours: string };
        error?: string;
      }
    | undefined;
  const selectedAllocation = page.allocations.find(
    (allocation) => allocation.userId === selectedAllocateUser
  );
  const currentSelectedAllocation = Number(
    selectedAllocation?.allocatedHours ?? 0
  );
  const proposedAllocation = Number(allocatedInput);
  const logSucceeded = Boolean(logResult?.quickEntry?.kind === "logged");

  useEffect(() => {
    if (logSucceeded) setLogOpen(false);
  }, [logSucceeded]);

  return (
    <div className="space-y-6">
      {page.isStaff ? (
        <section
          aria-label="TA hours summary"
          className="rounded-xl border border-gray-200 bg-white px-5 py-4"
        >
          <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <div className="relative min-w-0">
              <p className="text-xs font-semibold text-gray-500">
                Total budget
              </p>
              <p className="mt-1 text-2xl font-black tabular-nums text-gray-950">
                {hours(page.summary.budget)}
              </p>
              {page.period.budgetAmountSek !== null ? (
                <p className="mt-0.5 text-sm font-medium tabular-nums text-gray-600">
                  {formatSek(page.period.budgetAmountSek)}
                </p>
              ) : null}
              <button
                type="button"
                onClick={() => setBudgetOpen(true)}
                className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-900"
              >
                <Pencil className="size-3.5" aria-hidden="true" /> Edit
              </button>
            </div>
            <SummaryMetric
              label="Allocated"
              value={hours(page.summary.allocated)}
            />
            <SummaryMetric label="Worked" value={hours(page.summary.worked)} />
            <SummaryMetric
              label="Scheduled"
              value={hours(page.summary.scheduled)}
              note="Planned shifts"
            />
          </div>
        </section>
      ) : null}
      {page.isStaff && page.summary.allocated > page.summary.budget ? (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950"
        >
          TA allocations exceed the total budget by{" "}
          {hours(page.summary.allocated - page.summary.budget)}.
        </p>
      ) : null}
      {page.isStaff && page.summary.worked > page.summary.budget ? (
        <p
          role="status"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950"
        >
          TA hour budget exceeded by{" "}
          {hours(page.summary.worked - page.summary.budget)}.
        </p>
      ) : null}

      {!page.isStaff && page.canSelfLog ? (
        <PersonalQuickLog page={page} />
      ) : null}
      {page.isStaff ? (
        <>
          <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-black text-gray-950">
                TA allocations
              </h2>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedAllocateUser("");
                    setAllocatedInput("0");
                    setAllocateOpen(true);
                  }}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800"
                >
                  <Plus className="size-4" aria-hidden="true" /> Allocate hours
                </button>
              </div>
            </div>

            {page.allocations.length ? (
              <div className="mt-5 divide-y divide-gray-100 border-t border-gray-100 pt-4">
                {page.allocations.map((allocation) => (
                  <TAAllocationCard
                    key={allocation.id}
                    allocation={allocation}
                    page={page}
                    onLogHours={(userId) => {
                      setSelectedLogUser(userId);
                      setLogSubmissionKey(generateClientId());
                      setLogOpen(true);
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="mt-4 rounded-xl bg-gray-50 px-4 py-6 text-center text-sm text-gray-600">
                No TAs are included in this academic-year plan yet.
              </p>
            )}
          </section>

          {page.budgetAdjustments.length ? (
            <section className="border-t border-gray-200 pt-4">
              <h2 className="text-sm font-bold text-gray-700">
                Budget history
              </h2>
              <ul className="mt-2 divide-y divide-gray-100 text-sm text-gray-600">
                {page.budgetAdjustments.map((adjustment) => (
                  <li
                    key={adjustment.id}
                    className="grid gap-1 py-2 sm:grid-cols-[11rem_1fr_auto] sm:items-center"
                  >
                    <span className="text-xs text-gray-500">
                      {displayDate(
                        adjustment.createdAt.toISOString().slice(0, 10)
                      )}
                    </span>
                    <span>
                      {hours(adjustment.previousHours)}{" "}
                      <span aria-hidden="true">→</span>{" "}
                      {hours(adjustment.newHours)}
                      {adjustment.reason ? ` · ${adjustment.reason}` : ""}
                    </span>
                    <span className="text-xs text-gray-500">
                      {adjustment.changedByName}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
      {page.isStaff && budgetOpen ? (
        <BudgetEditor page={page} onClose={() => setBudgetOpen(false)} />
      ) : null}
      {page.isStaff && allocateOpen ? (
        <Dialog
          open
          onClose={() => setAllocateOpen(false)}
          title={<h2 className="text-lg font-bold">Allocate hours</h2>}
          className="w-full max-w-lg"
        >
          <Form
            method="post"
            action={viewHref(page, "overview")}
            className="space-y-4 p-6"
            onSubmit={(event) =>
              confirmAllocationOverage(event, page, selectedAllocation)
            }
          >
            <FormCommon page={page} intent="saveAllocation" />
            <input type="hidden" name="confirmedOverBudget" value="0" />
            <label className="block text-sm font-semibold text-gray-700">
              Person
              <select
                name="taUserId"
                required
                value={selectedAllocateUser}
                onChange={(event) => {
                  setSelectedAllocateUser(event.currentTarget.value);
                  const existing = page.allocations.find(
                    (row) => row.userId === event.currentTarget.value
                  );
                  setAllocatedInput(existing?.allocatedHours ?? "0");
                }}
                className="mt-1 h-10 w-full rounded-lg border border-gray-300 bg-white px-3"
              >
                <option value="" disabled>
                  Select Staff or Lab TA
                </option>
                {page.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} · {candidate.email}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-semibold text-gray-700">
              Total allocated hours
              <input
                name="allocatedHours"
                type="number"
                min="0"
                max="100000"
                step="0.25"
                required
                value={allocatedInput}
                onChange={(event) =>
                  setAllocatedInput(event.currentTarget.value)
                }
                className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3"
              />
            </label>
            {selectedAllocateUser ? (
              <p className="text-sm text-gray-600">
                Current allocation: {hours(currentSelectedAllocation)}
                <br />
                After allocation: {hours(proposedAllocation)}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAllocateOpen(false)}
                className="h-10 rounded-lg border border-gray-300 px-4 text-sm font-semibold"
              >
                Cancel
              </button>
              <button className="h-10 rounded-lg bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800">
                Allocate
              </button>
            </div>
          </Form>
        </Dialog>
      ) : null}
      {page.isStaff && logOpen ? (
        <Dialog
          open
          onClose={() => setLogOpen(false)}
          title={<h2 className="text-lg font-bold">Log hours</h2>}
          className="w-full max-w-lg"
        >
          <logFetcher.Form
            method="post"
            action={viewHref(page, "overview")}
            className="space-y-4 p-6"
          >
            <FormCommon page={page} intent="logWorkedHours" />
            <input type="hidden" name="allowAdditional" value="1" />
            <input
              type="hidden"
              name="submissionKey"
              value={logSubmissionKey}
            />
            <label className="block text-sm font-semibold text-gray-700">
              Person
              <select
                name="targetTAUserId"
                required
                value={selectedLogUser}
                onChange={(event) =>
                  setSelectedLogUser(event.currentTarget.value)
                }
                className="mt-1 h-10 w-full rounded-lg border border-gray-300 bg-white px-3"
              >
                <option value="" disabled>
                  Select Staff or Lab TA
                </option>
                {page.candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} · {candidate.email}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-semibold text-gray-700">
              Hours worked
              <input
                name="hoursWorked"
                type="number"
                min="0.01"
                max="9999.99"
                step="0.01"
                required
                className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3"
              />
            </label>
            <label className="block text-sm font-semibold text-gray-700">
              Date
              <input
                name="workDate"
                type="date"
                required
                defaultValue={page.todayDateKey}
                className="mt-1 h-10 w-full rounded-lg border border-gray-300 px-3"
              />
            </label>
            {page.period.academicYear !== page.activeAcademicYear ? (
              <p className="text-sm text-amber-800">
                Hours can only be logged in the current academic year.
              </p>
            ) : null}
            {logResult?.quickEntry?.kind === "alreadyLogged" ? (
              <p role="status" className="text-sm text-gray-600">
                {hours(logResult.quickEntry.actualHours)} are already recorded
                for this date.
              </p>
            ) : null}
            {logResult?.error ? (
              <p role="alert" className="text-sm text-red-700">
                {logResult.error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setLogOpen(false)}
                className="h-10 rounded-lg border border-gray-300 px-4 text-sm font-semibold"
              >
                Cancel
              </button>
              <button
                disabled={
                  logFetcher.state !== "idle" ||
                  page.period.academicYear !== page.activeAcademicYear
                }
                className="h-10 rounded-lg bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800 disabled:opacity-50"
              >
                {logFetcher.state !== "idle" ? "Logging…" : "Log hours"}
              </button>
            </div>
          </logFetcher.Form>
        </Dialog>
      ) : null}
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-black tabular-nums text-gray-950">
        {value}
      </p>
      {note ? <p className="mt-0.5 text-xs text-gray-500">{note}</p> : null}
    </div>
  );
}

function formatSek(value: string) {
  return `${new Intl.NumberFormat("en-SE", { maximumFractionDigits: 2 }).format(
    Number(value)
  )} SEK`;
}

function BudgetEditor({
  page,
  onClose,
}: {
  page: PageData;
  onClose: () => void;
}) {
  const initialMode = page.period.budgetAmountSek !== null ? "budget" : "hours";
  const [mode, setMode] = useState<"budget" | "hours">(initialMode);
  const [hoursValue, setHoursValue] = useState(page.period.totalHoursBudget);
  const [budgetValue, setBudgetValue] = useState(
    page.period.budgetAmountSek ?? ""
  );
  const [rateValue, setRateValue] = useState(
    page.period.hourlyRateSekPerHour ?? ""
  );
  const hoursNumber = Number(hoursValue);
  const budgetNumber = Number(budgetValue);
  const rateNumber = Number(rateValue);
  const previewHours =
    mode === "budget" && rateNumber > 0 && Number.isFinite(budgetNumber)
      ? (budgetNumber / rateNumber).toFixed(2)
      : hoursValue;
  const previewBudget =
    mode === "hours" && Number.isFinite(hoursNumber) && rateNumber > 0
      ? (hoursNumber * rateNumber).toFixed(2)
      : budgetValue;

  return (
    <Dialog
      open
      onClose={onClose}
      title={<h2 className="text-lg font-bold">Edit TA budget</h2>}
      className="w-full max-w-lg"
    >
      <Form
        method="post"
        action={viewHref(page, "overview")}
        className="space-y-4 p-6"
        onSubmit={(event) => {
          const committed = page.summary.worked + page.summary.scheduled;
          const proposed = Number(previewHours);
          const overage = committed - proposed;
          if (
            overage > 0 &&
            !window.confirm(
              `The budget will be ${hours(
                overage
              )} below confirmed and scheduled hours. Continue?`
            )
          ) {
            event.preventDefault();
            return;
          }
          setConfirmedFlag(event.currentTarget, overage > 0);
        }}
      >
        <FormCommon page={page} intent="saveBudget" />
        <input type="hidden" name="confirmedOverBudget" value="0" />
        <input type="hidden" name="budgetMode" value={mode} />
        <div
          role="group"
          aria-label="Budget input mode"
          className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1"
        >
          <button
            type="button"
            onClick={() => setMode("budget")}
            aria-pressed={mode === "budget"}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
              mode === "budget"
                ? "bg-white text-red-700 shadow-sm"
                : "text-gray-600"
            }`}
          >
            Budget
          </button>
          <button
            type="button"
            onClick={() => setMode("hours")}
            aria-pressed={mode === "hours"}
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
              mode === "hours"
                ? "bg-white text-red-700 shadow-sm"
                : "text-gray-600"
            }`}
          >
            Hours
          </button>
        </div>
        {mode === "budget" ? (
          <label className="block text-sm font-semibold text-gray-700">
            Budget
            <span className="mt-1 flex h-10 items-center rounded-lg border border-gray-300 focus-within:ring-2 focus-within:ring-red-100">
              <input
                name="budgetAmountSek"
                type="number"
                min="0"
                step="0.01"
                required
                value={budgetValue}
                onChange={(event) => setBudgetValue(event.currentTarget.value)}
                className="h-full min-w-0 flex-1 rounded-l-lg px-3 outline-none"
              />
              <span className="px-3 text-sm text-gray-500">SEK</span>
            </span>
          </label>
        ) : (
          <label className="block text-sm font-semibold text-gray-700">
            Hours
            <span className="mt-1 flex h-10 items-center rounded-lg border border-gray-300">
              <input
                name="totalHoursBudget"
                type="number"
                min="0"
                max="100000"
                step="0.01"
                required
                value={hoursValue}
                onChange={(event) => setHoursValue(event.currentTarget.value)}
                className="h-full min-w-0 flex-1 rounded-l-lg px-3 outline-none"
              />
              <span className="px-3 text-sm text-gray-500">h</span>
            </span>
          </label>
        )}
        <label className="block text-sm font-semibold text-gray-700">
          Hourly rate
          <span className="mt-1 flex h-10 items-center rounded-lg border border-gray-300">
            <input
              name="hourlyRateSekPerHour"
              type="number"
              min="0.01"
              step="0.01"
              required
              value={rateValue}
              onChange={(event) => setRateValue(event.currentTarget.value)}
              className="h-full min-w-0 flex-1 rounded-l-lg px-3 outline-none"
            />
            <span className="px-3 text-sm text-gray-500">SEK / h</span>
          </span>
        </label>
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
          {mode === "budget" ? (
            <>
              Available hours{" "}
              <strong className="ml-1 tabular-nums">
                {rateNumber > 0 && budgetValue !== ""
                  ? `${previewHours} h`
                  : "—"}
              </strong>
            </>
          ) : (
            <>
              Required budget{" "}
              <strong className="ml-1 tabular-nums">
                {rateNumber > 0 && hoursValue !== ""
                  ? formatSek(previewBudget)
                  : "—"}
              </strong>
            </>
          )}
        </p>
        <p className="text-xs text-gray-500">
          The hours or SEK amount shown above is calculated from your selected
          input and rate.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-lg border border-gray-300 px-4 text-sm font-semibold"
          >
            Cancel
          </button>
          <button className="h-10 rounded-lg bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800">
            Save budget
          </button>
        </div>
      </Form>
    </Dialog>
  );
}

function FormCommon({ page, intent }: { page: PageData; intent: string }) {
  return (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input
        type="hidden"
        name="academicYear"
        value={page.period.academicYear}
      />
      <input type="hidden" name="view" value={page.view} />
    </>
  );
}

function setConfirmedFlag(form: HTMLFormElement, confirmed: boolean) {
  const field = form.elements.namedItem("confirmedOverBudget");
  if (field instanceof HTMLInputElement) field.value = confirmed ? "1" : "0";
}

function confirmAllocationOverage(
  event: FormEvent<HTMLFormElement>,
  page: PageData,
  current?: PageData["allocations"][number]
) {
  const form = new FormData(event.currentTarget);
  const proposedHours = Number(form.get("allocatedHours"));
  const otherAllocations =
    page.summary.allocated - Number(current?.allocatedHours ?? 0);
  const overage = otherAllocations + proposedHours - page.summary.budget;
  if (
    overage > 0 &&
    !window.confirm(
      `TA allocations will exceed the total hour budget by ${hours(
        overage
      )}. Continue?`
    )
  ) {
    event.preventDefault();
    return;
  }
  setConfirmedFlag(event.currentTarget, overage > 0);
}

function isFutureShift(date: string, startTime: string) {
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    dateParts.map(({ type, value }) => [type, value])
  );
  const today = `${values.year}-${values.month}-${values.day}`;
  const nowTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
  return date > today || (date === today && startTime > nowTime);
}

function confirmShiftOverage(
  event: FormEvent<HTMLFormElement>,
  page: PageData,
  existing?: PageData["shifts"][number]
) {
  const form = new FormData(event.currentTarget);
  const date = String(form.get("scheduledDate") ?? "");
  const start = String(form.get("scheduledStartTime") ?? "");
  const end = String(form.get("scheduledEndTime") ?? "");
  const duration = getScheduledHours(start, end) ?? 0;
  const selectedTA = page.allocations.find(
    (allocation) => allocation.userId === form.get("taUserId")
  );
  const replacementIsFuture = isFutureShift(date, start);
  const oldShiftIsCounted = Boolean(
    existing &&
      existing.displayStatus === "SCHEDULED" &&
      isFutureShift(existing.scheduledDateKey, existing.scheduledStartTime)
  );
  const selectedTARemaining = Number(selectedTA?.projectedRemainingHours ?? 0);
  const oldHoursForSelectedTA =
    oldShiftIsCounted && existing?.userId === selectedTA?.userId
      ? existing?.scheduledHours ?? 0
      : 0;
  const taAfter =
    selectedTARemaining +
    oldHoursForSelectedTA -
    (replacementIsFuture ? duration : 0);
  const warnings = [
    taAfter < 0
      ? `${hours(Math.abs(taAfter))} above this TA's allocation`
      : null,
  ].filter(Boolean);
  if (
    warnings.length &&
    !window.confirm(`This shift will put ${warnings.join(" and ")}. Continue?`)
  ) {
    event.preventDefault();
    return;
  }
  setConfirmedFlag(event.currentTarget, warnings.length > 0);
}

function Schedule({ page }: { page: PageData }) {
  const editableShifts = page.shifts.filter(
    (shift) =>
      shift.displayStatus === "SCHEDULED" ||
      shift.displayStatus === "AWAITING_CONFIRMATION"
  );
  return (
    <div className="space-y-5">
      {page.isStaff ? (
        <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 className="text-lg font-black text-gray-950">Add TA shift</h2>
          <p className="mt-1 text-sm text-gray-600">
            Planned time is not counted as worked until the TA or Staff confirms
            it.
          </p>
          {page.openingHoursEnabled ? (
            <p className="mt-2 text-xs text-gray-500">
              New shifts start with the next available normal opening time. You
              can change it or schedule outside opening hours.
            </p>
          ) : null}
          <Form
            method="post"
            action={viewHref(page, "schedule")}
            className="mt-4 grid gap-3 sm:grid-cols-5 sm:items-end"
            onSubmit={(event) => {
              confirmShiftOverage(event, page);
            }}
          >
            <FormCommon page={page} intent="createShift" />
            <input type="hidden" name="confirmedOverBudget" value="0" />
            <label className="text-sm font-semibold text-gray-700">
              TA
              <select
                name="taUserId"
                required
                defaultValue=""
                className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2"
              >
                <option value="" disabled>
                  Select a TA in this plan
                </option>
                {page.allocations.map((allocation) => (
                  <option key={allocation.userId} value={allocation.userId}>
                    {allocation.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-semibold text-gray-700">
              Date
              <input
                type="date"
                name="scheduledDate"
                required
                min={page.period.startDateKey}
                max={page.period.endDateKey}
                defaultValue={page.defaultShift.date}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
              />
            </label>
            <label className="text-sm font-semibold text-gray-700">
              Start
              <input
                type="time"
                name="scheduledStartTime"
                required
                defaultValue={page.defaultShift.startTime}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
              />
            </label>
            <label className="text-sm font-semibold text-gray-700">
              End
              <input
                type="time"
                name="scheduledEndTime"
                required
                defaultValue={page.defaultShift.endTime}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2"
              />
            </label>
            <button className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800">
              <Plus className="size-4" /> Add shift
            </button>
          </Form>
        </section>
      ) : null}

      <ShiftList
        page={page}
        shifts={page.shifts.filter(
          (shift) => shift.displayStatus === "SCHEDULED"
        )}
        title={page.isStaff ? "Planned schedule" : "Upcoming shifts"}
      />
      {page.isStaff ? (
        <ShiftList
          page={page}
          shifts={editableShifts.filter(
            (shift) => shift.displayStatus === "AWAITING_CONFIRMATION"
          )}
          title="Past shifts awaiting confirmation"
        />
      ) : null}
    </div>
  );
}

function ShiftList({
  page,
  shifts,
  title,
}: {
  page: PageData;
  shifts: PageData["shifts"];
  title: string;
}) {
  const grouped = new Map<string, typeof shifts>();
  for (const shift of shifts) {
    const date = grouped.get(shift.scheduledDateKey) ?? [];
    date.push(shift);
    grouped.set(shift.scheduledDateKey, date);
  }
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
      <h2 className="text-lg font-black text-gray-950">{title}</h2>
      {grouped.size ? (
        <div className="mt-3 space-y-5">
          {[...grouped.entries()].map(([date, dayShifts]) => (
            <div key={date}>
              <h3 className="border-b border-gray-100 pb-2 text-sm font-bold text-gray-700">
                {displayDate(date)}
              </h3>
              <ul className="divide-y divide-gray-100">
                {dayShifts.map((shift) => (
                  <li key={shift.id} className="py-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-bold text-gray-950">
                          {page.isStaff
                            ? shift.user.displayName ||
                              [shift.user.firstName, shift.user.lastName]
                                .filter(Boolean)
                                .join(" ") ||
                              shift.user.email
                            : "Your shift"}
                        </p>
                        <p className="mt-0.5 text-sm text-gray-600">
                          {shift.scheduledStartTime}–{shift.scheduledEndTime} ·{" "}
                          {hours(shift.scheduledHours)}
                        </p>
                        {shift.outsideOpeningHours ? (
                          <p className="mt-1 text-xs font-medium text-amber-800">
                            Outside normal IOIO opening hours
                          </p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full border px-2.5 py-1 text-xs font-bold ${statusClass(
                            shift.displayStatus
                          )}`}
                        >
                          {statusLabel(shift.displayStatus)}
                        </span>
                        {page.isStaff && shift.displayStatus === "SCHEDULED" ? (
                          <details className="relative">
                            <summary className="cursor-pointer rounded-md border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-700">
                              Edit
                            </summary>
                            <Form
                              method="post"
                              action={viewHref(page, "schedule")}
                              className="absolute right-0 z-10 mt-2 grid w-72 gap-2 rounded-xl border border-gray-200 bg-white p-3 shadow-lg"
                              onSubmit={(event) =>
                                confirmShiftOverage(event, page, shift)
                              }
                            >
                              <FormCommon page={page} intent="updateShift" />
                              <input
                                type="hidden"
                                name="shiftId"
                                value={shift.id}
                              />
                              <input
                                type="hidden"
                                name="confirmedOverBudget"
                                value="0"
                              />
                              <label className="text-xs font-semibold text-gray-700">
                                TA
                                <select
                                  name="taUserId"
                                  defaultValue={shift.userId}
                                  className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm"
                                >
                                  {page.allocations.map((allocation) => (
                                    <option
                                      key={allocation.userId}
                                      value={allocation.userId}
                                    >
                                      {allocation.name}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="text-xs font-semibold text-gray-700">
                                Date
                                <input
                                  type="date"
                                  name="scheduledDate"
                                  required
                                  defaultValue={shift.scheduledDateKey}
                                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                                />
                              </label>
                              <div className="grid grid-cols-2 gap-2">
                                <label className="text-xs font-semibold text-gray-700">
                                  Start
                                  <input
                                    type="time"
                                    name="scheduledStartTime"
                                    required
                                    defaultValue={shift.scheduledStartTime}
                                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                                  />
                                </label>
                                <label className="text-xs font-semibold text-gray-700">
                                  End
                                  <input
                                    type="time"
                                    name="scheduledEndTime"
                                    required
                                    defaultValue={shift.scheduledEndTime}
                                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                                  />
                                </label>
                              </div>
                              <button className="rounded bg-red-700 px-3 py-2 text-sm font-bold text-white">
                                Save shift
                              </button>
                            </Form>
                          </details>
                        ) : null}
                      </div>
                    </div>
                    {page.isStaff && shift.displayStatus === "SCHEDULED" ? (
                      <Form
                        method="post"
                        action={viewHref(page, "schedule")}
                        className="mt-2"
                        onSubmit={(event) => {
                          if (!window.confirm("Cancel this planned shift?"))
                            event.preventDefault();
                        }}
                      >
                        <FormCommon page={page} intent="cancelShift" />
                        <input type="hidden" name="shiftId" value={shift.id} />
                        <button className="text-xs font-semibold text-gray-500 underline hover:text-red-800">
                          Cancel shift
                        </button>
                      </Form>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 rounded-lg bg-gray-50 px-4 py-6 text-center text-sm text-gray-600">
          No shifts in this section.
        </p>
      )}
    </section>
  );
}

function Timesheets({ page }: { page: PageData }) {
  const pending = page.shifts.filter(
    (shift) => shift.displayStatus === "AWAITING_CONFIRMATION"
  );
  const completed = page.shifts.filter(
    (shift) =>
      shift.displayStatus === "CONFIRMED" || shift.displayStatus === "ADJUSTED"
  );
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-amber-200 bg-amber-50/50 p-4 shadow-sm sm:p-5">
        <div className="flex items-center gap-2">
          <Clock3 className="size-5 text-amber-800" />
          <h2 className="text-lg font-black text-gray-950">
            Awaiting confirmation
          </h2>
        </div>
        {pending.length ? (
          <div className="mt-3 divide-y divide-amber-100">
            {pending.map((shift) => (
              <TimesheetRow key={shift.id} page={page} shift={shift} />
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-gray-600">
            No TA hours need confirmation.
          </p>
        )}
      </section>
      <section className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="text-lg font-black text-gray-950">
          Confirmed timesheets
        </h2>
        {completed.length ? (
          <div className="mt-3 divide-y divide-gray-100">
            {completed.map((shift) => (
              <TimesheetRow key={shift.id} page={page} shift={shift} />
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm text-gray-600">
            No confirmed hours in this academic year yet.
          </p>
        )}
      </section>
    </div>
  );
}

function TimesheetRow({
  page,
  shift,
}: {
  page: PageData;
  shift: PageData["shifts"][number];
}) {
  const [adjusting, setAdjusting] = useState(false);
  const canEdit = page.isStaff || shift.userId === page.currentUserId;
  const canConfirm =
    canEdit &&
    (shift.displayStatus === "AWAITING_CONFIRMATION" ||
      shift.displayStatus === "CONFIRMED" ||
      shift.displayStatus === "ADJUSTED");
  return (
    <article className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-bold text-gray-950">
            {page.isStaff
              ? shift.user.displayName ||
                [shift.user.firstName, shift.user.lastName]
                  .filter(Boolean)
                  .join(" ") ||
                shift.user.email
              : "Your shift"}
          </p>
          <p className="mt-1 text-sm text-gray-600">
            {shift.isManual ? (
              <>{displayDate(shift.scheduledDateKey)} · Manual hours entry</>
            ) : (
              <>
                {displayDate(shift.scheduledDateKey)} · Scheduled{" "}
                {shift.scheduledStartTime}–{shift.scheduledEndTime} (
                {hours(shift.scheduledHours)})
              </>
            )}
          </p>
          {shift.actualHoursValue !== null ? (
            <p className="mt-1 text-sm font-semibold text-gray-800">
              Worked {hours(shift.actualHoursValue)}
            </p>
          ) : null}
          {shift.actualHoursReason ? (
            <p className="mt-1 text-xs text-gray-500">
              Note: {shift.actualHoursReason}
            </p>
          ) : null}
          {shift.corrections.length ? (
            <details className="mt-2 text-xs text-gray-600">
              <summary className="cursor-pointer font-semibold">
                Adjustment history
              </summary>
              <ul className="mt-1 space-y-1">
                {shift.corrections.map((correction) => (
                  <li key={correction.id}>
                    {correction.previousHours === null
                      ? "Scheduled"
                      : hours(correction.previousHours)}{" "}
                    → {hours(correction.newHours)} · {correction.changedByName}{" "}
                    ·{" "}
                    {new Intl.DateTimeFormat("en-GB", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(correction.createdAt)}
                    {correction.reason ? ` · ${correction.reason}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
        <span
          className={`rounded-full border px-2.5 py-1 text-xs font-bold ${statusClass(
            shift.displayStatus
          )}`}
        >
          {statusLabel(shift.displayStatus)}
        </span>
      </div>
      {canConfirm ? (
        <div className="mt-3">
          {shift.displayStatus === "AWAITING_CONFIRMATION" && !adjusting ? (
            <div className="flex flex-wrap items-center gap-2 rounded-xl bg-gray-50 p-3">
              <p className="mr-auto text-sm font-semibold text-gray-800">
                How long did you work?
              </p>
              <Form method="post" action={viewHref(page, "timesheets")}>
                <FormCommon page={page} intent="saveActual" />
                <input type="hidden" name="shiftId" value={shift.id} />
                <input
                  type="hidden"
                  name="actualHours"
                  value={shift.scheduledHours}
                />
                <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800">
                  Confirm {hours(shift.scheduledHours)}
                </button>
              </Form>
              <button
                type="button"
                onClick={() => setAdjusting(true)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-100"
              >
                Adjust
              </button>
            </div>
          ) : adjusting ? (
            <Form
              method="post"
              action={viewHref(page, "timesheets")}
              className="grid gap-2 rounded-xl bg-gray-50 p-3 sm:grid-cols-[10rem_minmax(12rem,1fr)_auto] sm:items-end"
            >
              <FormCommon page={page} intent="saveActual" />
              <input type="hidden" name="shiftId" value={shift.id} />
              <label className="text-xs font-semibold text-gray-600">
                Actual hours
                <input
                  name="actualHours"
                  type="number"
                  min="0"
                  max="100000"
                  step="0.01"
                  required
                  autoFocus
                  defaultValue={shift.actualHoursValue ?? shift.scheduledHours}
                  aria-label={`Actual hours for ${displayDate(
                    shift.scheduledDateKey
                  )}`}
                  className="mt-1 h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
                />
              </label>
              <label className="text-xs font-semibold text-gray-600">
                Note <span className="font-normal">(optional)</span>
                <input
                  name="reason"
                  maxLength={500}
                  defaultValue={shift.actualHoursReason ?? ""}
                  placeholder="Left early, stayed later, shift changed"
                  className="mt-1 h-10 w-full rounded-md border border-gray-300 bg-white px-3 text-sm"
                />
              </label>
              <div className="flex gap-2">
                <button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-bold text-white hover:bg-red-800">
                  Save hours
                </button>
                <button
                  type="button"
                  onClick={() => setAdjusting(false)}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-100"
                >
                  Cancel
                </button>
              </div>
            </Form>
          ) : (
            <button
              type="button"
              onClick={() => setAdjusting(true)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-800 hover:bg-gray-50"
            >
              Adjust hours
            </button>
          )}
          <p className="mt-2 text-xs text-gray-500">
            Enter the actual hours worked. This may be more or less than the
            scheduled duration.
          </p>
        </div>
      ) : null}
    </article>
  );
}
