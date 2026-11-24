import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BookingComplianceContent } from "./booking-compliance-content";

describe("BookingComplianceContent", () => {
  it("separates returned-late loans from currently overdue loans", () => {
    render(
      <BookingComplianceContent
        complianceData={{
          completed: 2,
          onTime: 1,
          late: 1,
          unavailable: 0,
          rate: 50,
        }}
        kpis={[
          {
            id: "currently_overdue",
            label: "Currently overdue",
            value: "3",
            rawValue: 3,
            format: "number",
            delta: null,
            deltaType: "negative",
          },
        ]}
        timeframeLabel="Last 30 days"
      />
    );

    expect(screen.getByText("Completed loans")).toBeTruthy();
    expect(screen.getByText("Returned late")).toBeTruthy();
    expect(screen.getByText("On-time return rate")).toBeTruthy();
    expect(screen.getByText("Currently overdue")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
  });

  it("does not show a rate when a returned loan has no reliable check-in time", () => {
    render(
      <BookingComplianceContent
        complianceData={{
          completed: 1,
          onTime: 0,
          late: 0,
          unavailable: 1,
          rate: null,
        }}
        kpis={[]}
        timeframeLabel="All time"
      />
    );

    expect(screen.getByText("—")).toBeTruthy();
    expect(
      screen.getByText("Return time unavailable for 1 completed loan.")
    ).toBeTruthy();
  });
});
