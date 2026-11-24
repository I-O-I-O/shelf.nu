import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { BackupStatus } from "~/modules/backup/service.server";
import {
  BackupDetails,
  BackupStatusItem,
  getBackupIndicator,
} from "./backup-status";
afterEach(cleanup);
const base: BackupStatus = {
  available: true,
  automatic: "unconfirmed",
  retention: 7,
  running: false,
  status: "never",
  last: null,
  recent: [],
  metadataWarning: false,
};
describe("staff backup display", () => {
  it("shows the normal running status", () => {
    render(<BackupDetails backup={{ ...base, running: true }} />);
    expect(screen.getByText("Backup in progress")).toBeTruthy();
  });
  it("shows a useful never-run state and does not claim scheduling is enabled", () => {
    render(<BackupDetails backup={base} />);
    expect(screen.getByText(/Never run/)).toBeTruthy();
    expect(screen.getByText(/No successful database backup yet/)).toBeTruthy();
    expect(screen.getByText(/Not configured/)).toBeTruthy();
  });
  it("shows failure", () => {
    render(<BackupDetails backup={{ ...base, status: "failed" }} />);
    expect(screen.getByText("Failed")).toBeTruthy();
  });
  it("shows successful backup date and configured retention", () => {
    const completedAt = "2026-01-01T03:01:00.000Z";
    render(
      <BackupDetails
        backup={{
          ...base,
          status: "successful",
          automatic: "configured",
          last: {
            filename: "safe.dump",
            createdAt: completedAt,
            completedAt,
            size: 100,
            status: "successful",
            verified: true,
          },
        }}
      />
    );
    expect(screen.getByText("Successful")).toBeTruthy();
    expect(screen.getByText(/Last successful backup/).textContent).toContain(
      new Date(completedAt).toLocaleString()
    );
    expect(screen.getByText(/Last 7 daily backups/)).toBeTruthy();
  });
});

const now = Date.parse("2026-11-16T12:00:00.000Z");
function healthyBackup(
  completedAt = new Date(now).toISOString()
): BackupStatus {
  return {
    ...base,
    automatic: "configured",
    status: "successful",
    last: {
      filename: "test.dump",
      createdAt: completedAt,
      completedAt,
      size: 1024,
      status: "successful",
      verified: true,
    },
  };
}
describe("backup status indicator", () => {
  it("is green for a recent verified backup with automatic setup confirmed", () => {
    expect(getBackupIndicator(healthyBackup(), now)).toEqual({
      label: "Up to date",
      color: "bg-green-600",
    });
  });
  it.each([
    { running: true },
    { retentionWarning: true },
    { metadataWarning: true },
  ])("is orange for an in-progress or warning state: %j", (overrides) => {
    expect(
      getBackupIndicator({ ...healthyBackup(), ...overrides }, now).color
    ).toBe("bg-orange-500");
  });
  it.each([
    { status: "failed" as const },
    { status: "never" as const },
    { status: "unavailable" as const },
    { last: null },
    { automatic: "unconfirmed" as const },
    { available: false },
  ])("is red when backup needs attention: %j", (overrides) => {
    expect(
      getBackupIndicator({ ...healthyBackup(), ...overrides }, now)
    ).toEqual({ label: "Needs attention", color: "bg-red-600" });
  });
  it("allows 36 hours for daily backups and flags older or invalid timestamps", () => {
    expect(
      getBackupIndicator(
        healthyBackup(new Date(now - 36 * 3600000).toISOString()),
        now
      ).color
    ).toBe("bg-green-600");
    for (const timestamp of [
      new Date(now - 36 * 3600000 - 1).toISOString(),
      "invalid",
      new Date(now + 1).toISOString(),
    ]) {
      expect(getBackupIndicator(healthyBackup(timestamp), now).color).toBe(
        "bg-red-600"
      );
    }
  });
  it("prioritizes running over previous failures", () => {
    expect(
      getBackupIndicator({ ...base, status: "failed", running: true }, now)
    ).toEqual({ label: "Running", color: "bg-orange-500" });
  });
  it("does not report an unloaded status as healthy", () => {
    expect(getBackupIndicator(undefined, now).color).toBe("bg-red-600");
  });
});

describe("backup status popover", () => {
  function renderStatus() {
    let submissions = 0;
    const completed = healthyBackup(new Date().toISOString());
    const Stub = createRoutesStub([
      { path: "/home", Component: BackupStatusItem },
      // Resource boundary only: exercise the real fetcher/form/polling UI without
      // invoking PostgreSQL. API authorization is tested in api+/backups.test.ts.
      {
        path: "/api/backups",
        loader: () => ({ backup: completed }),
        action: ({ request }) => {
          expect(request.method).toBe("POST");
          submissions++;
          return {
            backup: { ...completed, running: true },
            message: "Backup started.",
          };
        },
      },
    ]);
    render(<Stub initialEntries={["/home"]} />);
    return { submissions: () => submissions };
  }
  it("opens compact details from the status item and closes with Escape", async () => {
    renderStatus();
    const trigger = await screen.findByRole("button", {
      name: "Backup Up to date",
    });
    expect(trigger.querySelector(".bg-green-600")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("region", { name: "Backup" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back up now" })).toBeNull();
    fireEvent.click(trigger);
    const details = await screen.findByRole("dialog", {
      name: "Backup details",
    });
    expect(details).toHaveTextContent("Automatic backups: Enabled");
    expect(details).toHaveTextContent("Schedule: Daily at 03:00");
    expect(details).toHaveTextContent("Retention: Last 7 daily backups");
    expect(details).toHaveTextContent("Included: PostgreSQL database");
    expect(details).toHaveTextContent("Not included: Uploaded images/files");
    fireEvent.keyDown(details, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("submits Back up now through the existing API and refreshes the result", async () => {
    const resource = renderStatus();
    fireEvent.click(
      await screen.findByRole("button", { name: "Backup Up to date" })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(
      await screen.findByRole("button", { name: "Backup Running" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Backing up…" })).toBeDisabled();
    expect(screen.getByText("Backup started.")).toBeInTheDocument();
    expect(resource.submissions()).toBe(1);
    await waitFor(
      () =>
        expect(
          screen.getByRole("button", { name: "Backup Up to date" })
        ).toBeInTheDocument(),
      { timeout: 4500 }
    );
    expect(screen.getByRole("button", { name: "Back up now" })).toBeEnabled();
  }, 10000);
});
