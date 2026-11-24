import type { LabStatus } from "~/modules/ioio-staff/lab-status.server";

/** Create a complete LabStatus payload with optional scenario-specific values. */
export function createLabStatus(overrides: Partial<LabStatus> = {}): LabStatus {
  const issues = overrides.issues ?? [];
  const totalIssues = overrides.totalIssues ?? issues.length;

  return {
    totalIssues,
    severity: totalIssues > 0 ? "attention" : "healthy",
    overdueLoans: 0,
    unresolvedReports: 0,
    generalReports: 0,
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
    ...overrides,
  };
}
