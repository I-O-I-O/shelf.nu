import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BackupStatus } from "~/modules/backup/service.server";
import { BackupDetails } from "./backup-card";
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
    expect(screen.getByText(/Not confirmed/)).toBeTruthy();
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
