import { describe, expect, it } from "vitest";
import {
  compareLabTaskSortOrder,
  compareOpenLabTaskOrder,
  formatLabTaskCreatedAt,
  getVisibleSelectedLabTaskIds,
  getLabTaskDisplayName,
  LAB_TASK_PRIORITY_LABELS,
  toggleAllVisibleLabTaskSelections,
  toggleLabTaskSelection,
} from "./lab-tasks";
import { getLabTaskDateKey, parseLabTaskDate } from "./lab-tasks.server";

describe("Lab Tasks helpers", () => {
  it("maps saved priority values to High, Medium, and Low in order", () => {
    expect(LAB_TASK_PRIORITY_LABELS).toEqual({
      URGENT: "High",
      IMPORTANT: "Medium",
      NORMAL: "Low",
    });
    const ordered = [
      {
        name: "low overdue",
        priority: "NORMAL" as const,
        isOverdue: true,
        dueDateKey: "2026-09-01",
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        name: "medium",
        priority: "IMPORTANT" as const,
        isOverdue: false,
        dueDateKey: "2026-09-03",
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        name: "high",
        priority: "URGENT" as const,
        isOverdue: false,
        dueDateKey: "2026-09-04",
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
      {
        name: "medium overdue",
        priority: "IMPORTANT" as const,
        isOverdue: true,
        dueDateKey: "2026-09-01",
        createdAt: new Date("2026-09-01T00:00:00Z"),
      },
    ].sort(compareOpenLabTaskOrder);

    expect(ordered.map(({ name }) => name)).toEqual([
      "high",
      "medium overdue",
      "medium",
      "low overdue",
    ]);
  });

  it("sorts by creation time or priority with a stable ID tie-breaker", () => {
    const tasks = [
      {
        id: "b",
        priority: "URGENT" as const,
        createdAt: new Date("2026-10-01T10:00:00Z"),
      },
      {
        id: "a",
        priority: "URGENT" as const,
        createdAt: new Date("2026-10-01T10:00:00Z"),
      },
      {
        id: "medium",
        priority: "IMPORTANT" as const,
        createdAt: new Date("2026-10-02T10:00:00Z"),
      },
      {
        id: "low",
        priority: "NORMAL" as const,
        createdAt: new Date("2026-10-03T10:00:00Z"),
      },
    ];

    expect(
      [...tasks]
        .sort((left, right) => compareLabTaskSortOrder(left, right, "newest"))
        .map(({ id }) => id)
    ).toEqual(["low", "medium", "a", "b"]);
    expect(
      [...tasks]
        .sort((left, right) => compareLabTaskSortOrder(left, right, "priority"))
        .map(({ id }) => id)
    ).toEqual(["a", "b", "medium", "low"]);
  });

  it("formats creation dates without redundant current-year text", () => {
    const now = new Date("2026-10-03T12:00:00");
    expect(formatLabTaskCreatedAt(new Date("2026-10-02T12:00:00"), now)).toBe(
      "2 Oct"
    );
    expect(formatLabTaskCreatedAt(new Date("2025-12-18T12:00:00"), now)).toBe(
      "18 Dec 2025"
    );
  });

  it("adds and removes task selections by stable ID and selects only visible tasks", () => {
    let selected = new Set<string>();
    selected = toggleLabTaskSelection(selected, "task-a");
    selected = toggleLabTaskSelection(selected, "task-b");
    expect([...selected]).toEqual(["task-a", "task-b"]);

    selected = toggleLabTaskSelection(selected, "task-a");
    expect([...selected]).toEqual(["task-b"]);

    selected = new Set();
    const visibleTaskIds = ["task-a", "task-b", "task-c"];
    selected = toggleAllVisibleLabTaskSelections(selected, visibleTaskIds);
    expect([...selected]).toEqual(visibleTaskIds);
    expect(getVisibleSelectedLabTaskIds(selected, visibleTaskIds)).toEqual(
      visibleTaskIds
    );

    selected = toggleAllVisibleLabTaskSelections(selected, visibleTaskIds);
    expect([...selected]).toEqual([]);
  });

  it("does not include selected tasks hidden by the current visible list", () => {
    const selected = new Set(["visible", "hidden"]);
    expect(getVisibleSelectedLabTaskIds(selected, ["visible"])).toEqual([
      "visible",
    ]);
  });

  it("keeps due dates on the selected calendar day", () => {
    const dueDate = parseLabTaskDate("2026-09-24");

    expect(dueDate?.toISOString()).toBe("2026-09-24T00:00:00.000Z");
    expect(dueDate && getLabTaskDateKey(dueDate)).toBe("2026-09-24");
  });

  it("rejects impossible due dates", () => {
    expect(() => parseLabTaskDate("2026-02-30")).toThrow(
      "Enter a valid due date."
    );
  });

  it("uses safe name fallbacks for legacy Staff and TA profiles", () => {
    expect(
      getLabTaskDisplayName({
        email: "alex@example.edu",
        displayName: null,
        firstName: "Alex",
        lastName: "Example",
      })
    ).toBe("Alex Example");
    expect(
      getLabTaskDisplayName({
        email: "alex@example.edu",
        displayName: null,
        firstName: null,
        lastName: null,
      })
    ).toBe("alex@example.edu");
  });
});
