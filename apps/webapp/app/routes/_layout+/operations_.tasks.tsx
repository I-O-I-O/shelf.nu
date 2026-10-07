import { useEffect, useRef, useState } from "react";
import {
  Check,
  MoreHorizontal,
  Plus,
  RotateCcw,
  UserRound,
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
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigate,
} from "react-router";
import { SelectableRow } from "~/components/ioio-staff/selectable-row";
import { Dialog, DialogPortal } from "~/components/layout/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/shared/dropdown";
import {
  formatLabTaskCreatedAt,
  getVisibleSelectedLabTaskIds,
  getLabTaskDisplayName,
  LAB_TASK_PRIORITY_LABELS,
  toggleAllVisibleLabTaskSelections,
  toggleLabTaskSelection,
} from "~/modules/ioio-staff/lab-tasks";
import {
  createLabTask,
  getLabTaskAssignees,
  getLabTaskDateKey,
  getLabTasks,
  requireLabTaskAccess,
  setLabTaskCompleted,
  setLabTasksCompleted,
  softDeleteLabTask,
  updateLabTask,
} from "~/modules/ioio-staff/lab-tasks.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ShelfError } from "~/utils/error";

type TaskFilter = "open" | "completed";
type TaskSort = "newest" | "priority";
type LabTaskRow = Awaited<ReturnType<typeof getLabTasks>>[number];
const TASK_FILTERS: TaskFilter[] = ["open", "completed"];

function getFilter(value: string | null): TaskFilter {
  return value === "completed" ? "completed" : "open";
}

function getSort(value: string | null): TaskSort {
  return value === "priority" ? "priority" : "newest";
}

function getMineOnly(url: URL) {
  return (
    url.searchParams.get("filter") === "mine" ||
    (url.searchParams.get("filter") !== "completed" &&
      url.searchParams.get("mine") === "1")
  );
}

function taskFilterHref(
  filter: TaskFilter,
  mineOnly = false,
  sort: TaskSort = "newest"
) {
  const params = new URLSearchParams({ filter, sort });
  if (filter === "open" && mineOnly) params.set("mine", "1");
  return `/operations/tasks?${params.toString()}`;
}

