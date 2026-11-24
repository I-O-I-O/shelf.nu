import type { ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs, createLoaderArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireLabTaskAccess: vi.fn(),
  getLabTasks: vi.fn(),
  getLabTaskAssignees: vi.fn(),
  createLabTask: vi.fn(),
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
// why: capture the task creation request without writing to the database.
vi.mock("~/modules/ioio-staff/lab-tasks.server", () => ({
  requireLabTaskAccess: mocks.requireLabTaskAccess,
  getLabTasks: mocks.getLabTasks,
  getLabTaskAssignees: mocks.getLabTaskAssignees,
  getLabTaskDateKey: () => "2026-10-07",
  createLabTask: mocks.createLabTask,
}));

import LabTasksPage, {
  action,
  loader,
} from "~/routes/_layout+/operations_.tasks";

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

  it("submits the task fields and closes on the successful creation notice", async () => {
    const user = userEvent.setup();
    const page = mocks.useLoaderData();
    mocks.useLoaderData.mockReturnValue({
      ...page,
      assignees: [{ id: "ta-1", displayName: "Lab Assistant" }],
    });
    const { rerender } = render(<LabTasksPage />);

    await user.click(screen.getByRole("button", { name: "New task" }));
    const panel = screen.getByRole("dialog", { name: "Add task" });
    const fields = within(panel);
    await user.type(fields.getByLabelText("Title"), "Check returns");
    await user.type(fields.getByLabelText(/Description/), "Inspect kits");
    await user.selectOptions(fields.getByLabelText("Assigned to"), "ta-1");
    fireEvent.change(fields.getByLabelText(/Due date/), {
      target: { value: "2026-10-08" },
    });
    await user.selectOptions(fields.getByLabelText("Priority"), "URGENT");

    let submission: FormData | undefined;
    const form = panel.querySelector("form");
    form?.addEventListener("submit", (event) => {
      event.preventDefault();
      submission = new FormData(form);
    });
    await user.click(fields.getByRole("button", { name: "Add task" }));
    expect(submission).toBeDefined();

    const response = await action(
      createActionArgs({
        context: { getSession: () => ({ userId: "user-1" }) } as never,
        request: new Request("http://localhost/operations/tasks", {
          method: "POST",
          body: submission,
        }),
      })
    );
    expect(mocks.createLabTask).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      title: "Check returns",
      description: "Inspect kits",
      assignedToUserId: "ta-1",
      dueDate: "2026-10-08",
      priority: "URGENT",
    });
    expect(response).toBeInstanceOf(Response);
    if (response instanceof Response) {
      expect(response.headers.get("Location")).toContain("notice=created");
    }

    mocks.useLoaderData.mockReturnValue({ ...page, notice: "Task created" });
    rerender(<LabTasksPage />);
    expect(screen.queryByRole("dialog", { name: "Add task" })).toBeNull();
  });

  it("dismisses the Add task panel with Cancel or Escape and returns focus", async () => {
    const user = userEvent.setup();
    render(<LabTasksPage />);
    const trigger = screen.getByRole("button", { name: "New task" });

    await user.click(trigger);
    await user.click(
      within(screen.getByRole("dialog", { name: "Add task" })).getByRole(
        "button",
        { name: "Cancel" }
      )
    );
    expect(screen.queryByRole("dialog", { name: "Add task" })).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add task" })).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
