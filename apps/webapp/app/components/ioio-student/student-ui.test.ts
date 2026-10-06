import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { StudentAsset } from "~/modules/ioio-student/service.server";
import { StudentCheckoutProvider } from "./checkout-context";
import { formatStudentDateOnly, formatStudentLabel } from "./student-ui";
import { StudentCheckoutButton } from "./student-ui";

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useRouteLoaderData: () => undefined };
});

function checkoutAsset(): StudentAsset {
  return {
    id: "arduino-nano",
    title: "Arduino Nano",
    description: null,
    mainImage: null,
    mainImageExpiration: null,
    thumbnailImage: null,
    assetModel: null,
    status: "AVAILABLE",
    type: "QUANTITY_TRACKED",
    quantity: 8,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    assetModelId: null,
    availableQuantity: 8,
    availableToBook: true,
    sequentialId: null,
    category: null,
    locations: [],
    kits: [],
    qrIds: [],
  };
}

describe("student date display", () => {
  it("keeps the calendar day for date-only borrow values", () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(new Date(2030, 0, 15));

    expect(formatStudentDateOnly("2030-01-15T23:59:59.000Z")).toBe(expected);
  });
});

describe("student label display", () => {
  it("replaces long dash punctuation with student-friendly separators", () => {
    const longDash = String.fromCharCode(0x2014);
    expect(formatStudentLabel(`Arduino Kit ${longDash} Test Board`)).toBe(
      "Arduino Kit / Test Board"
    );
  });
});

describe("student checkout action", () => {
  it("shares the selected state through the checkout provider", async () => {
    window.sessionStorage.clear();
    const user = userEvent.setup();

    render(
      createElement(
        StudentCheckoutProvider,
        null,
        createElement(StudentCheckoutButton, { asset: checkoutAsset() })
      )
    );

    expect(
      screen.getByRole("button", { name: "Add to borrow list" })
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Add to borrow list" })
    );
    expect(screen.getByRole("button", { name: "In borrow list" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "In borrow list" }));
    expect(
      screen.getByRole("button", { name: "Add to borrow list" })
    ).toBeTruthy();
  });
});
