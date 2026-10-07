import type { ComponentProps } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireLabTaskAccess: vi.fn(),
  getLabTasks: vi.fn(),
  getLabTaskAssignees: vi.fn(),
  navigate: vi.fn(),
  useLoaderData: vi.fn(),
  useActionData: vi.fn(),
}));

// why: a minimal router context makes the route's visible no-task state
// testable without submitting forms or navigating away from the page.
vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...props
    }: ComponentProps<"a"> & { to: string }) => (
      <a href={to} {...props}>
        {children}
      </a>
    ),
    Form: ({ children, ...props }: ComponentProps<"form">) => (
      <form {...props}>{children}</form>
    ),
    useLoaderData: mocks.useLoaderData,
    useActionData: mocks.useActionData,
    useFetcher: () => ({ state: "idle", data: null, Form: "form" }),
    useNavigate: () => mocks.navigate,
  };
});
vi.mock("~/modules/ioio-staff/lab-tasks.server", () => ({
  requireLabTaskAccess: mocks.requireLabTaskAccess,
  getLabTasks: mocks.getLabTasks,
  getLabTaskAssignees: mocks.getLabTaskAssignees,
  getLabTaskDateKey: () => "2026-10-07",
}));

import LabTasksPage, { loader } from "~/routes/_layout+/operations_.tasks";

describe("Lab Tasks route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireLabTaskAccess.mockResolvedValue({ organizationId: "org-1" });
    mocks.getLabTasks.mockResolvedValue([]);
    mocks.getLabTaskAssignees.mockResolvedValue([]);
    mocks.useLoaderData.mockReturnValue({
      filter: "open",
      sort: "newest",
      mineOnly: false,
      tasks: [],
      assignees: [],
      notice: null,
      startWithCreateOpen: false,
    });
    mocks.useActionData.mockReturnValue(null);
  });

  afterEach(() => cleanup());

  it("loads an empty task list safely", async () => {
    const result = (await loader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "user-1" }) } as never,
        request: new Request("http://localhost/operations/tasks"),
      })
    )) as unknown as { data: { tasks: unknown[]; assignees: unknown[] } };

    expect(result.data.tasks).toEqual([]);
    expect(result.data.assignees).toEqual([]);
  });

  it("renders the no-open-tasks empty state", () => {
    render(<LabTasksPage />);
    expect(screen.getByText("No open tasks.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add the first task" })
    ).toBeTruthy();
  });
});
