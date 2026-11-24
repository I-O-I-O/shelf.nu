export type LabTaskPriority = "NORMAL" | "IMPORTANT" | "URGENT";
export type LabTaskSort = "newest" | "priority";

export const LAB_TASK_PRIORITY_LABELS: Record<LabTaskPriority, string> = {
  URGENT: "High",
  IMPORTANT: "Medium",
  NORMAL: "Low",
};

const LAB_TASK_PRIORITY_RANK: Record<LabTaskPriority, number> = {
  URGENT: 0,
  IMPORTANT: 1,
  NORMAL: 2,
};

export function compareLabTaskPriority(
  left: LabTaskPriority,
  right: LabTaskPriority
) {
  return LAB_TASK_PRIORITY_RANK[left] - LAB_TASK_PRIORITY_RANK[right];
}

export function compareOpenLabTaskOrder(
  left: {
    priority: LabTaskPriority;
    isOverdue: boolean;
    dueDateKey: string | null;
    createdAt: Date;
  },
  right: {
    priority: LabTaskPriority;
    isOverdue: boolean;
    dueDateKey: string | null;
    createdAt: Date;
  }
) {
  return (
    compareLabTaskPriority(left.priority, right.priority) ||
    Number(right.isOverdue) - Number(left.isOverdue) ||
    (left.dueDateKey ?? "9999-12-31").localeCompare(
      right.dueDateKey ?? "9999-12-31"
    ) ||
    right.createdAt.getTime() - left.createdAt.getTime()
  );
}

export function compareLabTaskSortOrder(
  left: {
    id: string;
    priority: LabTaskPriority;
    createdAt: Date;
  },
  right: {
    id: string;
    priority: LabTaskPriority;
    createdAt: Date;
  },
  sort: LabTaskSort
) {
  return (
    (sort === "priority"
      ? compareLabTaskPriority(left.priority, right.priority)
      : 0) ||
    right.createdAt.getTime() - left.createdAt.getTime() ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

export function formatLabTaskCreatedAt(date: Date, now = new Date()) {
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
  };
  if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
  return new Intl.DateTimeFormat("en-GB", options).format(date);
}

export function toggleLabTaskSelection(
  selectedIds: ReadonlySet<string>,
  taskId: string
) {
  const next = new Set(selectedIds);
  if (next.has(taskId)) next.delete(taskId);
  else next.add(taskId);
  return next;
}

export function toggleAllVisibleLabTaskSelections(
  selectedIds: ReadonlySet<string>,
  visibleTaskIds: readonly string[]
) {
  const allVisibleSelected =
    visibleTaskIds.length > 0 &&
    visibleTaskIds.every((taskId) => selectedIds.has(taskId));
  const next = new Set(selectedIds);

  for (const taskId of visibleTaskIds) {
    if (allVisibleSelected) next.delete(taskId);
    else next.add(taskId);
  }

  return next;
}

export function getVisibleSelectedLabTaskIds(
  selectedIds: ReadonlySet<string>,
  visibleTaskIds: readonly string[]
) {
  return visibleTaskIds.filter((taskId) => selectedIds.has(taskId));
}

export type LabTaskDisplayUser = {
  email: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
} | null;

export function getLabTaskDisplayName(user: LabTaskDisplayUser) {
  if (!user) return "Former user";
  return (
    user.displayName?.trim() ||
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.email
  );
}