function displayDate(date: Date | null) {
  if (!date) return null;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function taskNotice(value: string | null) {
  const notices: Record<string, string> = {
    created: "Task created",
    updated: "Task updated",
    completed: "Task completed",
    reopened: "Task reopened",
    deleted: "Task deleted",
  };
  return value ? notices[value] ?? null : null;
}

export const meta: MetaFunction<typeof loader> = () => [
  { title: appendToMetaTitle("Lab Tasks") },
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  const access = await requireLabTaskAccess({ userId, request });
  const url = new URL(request.url);
  const filter = getFilter(url.searchParams.get("filter"));
  const sort = getSort(url.searchParams.get("sort"));
  const mineOnly = filter === "open" && getMineOnly(url);
  const [tasks, assignees] = await Promise.all([
    getLabTasks({
      organizationId: access.organizationId,
      userId,
      filter: filter === "completed" ? "completed" : mineOnly ? "mine" : "open",
      sort,
    }),
    getLabTaskAssignees(access.organizationId),
  ]);

  return data({
    filter,
    sort,
    mineOnly,
    tasks,
    assignees,
    currentUserId: userId,
    notice: taskNotice(url.searchParams.get("notice")),
    today: getLabTaskDateKey(new Date()),
    startWithCreateOpen: url.searchParams.get("new") === "1",
  });
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  let submittedIntent = "";
  let submittedTaskId = "";
  try {
    const access = await requireLabTaskAccess({ userId, request });
    const form = await request.formData();
    const intent = String(form.get("intent") ?? "");
    const taskId = String(form.get("taskId") ?? "");
    submittedIntent = intent;
    submittedTaskId = taskId;
    const requestUrl = new URL(request.url);
    const rawFilter = String(
      form.get("filter") ?? requestUrl.searchParams.get("filter") ?? "open"
    );
    const filter = getFilter(rawFilter);
    const sort = getSort(
      String(form.get("sort") ?? requestUrl.searchParams.get("sort"))
    );
    const mineOnly =
      filter === "open" &&
      (rawFilter === "mine" ||
        form.get("mineOnly") === "1" ||
        requestUrl.searchParams.get("mine") === "1");
    const basePath = taskFilterHref(filter, mineOnly, sort);
    if (intent === "create") {
      await createLabTask({
        organizationId: access.organizationId,
        userId,
        title: String(form.get("title") ?? ""),
        description: String(form.get("description") ?? ""),
        assignedToUserId: String(form.get("assignedToUserId") ?? "") || null,
        dueDate: String(form.get("dueDate") ?? ""),
        priority: String(form.get("priority") ?? "IMPORTANT"),
      });
      return redirect(`${taskFilterHref("open", false, sort)}&notice=created`);
    }

    if (intent === "update") {
      await updateLabTask({
        organizationId: access.organizationId,
        taskId,
        title: String(form.get("title") ?? ""),
        description: String(form.get("description") ?? ""),
        assignedToUserId: String(form.get("assignedToUserId") ?? "") || null,
        dueDate: String(form.get("dueDate") ?? ""),
        priority: String(form.get("priority") ?? "NORMAL"),
      });
      return redirect(`${basePath}&notice=updated`);
    }

    if (intent === "complete" || intent === "reopen") {
      await setLabTaskCompleted({
        organizationId: access.organizationId,
        taskId,
        userId,
        completed: intent === "complete",
      });
      return redirect(
        `/operations/tasks?filter=${
          intent === "complete" ? "completed" : "open"
        }&sort=${sort}&notice=${
          intent === "complete" ? "completed" : "reopened"
        }`
      );
    }

    if (intent === "bulkComplete" || intent === "bulkReopen") {
      const rawIds = String(form.get("taskIds") ?? "");
      let taskIds: unknown;
      try {
        taskIds = JSON.parse(rawIds);
      } catch {
        throw new ShelfError({
          cause: null,
          message: "Select the tasks you want to update.",
          label: "Request validation",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      if (
        !Array.isArray(taskIds) ||
        taskIds.some((id) => typeof id !== "string" || id.length > 100)
      ) {
        throw new ShelfError({
          cause: null,
          message: "The selected task list is invalid. Select the tasks again.",
          label: "Request validation",
          status: 400,
          shouldBeCaptured: false,
        });
      }
      const completed = intent === "bulkComplete";
      const count = await setLabTasksCompleted({
        organizationId: access.organizationId,
        taskIds,
        userId,
        completed,
      });
      return data({
        ok: true as const,
        kind: completed ? "bulk-completed" : "bulk-reopened",
        count,
      });
    }

    if (intent === "delete") {
      await softDeleteLabTask({
        organizationId: access.organizationId,
        taskId,
      });
      return redirect(`${basePath}&notice=deleted`);
    }

    throw new ShelfError({
      cause: null,
      message: "Choose a valid task action.",
      label: "Request validation",
      status: 400,
      shouldBeCaptured: false,
    });
  } catch (cause) {
    if (!(cause instanceof ShelfError)) throw cause;
    return data(
      {
        ok: false as const,
        error: cause.message,
        formIntent: submittedIntent,
        taskId: submittedTaskId,
      },
      { status: cause.status }
    );
  }
}

function TaskFields({
  task,
  assignees,
}: {
  task?: LabTaskRow;
  assignees: Awaited<ReturnType<typeof getLabTaskAssignees>>;
}) {
  return (
    <>
      <label className="block text-sm font-semibold text-gray-800">
        Title
        <input
          name="title"
          required
          maxLength={180}
          defaultValue={task?.title ?? ""}
          placeholder="e.g. Check returned Arduino Kits"
          className="mt-1 block h-10 w-full rounded-lg border border-gray-300 px-3 font-normal outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
        />
      </label>
      <label className="block text-sm font-semibold text-gray-800">
        Description{" "}
        <span className="font-normal text-gray-500">(optional)</span>
        <textarea
          name="description"
          rows={3}
          maxLength={5000}
          defaultValue={task?.description ?? ""}
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 font-normal outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm font-semibold text-gray-800">
          Assigned to
          <select
            name="assignedToUserId"
            defaultValue={task?.assignedToUserId ?? ""}
            className="mt-1 block h-10 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
          >
            <option value="">Unassigned</option>
            {assignees.map((person) => (
              <option key={person.id} value={person.id}>
                {getLabTaskDisplayName(person)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-semibold text-gray-800">
          Due date <span className="font-normal text-gray-500">(optional)</span>
          <input
            type="date"
            name="dueDate"
            defaultValue={task?.dueDateKey ?? ""}
            className="mt-1 block h-10 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
          />
        </label>
        <label className="block text-sm font-semibold text-gray-800">
          Priority
          <select
            name="priority"
            defaultValue={task?.priority ?? "IMPORTANT"}
            className="mt-1 block h-10 w-full rounded-lg border border-gray-300 bg-white px-3 font-normal outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100"
          >
            <option value="URGENT">{LAB_TASK_PRIORITY_LABELS.URGENT}</option>
            <option value="IMPORTANT">
              {LAB_TASK_PRIORITY_LABELS.IMPORTANT}
            </option>
            <option value="NORMAL">{LAB_TASK_PRIORITY_LABELS.NORMAL}</option>
          </select>
        </label>
      </div>
    </>
  );
}

function TaskRow({
  task,
  filter,
  mineOnly,
  sort,
  assignees,
  selected,
  onToggle,
  actionError,
}: {
  task: LabTaskRow;
  filter: TaskFilter;
  mineOnly: boolean;
  sort: TaskSort;
  assignees: Awaited<ReturnType<typeof getLabTaskAssignees>>;
  selected: boolean;
  onToggle: () => void;
  actionError: string | null;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const isCompleted = task.status === "COMPLETED";

  useEffect(() => {
    setEditOpen(false);
  }, [task.updatedAt]);

  return (
    <li className="list-none">
      <SelectableRow
        selected={selected}
        onToggle={onToggle}
        variant="list"
        className="p-0"
      >
        <div className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-4 sm:grid-cols-[1.25rem_minmax(0,1fr)_auto] sm:gap-x-4">
          <input
            type="checkbox"
            checked={selected}
            onClick={(event) => event.stopPropagation()}
            onChange={onToggle}
            aria-label={`Select task ${task.title} for bulk actions`}
            className="row-span-2 size-4 place-self-center accent-red-700 sm:row-span-1"
          />

          <div className="col-start-2 row-start-1 flex min-w-0 flex-col">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h2
                className={`min-w-0 break-words text-sm font-bold ${
                  isCompleted ? "text-gray-500 line-through" : "text-gray-950"
                }`}
              >
                {task.title}
              </h2>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[0.68rem] font-bold ${
                  task.priority === "URGENT"
                    ? "bg-red-100 text-red-800"
                    : task.priority === "IMPORTANT"
                    ? "bg-amber-100 text-amber-800"
                    : "bg-gray-100 text-gray-700"
                }`}
              >
                {LAB_TASK_PRIORITY_LABELS[task.priority]}
              </span>
              {task.isOverdue ? (
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-[0.68rem] font-bold text-red-800">
                  Overdue
                </span>
              ) : null}
            </div>
            {task.description ? (
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-5 text-gray-600">
                {task.description}
              </p>
            ) : null}

            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
              <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
                {task.assignedTo ? (
                  <UserRound
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-gray-400"
                  />
                ) : null}
                {task.assignedTo
                  ? getLabTaskDisplayName(task.assignedTo)
                  : "Unassigned"}
                <span aria-hidden="true">·</span>
                Created {formatLabTaskCreatedAt(task.createdAt)}
              </span>
              {task.dueDate ? (
                <span
                  className={task.isOverdue ? "font-semibold text-red-700" : ""}
                >
                  Due {displayDate(task.dueDate)}
                </span>
              ) : null}
              {isCompleted ? (
                <span className="text-gray-400">
                  Completed by {getLabTaskDisplayName(task.completedBy)}
                  {task.completedAt
                    ? ` · ${displayDate(task.completedAt)}`
                    : ""}
                </span>
              ) : null}
            </div>
          </div>

          <div className="col-start-2 row-start-2 flex items-center justify-end gap-2 sm:col-start-3 sm:row-span-1 sm:row-start-1 sm:self-center">
            <Form method="post" className="shrink-0">
              <input type="hidden" name="taskId" value={task.id} />
              <input type="hidden" name="filter" value={filter} />
              <input type="hidden" name="sort" value={sort} />
              <input
                type="hidden"
                name="mineOnly"
                value={mineOnly ? "1" : "0"}
              />
              <button
                type="submit"
                name="intent"
                value={isCompleted ? "reopen" : "complete"}
                className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 ${
                  isCompleted
                    ? "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                    : "bg-red-700 text-white hover:bg-red-800"
                }`}
              >
                {isCompleted ? (
                  <RotateCcw aria-hidden="true" className="size-4" />
                ) : (
                  <Check aria-hidden="true" className="size-4" />
                )}
                {isCompleted ? "Reopen" : "Mark complete"}
              </button>
            </Form>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Actions for ${task.title}`}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-500 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-1"
                >
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                  Edit / reassign task
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setDeleteOpen(true)}>
                  Delete task
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </SelectableRow>

      <DialogPortal>
        <Dialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          title="Edit task"
          className="w-[min(40rem,calc(100vw-2rem))]"
        >
          <Form method="post" className="space-y-4 px-6 py-4">
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="filter" value={filter} />
            <input type="hidden" name="sort" value={sort} />
            <input type="hidden" name="mineOnly" value={mineOnly ? "1" : "0"} />
            <TaskFields task={task} assignees={assignees} />
            {actionError ? (
              <p role="alert" className="text-sm font-semibold text-red-700">
                {actionError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditOpen(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
              >
                Save changes
              </button>
            </div>
          </Form>
        </Dialog>
      </DialogPortal>

      <DialogPortal>
        <Dialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          title="Remove task?"
          className="w-[min(30rem,calc(100vw-2rem))]"
        >
          <Form method="post" className="space-y-4 px-6 py-4">
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="taskId" value={task.id} />
            <input type="hidden" name="filter" value={filter} />
            <input type="hidden" name="sort" value={sort} />
            <input type="hidden" name="mineOnly" value={mineOnly ? "1" : "0"} />
            <p className="text-sm text-gray-600">
              “{task.title}” will be removed from the active task list. Its
              record will be retained.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteOpen(false)}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
              >
                Remove task
              </button>
            </div>
          </Form>
        </Dialog>
      </DialogPortal>
    </li>
  );
}

export default function LabTasksPage() {
  const {
    filter,
    sort,
    mineOnly,
    tasks,
    assignees,
    notice,
    startWithCreateOpen,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const bulkFetcher = useFetcher<{
    ok?: boolean;
    kind?: string;
    count?: number;
    error?: string;
  }>();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(startWithCreateOpen);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(
    () => new Set()
  );
  const visibleTaskIds = tasks.map((task) => task.id);
  const selectedVisibleTaskIds = getVisibleSelectedLabTaskIds(
    selectedTaskIds,
    visibleTaskIds
  );
  const allVisibleSelected =
    tasks.length > 0 && selectedVisibleTaskIds.length === tasks.length;
  const selectAllRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selectedVisibleTaskIds.length > 0 && !allVisibleSelected;
    }
  }, [allVisibleSelected, selectedVisibleTaskIds.length]);

  useEffect(() => {
    if (startWithCreateOpen) setCreateOpen(true);
    else if (notice === "Task created") setCreateOpen(false);
  }, [notice, startWithCreateOpen]);

  useEffect(() => {
    setSelectedTaskIds(new Set());
  }, [filter, mineOnly, sort]);

  useEffect(() => {
    if (bulkFetcher.state !== "idle" || !bulkFetcher.data?.ok) return;
    if (
      bulkFetcher.data.kind !== "bulk-completed" &&
      bulkFetcher.data.kind !== "bulk-reopened"
    ) {
      return;
    }
    setSelectedTaskIds(new Set());
    const completed = bulkFetcher.data.kind === "bulk-completed";
    void navigate(
      `/operations/tasks?filter=${
        completed ? "completed" : "open"
      }&sort=${sort}&notice=${completed ? "completed" : "reopened"}`
    );
  }, [bulkFetcher.data, bulkFetcher.state, navigate, sort]);

  function closeCreate() {
    setCreateOpen(false);
    if (startWithCreateOpen) {
      void navigate(taskFilterHref(filter, mineOnly, sort), { replace: true });
    }
  }

  function openCreate() {
    setCreateOpen(true);
    void navigate(taskFilterHref(filter, mineOnly, sort), { replace: true });
  }

  return (
    <div className="mx-auto max-w-4xl py-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
            Operations
          </p>
          <h1 className="mt-1 text-3xl font-black tracking-tight text-gray-950">
            Lab Tasks
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Shared to-dos for Staff, TAs, and teachers.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-red-700 px-4 text-sm font-bold text-white hover:bg-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-2"
        >
          <Plus aria-hidden="true" className="size-4" />
          New task
        </button>
      </header>

      {notice ? (
        <p
          role="status"
          className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm font-semibold text-green-800"
        >
          {notice}
        </p>
      ) : null}
      {actionData &&
      !actionData.ok &&
      actionData.formIntent !== "create" &&
      actionData.formIntent !== "update" ? (
        <p
          role="alert"
          className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-800"
        >
          {actionData.error}
        </p>
      ) : null}

      <DialogPortal>
        <Dialog
          open={createOpen}
          onClose={closeCreate}
          title="Add task"
          className="w-[min(40rem,calc(100vw-2rem))]"
        >
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="sort" value={sort} />
            <div className="space-y-4 px-6 py-4">
              <TaskFields assignees={assignees} />
              {actionData &&
              !actionData.ok &&
              actionData.formIntent === "create" ? (
                <p role="alert" className="text-sm font-semibold text-red-700">
                  {actionData.error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={closeCreate}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-red-700 px-3 py-2 text-sm font-semibold text-white hover:bg-red-800"
                >
                  Add task
                </button>
              </div>
            </div>
          </Form>
        </Dialog>
      </DialogPortal>

      <div className="mt-6 border-b border-gray-200">
        <nav aria-label="Task status filters" className="flex gap-1">
          {TASK_FILTERS.map((item) => (
            <Link
              key={item}
              to={taskFilterHref(item, item === "open" && mineOnly, sort)}
              aria-current={filter === item ? "page" : undefined}
              className={`border-b-2 px-3 py-2 text-sm font-semibold ${
                filter === item
                  ? "border-red-700 text-red-800"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {item === "open" ? "Open" : "Completed"}
            </Link>
          ))}
        </nav>
      </div>
      <div className="mt-3 grid min-h-[4.5rem] grid-cols-1 grid-rows-[2rem_2rem] gap-y-1 sm:min-h-10 sm:grid-cols-[minmax(0,1fr)_auto] sm:grid-rows-1 sm:gap-y-0">
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2.5">
          {filter === "open" ? (
            <>
              <span className="text-xs font-semibold text-gray-500">
                Filters
              </span>
              <button
                type="button"
                aria-pressed={mineOnly}
                onClick={() =>
                  void navigate(taskFilterHref("open", !mineOnly, sort), {
                    replace: true,
                  })
                }
                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-700 focus-visible:ring-offset-1 ${
                  mineOnly
                    ? "border-red-200 bg-red-50 text-red-800"
                    : "border-gray-300 bg-white text-gray-700 hover:border-gray-400 hover:bg-gray-50"
                }`}
              >
                {mineOnly ? (
                  <Check aria-hidden="true" className="size-3.5 text-red-700" />
                ) : (
                  <UserRound aria-hidden="true" className="size-3.5" />
                )}
                My tasks
              </button>
            </>
          ) : null}
          <label className="inline-flex h-8 shrink-0 items-center gap-1.5 text-xs font-semibold text-gray-600">
            Sort:
            <select
              aria-label="Sort tasks"
              value={sort}
              onChange={(event) =>
                void navigate(
                  taskFilterHref(filter, mineOnly, getSort(event.target.value)),
                  { replace: true }
                )
              }
              className="h-8 w-32 shrink-0 rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs font-semibold text-gray-700 outline-none focus:border-red-600 focus:ring-2 focus:ring-red-100 sm:w-36"
            >
              <option value="newest">Newest</option>
              <option value="priority">Highest priority</option>
            </select>
          </label>
        </div>
        <div className="col-start-1 row-start-2 flex items-center justify-between gap-2 sm:col-start-2 sm:row-start-1 sm:justify-end">
          <label className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-xs font-semibold text-gray-700 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 hover:bg-gray-100">
            <input
              ref={selectAllRef}
              type="checkbox"
              checked={allVisibleSelected}
              aria-label="Select all visible tasks"
              aria-checked={
                selectedVisibleTaskIds.length > 0 && !allVisibleSelected
                  ? "mixed"
                  : allVisibleSelected
              }
              disabled={tasks.length === 0}
              onChange={() =>
                setSelectedTaskIds((current) =>
                  toggleAllVisibleLabTaskSelections(current, visibleTaskIds)
                )
              }
              className="size-4 accent-red-700"
            />
            Select all
          </label>
          {selectedVisibleTaskIds.length ? (
            <>
              <span className="mr-1 text-xs text-gray-500">
                {selectedVisibleTaskIds.length} selected
              </span>
              <bulkFetcher.Form method="post" className="flex items-center">
                <input
                  type="hidden"
                  name="intent"
                  value={filter === "completed" ? "bulkReopen" : "bulkComplete"}
                />
                <input
                  type="hidden"
                  name="taskIds"
                  value={JSON.stringify(selectedVisibleTaskIds)}
                />
                <input type="hidden" name="filter" value={filter} />
                <input type="hidden" name="sort" value={sort} />
                <input
                  type="hidden"
                  name="mineOnly"
                  value={mineOnly ? "1" : "0"}
                />
                <button
                  type="submit"
                  disabled={bulkFetcher.state !== "idle"}
                  className="inline-flex h-8 items-center rounded-lg bg-red-700 px-3 text-xs font-semibold text-white hover:bg-red-800 disabled:opacity-60"
                >
                  {bulkFetcher.state !== "idle"
                    ? "Updating..."
                    : filter === "completed"
                    ? "Reopen"
                    : "Mark complete"}
                </button>
              </bulkFetcher.Form>
              <button
                type="button"
                onClick={() => setSelectedTaskIds(new Set())}
                className="inline-flex h-8 items-center rounded-lg px-2 text-xs font-semibold text-gray-600 hover:bg-gray-100 hover:text-gray-900"
              >
                Clear
              </button>
            </>
          ) : null}
        </div>
      </div>
      {bulkFetcher.data?.error ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {bulkFetcher.data.error}
        </p>
      ) : null}

      {tasks.length ? (
        <ul className="mt-3 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              filter={filter}
              sort={sort}
              mineOnly={mineOnly}
              assignees={assignees}
              actionError={
                actionData &&
                !actionData.ok &&
                actionData.formIntent === "update" &&
                actionData.taskId === task.id
                  ? actionData.error
                  : null
              }
              selected={selectedTaskIds.has(task.id)}
              onToggle={() =>
                setSelectedTaskIds((current) =>
                  toggleLabTaskSelection(current, task.id)
                )
              }
            />
          ))}
        </ul>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed border-gray-300 bg-white px-5 py-10 text-center">
          <p className="text-sm font-semibold text-gray-700">
            {filter === "completed"
              ? "No completed tasks yet."
              : mineOnly
              ? "No open tasks assigned to you."
              : "No open tasks."}
          </p>
          {filter === "open" && !mineOnly ? (
            <button
              type="button"
              onClick={openCreate}
              className="mt-3 inline-flex items-center gap-1 text-sm font-bold text-red-800 hover:text-red-900"
            >
              <Plus aria-hidden="true" className="size-4" /> Add the first task
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
