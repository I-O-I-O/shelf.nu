import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type {
  StudentAsset,
  StudentCategory,
  StudentLocation,
} from "~/modules/ioio-student/service.server";
import { StudentCheckoutProvider } from "./checkout-context";
import {
  AssetCard,
  formatStudentDateOnly,
  formatStudentLabel,
  InventoryFilterControls,
  StudentCheckoutButton,
} from "./student-ui";

vi.mock("react-router", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useRouteLoaderData: () => undefined };
});

function checkoutAsset(overrides: Partial<StudentAsset> = {}): StudentAsset {
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
    ...overrides,
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

describe("student inventory filters", () => {
  it("shows active filters that can be removed without losing the other search state", () => {
    const categories: StudentCategory[] = [
      { id: "tools", name: "Tools", color: "#123456" },
    ];
    const locations: StudentLocation[] = [
      {
        id: "lab",
        name: "IOIO Lab",
        parentId: null,
        imageUrl: null,
        thumbnailUrl: null,
        children: [
          {
            id: "bench-a",
            name: "Bench A",
            parentId: "lab",
            imageUrl: null,
            thumbnailUrl: null,
            children: [],
            assetCount: 2,
          },
        ],
        assetCount: 2,
      },
    ];
    const router = createMemoryRouter(
      [
        {
          path: "/ioio/browse",
          element: createElement(InventoryFilterControls, {
            basePath: "/ioio/browse",
            categories,
            locations,
            query: "Arduino",
            categoryId: "tools",
            itemType: "individual",
            locationId: "bench-a",
            availability: "available",
          }),
        },
      ],
      {
        initialEntries: [
          "/ioio/browse?q=Arduino&category=tools&itemType=individual&location=bench-a&availability=available",
        ],
      }
    );

    render(createElement(RouterProvider, { router }));

    const removeCategory = screen.getByRole("link", {
      name: "Remove Category: Tools filter",
    });
    expect(removeCategory.getAttribute("href")).toBe(
      "/ioio/browse?q=Arduino&itemType=individual&location=bench-a&availability=available"
    );
    expect(
      screen
        .getByRole("link", { name: "Remove Search: Arduino filter" })
        .getAttribute("href")
    ).toBe(
      "/ioio/browse?category=tools&itemType=individual&location=bench-a&availability=available"
    );
    expect(
      screen
        .getByRole("link", {
          name: "Remove Availability: Ready to borrow filter",
        })
        .getAttribute("href")
    ).toBe(
      "/ioio/browse?q=Arduino&category=tools&itemType=individual&location=bench-a"
    );
    expect(
      screen.getByRole("link", { name: "Clear all" }).getAttribute("href")
    ).toBe("/ioio/browse");
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
    await waitFor(() => {
      const saved = JSON.parse(
        window.sessionStorage.getItem("ioio-student-checkout") ?? "[]"
      ) as Array<{ preparationSubmissionToken: string }>;
      expect(saved[0]?.preparationSubmissionToken).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      );
    });
    const firstSubmissionToken = (
      JSON.parse(
        window.sessionStorage.getItem("ioio-student-checkout") ?? "[]"
      ) as Array<{ preparationSubmissionToken: string }>
    )[0]?.preparationSubmissionToken;

    await user.click(screen.getByRole("button", { name: "In borrow list" }));
    expect(
      screen.getByRole("button", { name: "Add to borrow list" })
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        JSON.parse(
          window.sessionStorage.getItem("ioio-student-checkout") ?? "[]"
        )
      ).toHaveLength(0);
    });
    await user.click(
      screen.getByRole("button", { name: "Add to borrow list" })
    );
    await waitFor(() => {
      const saved = JSON.parse(
        window.sessionStorage.getItem("ioio-student-checkout") ?? "[]"
      ) as Array<{ preparationSubmissionToken: string }>;
      expect(saved[0]?.preparationSubmissionToken).not.toBe(
        firstSubmissionToken
      );
    });
    window.sessionStorage.clear();
  });

  it("uses the requested Borrow label for an available Staff item", () => {
    render(
      createElement(
        StudentCheckoutProvider,
        null,
        createElement(StudentCheckoutButton, {
          asset: checkoutAsset(),
          primary: true,
          borrowLabel: "Borrow",
        })
      )
    );

    expect(screen.getByRole("button", { name: "Borrow" })).toBeTruthy();
  });

  it("does not offer Borrow when inventory is unavailable", () => {
    render(
      createElement(
        StudentCheckoutProvider,
        null,
        createElement(StudentCheckoutButton, {
          asset: checkoutAsset({
            status: "AVAILABLE",
            availableToBook: false,
          }),
          primary: true,
          borrowLabel: "Borrow",
        })
      )
    );

    expect(screen.queryByRole("button", { name: "Borrow" })).toBeNull();
    expect(screen.getByText("Unavailable")).toBeTruthy();
  });
});

describe("student inventory cards", () => {
  it("keeps availability beside a solid-red borrow action below the location", () => {
    const asset = checkoutAsset({
      title: "Makey Kit",
      availableQuantity: 5,
      locations: [
        {
          id: "container-a1-1",
          name: "Container A1-1",
          quantity: 5,
          displayPath: "Container A1-1",
        },
      ],
    });
    const router = createMemoryRouter(
      [
        {
          path: "/ioio",
          element: createElement(
            StudentCheckoutProvider,
            null,
            createElement(AssetCard, { asset })
          ),
        },
      ],
      { initialEntries: ["/ioio"] }
    );

    render(createElement(RouterProvider, { router }));

    expect(screen.getByRole("link", { name: "Makey Kit" })).toBeTruthy();
    expect(screen.getByText("Container A1-1")).toBeTruthy();
    const availability = screen.getByText("5 ready to borrow");
    const borrowAction = screen.getByRole("button", {
      name: "Add to borrow list",
    });
    expect(availability.parentElement).toBe(borrowAction.parentElement);
    expect(availability.parentElement?.className).not.toContain("mt-auto");
    expect(availability.parentElement?.className).toContain("w-full");
    expect(availability.parentElement?.className).toContain("justify-between");
    expect(borrowAction.className).toContain("bg-red-700");
    expect(borrowAction.className).not.toContain("bg-red-50");
  });
});
