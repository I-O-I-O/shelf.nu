import { describe, expect, it, vi } from "vitest";

vi.mock("~/database/db.server", () => ({
  db: { ioioLabTA: { findUnique: vi.fn() } },
}));
vi.mock("~/modules/ioio-lab-information/service.server", () => ({
  getAcademicYear: () => "2026-2027",
}));
vi.mock("~/modules/organization/context.server", () => ({
  getSelectedOrganization: vi.fn(),
}));
vi.mock("~/modules/working-hours/service.server", () => ({
  getWorkingHoursForOrganization: vi.fn(),
}));

import { db } from "~/database/db.server";
import { getSelectedOrganization } from "~/modules/organization/context.server";
import {
  calculateTAHoursBudgetValues,
  requireTAHoursAccess,
} from "./ta-hours.server";

describe("TA Hours budget conversion", () => {
  it("converts SEK to hours with two-decimal Decimal rounding", () => {
    const values = calculateTAHoursBudgetValues({
      mode: "budget",
      budgetAmountSek: "50000",
      hourlyRateSekPerHour: "145",
      totalHoursBudget: "",
    });

    expect(values.totalHoursBudget.toFixed(2)).toBe("344.83");
    expect(values.budgetAmountSek.toFixed(2)).toBe("50000.00");
    expect(values.hourlyRateSekPerHour.toFixed(2)).toBe("145.00");
  });

  it("converts hours to SEK without floating-point persistence", () => {
    const values = calculateTAHoursBudgetValues({
      mode: "hours",
      totalHoursBudget: "160",
      budgetAmountSek: "",
      hourlyRateSekPerHour: "145",
    });

    expect(values.totalHoursBudget.toFixed(2)).toBe("160.00");
    expect(values.budgetAmountSek.toFixed(2)).toBe("23200.00");
  });

  it("rejects a zero hourly rate", () => {
    expect(() =>
      calculateTAHoursBudgetValues({
        mode: "hours",
        totalHoursBudget: "160",
        budgetAmountSek: "",
        hourlyRateSekPerHour: "0",
      })
    ).toThrow("Hourly rate must be greater than 0 SEK.");
  });

  it("rejects a calculated SEK amount outside Decimal(14,2) range", () => {
    expect(() =>
      calculateTAHoursBudgetValues({
        mode: "hours",
        totalHoursBudget: "100000",
        budgetAmountSek: "",
        hourlyRateSekPerHour: "999999999999.99",
      })
    ).toThrow(
      "Calculated budget must be a valid SEK amount with up to two decimals."
    );
  });
});

describe("TA Hours access", () => {
  it("does not let a SELF_SERVICE TA read or change staff TA Hours", async () => {
    vi.mocked(getSelectedOrganization).mockResolvedValue({
      organizationId: "ioio-team-1",
      userOrganizations: [
        {
          organization: { id: "ioio-team-1" },
          roles: ["SELF_SERVICE"],
        },
      ],
    } as never);

    await expect(
      requireTAHoursAccess({
        userId: "student-1",
        request: new Request("http://localhost/ta-hours"),
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(db.ioioLabTA.findUnique).not.toHaveBeenCalled();
  });

  it("rejects TA Hours writes when a PERSONAL workspace is selected", async () => {
    vi.mocked(getSelectedOrganization).mockResolvedValue({
      organizationId: "personal-1",
      currentOrganization: { id: "personal-1", type: "PERSONAL" },
      userOrganizations: [
        {
          organizationId: "personal-1",
          organization: { id: "personal-1", type: "PERSONAL" },
          roles: ["OWNER"],
        },
      ],
    } as never);

    await expect(
      requireTAHoursAccess({
        userId: "staff-1",
        request: new Request("http://localhost/ta-hours", { method: "POST" }),
      })
    ).rejects.toMatchObject({ status: 403 });
  });

  it("allows TA Hours writes in the selected TEAM workspace", async () => {
    vi.mocked(getSelectedOrganization).mockResolvedValue({
      organizationId: "ioio-team-1",
      currentOrganization: { id: "ioio-team-1", type: "TEAM" },
      userOrganizations: [
        {
          organizationId: "ioio-team-1",
          organization: { id: "ioio-team-1", type: "TEAM" },
          roles: ["ADMIN"],
        },
      ],
    } as never);

    await expect(
      requireTAHoursAccess({
        userId: "staff-1",
        request: new Request("http://localhost/ta-hours", { method: "POST" }),
      })
    ).resolves.toMatchObject({ organizationId: "ioio-team-1", isStaff: true });
  });
});
