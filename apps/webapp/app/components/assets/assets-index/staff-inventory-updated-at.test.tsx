import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ResolvedFormatPrefs } from "~/utils/date-format";
import {
  STAFF_INVENTORY_UPDATED_AT_HEADING,
  StaffInventoryUpdatedAt,
} from "./staff-inventory-updated-at";

const preferences: ResolvedFormatPrefs = {
  dateFormat: "MM_DD_YYYY",
  timeFormat: "H12",
  weekStartsOn: 1,
  timeZone: "Europe/Copenhagen",
};

describe("StaffInventoryUpdatedAt", () => {
  it("renders the canonical updatedAt date as DD.MM.YYYY without a time or label", () => {
    render(
      <table>
        <thead>
          <tr>
            <th>{STAFF_INVENTORY_UPDATED_AT_HEADING}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <StaffInventoryUpdatedAt
                value="2026-10-20T23:30:00.000Z"
                prefs={preferences}
              />
            </td>
          </tr>
        </tbody>
      </table>
    );

    expect(screen.getByRole("columnheader").textContent).toBe("Last updated");
    const date = screen.getByText("21.10.2026");
    expect(date.tagName).toBe("TIME");
    expect(date.getAttribute("dateTime")).toBe("2026-10-20T23:30:00.000Z");
    expect(date.textContent).not.toMatch(/last updated|\d{1,2}:\d{2}|AM|PM/iu);
  });
});
