import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { REPORTS } from "~/modules/reports/registry";
import {
  IoioAnalyticsLanding,
  getIoioAnalyticsReports,
} from "./ioio-analytics-landing";

describe("IOIO Analytics landing", () => {
  it("renders only the four IOIO analytics reports with their detail links", () => {
    const reports = getIoioAnalyticsReports(REPORTS);

    expect(reports.map(({ id }) => id)).toEqual([
      "booking-compliance",
      "top-booked-assets",
      "top-booked-kits",
      "asset-usage-distribution",
    ]);

    render(
      <MemoryRouter>
        <IoioAnalyticsLanding reports={reports} />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "Analytics" })).toBeTruthy();
    for (const [label, href] of [
      ["Booking Compliance", "/reports/booking-compliance"],
      ["Top Booked Assets", "/reports/top-booked-assets"],
      ["Top Booked Kits", "/reports/top-booked-kits"],
      ["Asset Usage & Distribution", "/reports/asset-usage-distribution"],
    ]) {
      expect(
        screen
          .getByRole("link", { name: new RegExp(label) })
          .getAttribute("href")
      ).toBe(href);
    }
    for (const shelfReport of [
      "Monthly Booking Trends",
      "Overdue Items",
      "Asset Inventory",
      "Asset Activity Summary",
      "Asset Utilization",
      "Idle Assets",
      "Custody Snapshot",
    ]) {
      expect(screen.queryByText(shelfReport)).toBeNull();
    }
  });
});
