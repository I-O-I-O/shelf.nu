import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  LabIssue,
  LabStatus,
} from "~/modules/ioio-staff/lab-status.server";
import { StaffLabStatusBell } from "./lab-status";

function createStatus(count: number): LabStatus {
  const issues: LabIssue[] = Array.from({ length: count }, (_, index) => ({
    id: `issue-${index + 1}`,
    kind: "general-report",
    severity: "attention",
    title: `Wrong location ${index + 1}`,
    detail: "Shelf B",
    href: "/operations?view=general",
  }));

  return {
    totalIssues: issues.length,
    severity: issues.length ? "attention" : "healthy",
    overdueLoans: 0,
    lowStock: 0,
    outOfStock: 0,
    unresolvedReports: 0,
    generalReports: issues.length,
    incompleteKits: 0,
    importWarnings: 0,
    pendingReservationRequests: 0,
    returnChecks: 0,
    returnedWithIssues: 0,
    preparationTasks: 0,
    cancelledPickups: 0,
    readyForPickup: 0,
    annualAccessApprovals: 0,
    issues,
  };
}

const readStateKey = "test:lab-status-seen";

function renderBell(status: LabStatus | null) {
  return render(
    <MemoryRouter>
      <StaffLabStatusBell status={status} readStateKey={readStateKey} />
    </MemoryRouter>
  );
}

describe("StaffLabStatusBell", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => cleanup());

  it("shows the current Lab status total and updates when loader data changes", () => {
    const { rerender } = renderBell(createStatus(3));
    const bell = screen.getByRole("button", {
      name: "Open lab status notifications",
    });

    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(bell);
    expect(
      screen.getByText("3 current actionable items; all have been seen.")
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);

    rerender(
      <MemoryRouter>
        <StaffLabStatusBell
          status={createStatus(2)}
          readStateKey={readStateKey}
        />
      </MemoryRouter>
    );
    expect(screen.queryByText("2")).not.toBeInTheDocument();
    expect(screen.queryByText("3")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    rerender(
      <MemoryRouter>
        <StaffLabStatusBell
          status={createStatus(0)}
          readStateKey={readStateKey}
        />
      </MemoryRouter>
    );
    expect(
      screen.getByRole("button", {
        name: "Open lab status notifications",
      })
    ).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("uses the same total as Lab status when the preview is capped", () => {
    renderBell(createStatus(12));
    const bell = screen.getByRole("button", {
      name: "Open lab status notifications",
    });
    expect(screen.getByText("12")).toBeInTheDocument();
    fireEvent.click(bell);

    expect(bell.querySelector("span")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(
      screen.getByText("Showing 5 of 12 current actionable items.")
    ).toBeInTheDocument();
  });

  it("clears the badge when opened and counts only issues that arrive afterward", () => {
    const { unmount } = renderBell(createStatus(3));
    const bell = screen.getByRole("button", {
      name: "Open lab status notifications",
    });

    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(bell);

    expect(screen.queryByText("3")).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(
      screen.getByText("3 current actionable items; all have been seen.")
    ).toBeInTheDocument();

    unmount();
    const restoredBell = renderBell(createStatus(3));
    expect(screen.queryByText("3")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Open lab status notifications",
      })
    );

    restoredBell.rerender(
      <MemoryRouter>
        <StaffLabStatusBell
          status={createStatus(4)}
          readStateKey={readStateKey}
        />
      </MemoryRouter>
    );

    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(
      screen.getByText("4 current actionable items; 1 new.")
    ).toBeInTheDocument();
  });

  it("keeps seen issue IDs separate for each user and organization scope", () => {
    const { rerender } = render(
      <MemoryRouter>
        <StaffLabStatusBell
          status={createStatus(2)}
          readStateKey="team-a:user-a"
        />
      </MemoryRouter>
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open lab status notifications" })
    );

    rerender(
      <MemoryRouter>
        <StaffLabStatusBell
          status={createStatus(2)}
          readStateKey="team-b:user-a"
        />
      </MemoryRouter>
    );

    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
