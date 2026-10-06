import { db } from "~/database/db.server";
import {
  compareLabTaskSortOrder,
  compareOpenLabTaskOrder,
  getLabTaskDisplayName,
  type LabTaskSort,
} from "~/modules/ioio-staff/lab-tasks";
import { getSelectedOrganization } from "~/modules/organization/context.server";
import { ShelfError } from "~/utils/error";

const taskUserSelect = {
  id: true,
  email: true,
  displayName: true,
  firstName: true,
  lastName: true,
} as const;

export type LabTaskFilter = "open" | "mine" | "completed";
type LabTaskPriorityValue = "NORMAL" | "IMPORTANT" | "URGENT";
type LabTaskStatusValue = "OPEN" | "COMPLETED";
const TASK_PRIORITIES: readonly LabTaskPriorityValue[] = [
  "NORMAL",
  "IMPORTANT",
  "URGENT",
];

export function parseLabTaskDate(value: string): Date | null {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ShelfError({
      cause: null,
      message: "Enter a valid due date.",
      label: "Request validation",
      status: 400,
      shouldBeCaptured: false,
    });
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ShelfError({
      cause: null,
      message: "Enter a valid due date.",
      label: "Request validation",
      status: 400,
      shouldBeCaptured: false,
    });
  }
  return date;
}

export function getLabTaskDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function taskError(message: string, status: 400 | 403 | 404 | 409 = 400) {
  return new ShelfError({
    cause: null,
    message,
    label: "Notification",
    status,
    shouldBeCaptured: false,
  });
}

export async function requireLabTaskAccess({
  userId,
  request,
}: {
  userId: string;
  request: Request;
}) {
  const selected = await getSelectedOrganization({ userId, request });
  const membership = selected.userOrganizations.find(
    (entry) => entry.organization.id === selected.organizationId
  );
  const isAdmin = Boolean(
    membership?.roles.some((role) => role === "ADMIN" || role === "OWNER")
  );
  const isIoioTA = Boolean(
    selected.organizationId &&
      (await db.ioioLabTA.findUnique({
        where: {
          organizationId_userId: {
            organizationId: selected.organizationId,
            userId,
          },
        },
        select: { id: true },
      }))
  );

  if (!selected.organizationId || (!isAdmin && !isIoioTA)) {
    throw taskError("You do not have permission to access Lab Tasks.", 403);
  }

  return {
    organizationId: selected.organizationId,
    isAdmin,
    isIoioTA,
  };
}

export async function getLabTaskAssignees(organizationId: string) {
  const [adminMembers, taMembers] = await Promise.all([
    db.userOrganization.findMany({
      where: {
        organizationId,
        roles: { hasSome: ["ADMIN", "OWNER"] },
        user: { deletedAt: null },
      },
      select: { user: { select: taskUserSelect } },
    }),
    db.ioioLabTA.findMany({
      where: {
        organizationId,
        user: {
          deletedAt: null,
          userOrganizations: { some: { organizationId } },
        },
      },
      select: { user: { select: taskUserSelect } },
    }),
  ]);
  const usersById = new Map<string, (typeof adminMembers)[number]["user"]>();
  for (const { user } of [...adminMembers, ...taMembers]) {
    usersById.set(user.id, user);
  }
  return [...usersById.values()].sort((left, right) =>
    getLabTaskDisplayName(left).localeCompare(getLabTaskDisplayName(right))
  );
}

export async function assertLabTaskAssignee({
  organizationId,
  assignedToUserId,
}: {
  organizationId: string;
  assignedToUserId: string | null;
}) {
  if (!assignedToUserId) return;
  const assignees = await getLabTaskAssignees(organizationId);
  if (!assignees.some(({ id }) => id === assignedToUserId)) {
    throw taskError("Choose a Staff member or IOIO TA in this organization.");
  }
}

export async function getLabTasks({
  organizationId,
  userId,
  filter = "open",
  sort,
  limit,
}: {
  organizationId: string;
  userId: string;
  filter?: LabTaskFilter;
  sort?: LabTaskSort;
  limit?: number;
}) {
  const status: LabTaskStatusValue =
    filter === "completed" ? "COMPLETED" : "OPEN";
  const tasks = await db.labTask.findMany({
    where: {
      organizationId,
      status,
      deletedAt: null,
      ...(filter === "mine" ? { assignedToUserId: userId } : {}),
    },
    include: {
      assignedTo: { select: taskUserSelect },
      createdBy: { select: taskUserSelect },
      completedBy: { select: taskUserSelect },
    },
    orderBy:
      filter === "completed"
        ? [{ completedAt: "desc" }, { updatedAt: "desc" }]
        : [{ dueDate: "asc" }, { createdAt: "desc" }],
    ...(limit ? { take: limit } : {}),
  });
  const today = getLabTaskDateKey(new Date());
  const normalizedTasks = tasks.map((task) => ({
    ...task,
    dueDateKey: task.dueDate ? getLabTaskDateKey(task.dueDate) : null,
    isOverdue:
      task.status === "OPEN" &&
      task.dueDate !== null &&
      getLabTaskDateKey(task.dueDate) < today,
  }));
  if (sort) {
    normalizedTasks.sort((left, right) =>
      compareLabTaskSortOrder(left, right, sort)
    );
  } else if (filter !== "completed") {
    normalizedTasks.sort(compareOpenLabTaskOrder);
  }
  return normalizedTasks;
}

