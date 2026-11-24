import { describe, expect, it } from "vitest";
import {
  DEFAULT_STAFF_DASHBOARD_PREFERENCES,
  normalizeStaffDashboardPreferences,
} from "./dashboard-preferences";

describe("staff dashboard preferences", () => {
  it("uses the existing dashboard order and shows all widgets by default", () => {
    expect(normalizeStaffDashboardPreferences(null)).toEqual(
      DEFAULT_STAFF_DASHBOARD_PREFERENCES
    );
  });

  it("keeps a saved order and appends widgets missing from older preferences", () => {
    expect(
      normalizeStaffDashboardPreferences({
        order: ["lab_tasks", "operations", "deleted_widget", "lab_tasks"],
        hidden: ["purchasing"],
      })
    ).toEqual({
      order: [
        "lab_tasks",
        "operations",
        "purchasing",
        "ta_hours",
        "inventory_import",
      ],
      hidden: ["purchasing"],
    });
  });

  it("ignores removed widget IDs in both order and visibility", () => {
    const normalized = normalizeStaffDashboardPreferences({
      order: ["calendar", "ta_hours"],
      hidden: ["calendar", "inventory_import"],
    });

    expect(normalized.order).not.toContain("calendar");
    expect(normalized.hidden).not.toContain("calendar");
    expect(normalized.order.at(-1)).toBe("inventory_import");
  });
});