export async function getDashboardLabTasks({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  const where = { organizationId, status: "OPEN" as const, deletedAt: null };
  const [openCount, tasks] = await Promise.all([
    db.labTask.count({ where }),
    getLabTasks({ organizationId, userId, filter: "open" }),
  ]);
  tasks.sort(compareOpenLabTaskOrder);
  return { openCount, tasks: tasks.slice(0, 5) };
}

export async function getAssignedOpenLabTaskCount({
  organizationId,
  userId,
}: {
  organizationId: string;
  userId: string;
}) {
  return db.labTask.count({
    where: {
      organizationId,
      assignedToUserId: userId,
      status: "OPEN",
      deletedAt: null,
    },
  });
}

export async function createLabTask({
  organizationId,
  userId,
  title,
  description,
  assignedToUserId,
  dueDate,
  priority,
}: {
  organizationId: string;
  userId: string;
  title: string;
  description: string;
  assignedToUserId: string | null;
  dueDate: string;
  priority: string;
}) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw taskError("Enter a task title.");
  if (normalizedTitle.length > 180) {
    throw taskError("Task titles must be 180 characters or fewer.");
  }
  if (description.length > 5000) {
    throw taskError("Descriptions must be 5,000 characters or fewer.");
  }
  await assertLabTaskAssignee({ organizationId, assignedToUserId });
  const normalizedPriority: LabTaskPriorityValue = TASK_PRIORITIES.includes(
    priority as LabTaskPriorityValue
  )
    ? (priority as LabTaskPriorityValue)
    : "NORMAL";

  return db.labTask.create({
    data: {
      organizationId,
      title: normalizedTitle,
      description: description.trim() || null,
      assignedToUserId,
      createdByUserId: userId,
      dueDate: parseLabTaskDate(dueDate),
      priority: normalizedPriority,
    },
  });
}

export async function updateLabTask({
  organizationId,
  taskId,
  title,
  description,
  assignedToUserId,
  dueDate,
  priority,
}: {
  organizationId: string;
  taskId: string;
  title: string;
  description: string;
  assignedToUserId: string | null;
  dueDate: string;
  priority: string;
}) {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) throw taskError("Enter a task title.");
  if (normalizedTitle.length > 180) {
    throw taskError("Task titles must be 180 characters or fewer.");
  }
  if (description.length > 5000) {
    throw taskError("Descriptions must be 5,000 characters or fewer.");
  }
  await assertLabTaskAssignee({ organizationId, assignedToUserId });
  const result = await db.labTask.updateMany({
    where: { id: taskId, organizationId, deletedAt: null },
    data: {
      title: normalizedTitle,
      description: description.trim() || null,
      assignedToUserId,
      dueDate: parseLabTaskDate(dueDate),
      priority: TASK_PRIORITIES.includes(priority as LabTaskPriorityValue)
        ? (priority as LabTaskPriorityValue)
        : "NORMAL",
    },
  });
  if (!result.count) throw taskError("That open task could not be found.", 404);
}

export async function setLabTaskCompleted({
  organizationId,
  taskId,
  userId,
  completed,
}: {
  organizationId: string;
  taskId: string;
  userId: string;
  completed: boolean;
}) {
  const result = await db.labTask.updateMany({
    where: {
      id: taskId,
      organizationId,
      deletedAt: null,
      status: completed ? "OPEN" : "COMPLETED",
    },
    data: completed
      ? {
          status: "COMPLETED",
          completedAt: new Date(),
          completedByUserId: userId,
        }
      : {
          status: "OPEN",
          completedAt: null,
          completedByUserId: null,
        },
  });
  if (!result.count) {
    throw taskError(
      "That task has already changed or is no longer available.",
      409
    );
  }
}

/** Complete or reopen a selection in one organization-scoped database write. */
export async function setLabTasksCompleted({
  organizationId,
  taskIds,
  userId,
  completed,
}: {
  organizationId: string;
  taskIds: string[];
  userId: string;
  completed: boolean;
}) {
  const uniqueTaskIds = [...new Set(taskIds)];
  if (uniqueTaskIds.length === 0 || uniqueTaskIds.length > 100) {
    throw taskError("Select between 1 and 100 tasks.");
  }

  const result = await db.labTask.updateMany({
    where: {
      id: { in: uniqueTaskIds },
      organizationId,
      deletedAt: null,
      status: completed ? "OPEN" : "COMPLETED",
    },
    data: completed
      ? {
          status: "COMPLETED",
          completedAt: new Date(),
          completedByUserId: userId,
        }
      : {
          status: "OPEN",
          completedAt: null,
          completedByUserId: null,
        },
  });
  if (!result.count) {
    throw taskError("The selected tasks have already changed.", 409);
  }
  return result.count;
}

export async function softDeleteLabTask({
  organizationId,
  taskId,
}: {
  organizationId: string;
  taskId: string;
}) {
  const result = await db.labTask.updateMany({
    where: { id: taskId, organizationId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (!result.count) throw taskError("That task could not be found.", 404);
}
