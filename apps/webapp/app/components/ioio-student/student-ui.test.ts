import { createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryRouter,
  RouterProvider,
  useLoaderData,
} from "react-router";
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

async function renderFilterRoute(initialEntry: string) {
  const categories: StudentCategory[] = [
    { id: "electronics", name: "Electronics", color: "#123456" },
    { id: "sensors", name: "Sensors", color: "#654321" },
  ];
  const locations: StudentLocation[] = [
    {
      id: "lab",
      name: "IOIO Lab",
      parentId: null,
      children: [],
      assetCount: 1,
      imageUrl: null,
      thumbnailUrl: null,
    },
    {
      id: "storage",
      name: "Storage Room",
      parentId: null,
      children: [],
      assetCount: 1,
      imageUrl: null,
      thumbnailUrl: null,
    },
    {
      id: "soldering",
      name: "Soldering Room",
      parentId: null,
      children: [],
      assetCount: 1,
      imageUrl: null,
      thumbnailUrl: null,
    },
  ];

  function FilterRoute() {
    const applied = useLoaderData() as {
      categoryId: string | null;
      itemType: string | null;
      locationId: string | null;
    };
    return createElement(
      "div",
      null,
      createElement(
        "p",
        { "data-testid": "applied-filter-state" },
        `${applied.categoryId ?? ""}|${applied.itemType ?? ""}|${
          applied.locationId ?? ""
        }`
      ),
      createElement(InventoryFilterControls, {
        basePath: "/ioio/browse",
        categories,
        locations,
        query: "",
        ...applied,
      })
    );
  }

  const router = createMemoryRouter(
    [
      {
        path: "/ioio/browse",
        loader: ({ request }) => {
          const params = new URL(request.url).searchParams;
          return {
            categoryId: params.get("category"),
            itemType: params.get("itemType"),
            locationId: params.get("location"),
          };
        },
        element: createElement(FilterRoute),
      },
    ],
    { initialEntries: [initialEntry] }
  );

  render(createElement(RouterProvider, { router }));
  await screen.findByRole("button", { name: /Filters/ });
  return router;
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
  it("keeps category, item type, and room filters removable without availability state", () => {
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
            id: "section-a",
            name: "Section A",
            parentId: "lab",
            imageUrl: null,
            thumbnailUrl: null,
            children: [
              {
                id: "shelf-a1",
                name: "Shelf A1",
                parentId: "section-a",
                imageUrl: null,
                thumbnailUrl: null,
                children: [],
                assetCount: 2,
              },
            ],
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
            locationId: "lab",
          }),
        },
      ],
      {
        initialEntries: [
          "/ioio/browse?q=Arduino&category=tools&itemType=individual&location=lab&availability=available",
        ],
      }
    );

    render(createElement(RouterProvider, { router }));

    const removeCategory = screen.getByRole("link", {
      name: "Remove Category: Tools filter",
    });
    expect(removeCategory.getAttribute("href")).toBe(
      "/ioio/browse?q=Arduino&itemType=individual&location=lab"
    );
    expect(
      screen
        .getByRole("link", { name: "Remove Search: Arduino filter" })
        .getAttribute("href")
    ).toBe("/ioio/browse?category=tools&itemType=individual&location=lab");
    expect(screen.queryByText("Availability")).toBeNull();
    expect(screen.queryByText("Any availability")).toBeNull();
    expect(screen.queryByText("Ready to borrow")).toBeNull();
    expect(screen.queryByText("Not ready to borrow")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Clear all" }).getAttribute("href")
    ).toBe("/ioio/browse");
  });

  it("shows only room-level choices while preserving category and item-type controls", async () => {
    const user = userEvent.setup();
    const categories: StudentCategory[] = [
      { id: "tools", name: "Tools", color: "#123456" },
    ];
    const locations: StudentLocation[] = [
      ...[
        ["lab", "IOIO Lab"],
        ["storage", "Storage Room"],
        ["soldering", "Soldering Room"],
      ].map(([id, name]) => ({
        id: id!,
        name: name!,
        parentId: null,
        imageUrl: null,
        thumbnailUrl: null,
        children: [
          {
            id: `${id}-section`,
            name: "Section A",
            parentId: id!,
            imageUrl: null,
            thumbnailUrl: null,
            children: [],
            assetCount: 1,
          },
        ],
        assetCount: 1,
      })),
    ];
    const router = createMemoryRouter(
      [
        {
          path: "/ioio/browse",
          element: createElement(InventoryFilterControls, {
            basePath: "/ioio/browse",
            categories,
            locations,
            query: "",
            categoryId: null,
            itemType: null,
            locationId: null,
          }),
        },
      ],
      { initialEntries: ["/ioio/browse"] }
    );

    render(createElement(RouterProvider, { router }));
    await user.click(screen.getByRole("button", { name: "Filters" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Category")).toBeTruthy();
    expect(screen.getByRole("option", { name: "All categories" })).toBeTruthy();
    expect(screen.getByText("Item type")).toBeTruthy();
    expect(screen.getByText("All items")).toBeTruthy();
    expect(screen.getByText("Normal items")).toBeTruthy();
    expect(screen.getByText("Kits")).toBeTruthy();
    expect(screen.getByText("Lab area")).toBeTruthy();
    expect(screen.getByText("All areas")).toBeTruthy();
    expect(screen.getByText("IOIO Lab")).toBeTruthy();
    expect(screen.getByText("Storage Room")).toBeTruthy();
    expect(screen.getByText("Soldering Room")).toBeTruthy();
    expect(screen.queryByText("Section A")).toBeNull();
    expect(screen.queryByText("Shelf A1")).toBeNull();
    expect(screen.queryByText("Any availability")).toBeNull();
    expect(screen.queryByText("Ready to borrow")).toBeNull();
    expect(screen.queryByText("Not ready to borrow")).toBeNull();
  });

  it("keeps filter edits as drafts until Apply and discards them on backdrop close", async () => {
    const user = userEvent.setup();
    const router = await renderFilterRoute(
      "/ioio/browse?category=electronics&itemType=quantity&location=lab"
    );

    await user.click(
      screen.getByRole("button", { name: "Filters, 3 applied" })
    );
    await user.selectOptions(screen.getByLabelText("Category"), "sensors");
    await user.click(screen.getByRole("radio", { name: "Kits" }));
    await user.click(screen.getByRole("radio", { name: "Storage Room" }));

    expect(router.state.location.search).toBe(
      "?category=electronics&itemType=quantity&location=lab"
    );
    expect(screen.getByTestId("applied-filter-state").textContent).toBe(
      "electronics|quantity|lab"
    );
    expect(screen.getByRole("dialog")).toBeTruthy();

    const backdrop = document.querySelector<HTMLElement>(
      '[data-state="open"].inset-0'
    );
    if (!backdrop) throw new Error("Expected the sheet backdrop to be open");
    await user.click(backdrop);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toBe(
      "?category=electronics&itemType=quantity&location=lab"
    );

    await user.click(
      screen.getByRole("button", { name: "Filters, 3 applied" })
    );
    expect(screen.getByLabelText("Category")).toHaveValue("electronics");
    expect(screen.getByRole("radio", { name: "Normal items" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "IOIO Lab" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Kits" })).not.toBeChecked();
  });

  it("applies all draft filters together and reopens with the applied values", async () => {
    const user = userEvent.setup();
    const router = await renderFilterRoute(
      "/ioio/browse?availability=available"
    );

    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.selectOptions(screen.getByLabelText("Category"), "sensors");
    await user.click(screen.getByRole("radio", { name: "Kits" }));
    await user.click(screen.getByRole("radio", { name: "Storage Room" }));
    expect(router.state.location.search).toBe("?availability=available");
    expect(screen.getByTestId("applied-filter-state").textContent).toBe("||");

    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() =>
      expect(router.state.location.search).toBe(
        "?category=sensors&itemType=individual&location=storage"
      )
    );
    expect(router.state.location.search).not.toContain("availability");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("applied-filter-state").textContent).toBe(
      "sensors|individual|storage"
    );

    await user.click(
      screen.getByRole("button", { name: "Filters, 3 applied" })
    );
    expect(screen.getByLabelText("Category")).toHaveValue("sensors");
    expect(screen.getByRole("radio", { name: "Kits" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Storage Room" })).toBeChecked();
  });

  it("discards a draft Clear when the backdrop is clicked", async () => {
    const user = userEvent.setup();
    const router = await renderFilterRoute(
      "/ioio/browse?category=electronics&itemType=individual&location=soldering"
    );

    await user.click(
      screen.getByRole("button", { name: "Filters, 3 applied" })
    );
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByLabelText("Category")).toHaveValue("");
    expect(screen.getByRole("radio", { name: "All items" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "All areas" })).toBeChecked();
    expect(router.state.location.search).toBe(
      "?category=electronics&itemType=individual&location=soldering"
    );
    expect(screen.getByTestId("applied-filter-state").textContent).toBe(
      "electronics|individual|soldering"
    );

    const backdrop = document.querySelector<HTMLElement>(
      '[data-state="open"].inset-0'
    );
    if (!backdrop) throw new Error("Expected the sheet backdrop to be open");
    await user.click(backdrop);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(router.state.location.search).toBe(
      "?category=electronics&itemType=individual&location=soldering"
    );
    await user.click(
      screen.getByRole("button", { name: "Filters, 3 applied" })
    );
    expect(screen.getByLabelText("Category")).toHaveValue("electronics");
    expect(screen.getByRole("radio", { name: "Kits" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Soldering Room" })).toBeChecked();

    await user.selectOptions(screen.getByLabelText("Category"), "sensors");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(
      screen.getByRole("button", { name: "Filters, 3 applied" })
    );
    expect(screen.getByLabelText("Category")).toHaveValue("electronics");
  });

  it("applies Clear only after the user explicitly applies it", async () => {
    const user = userEvent.setup();
    const router = await renderFilterRoute(
      "/ioio/browse?category=electronics&itemType=individual&location=lab"
    );

    await user.click(
      screen.getByRole("button", { name: "Filters, 3 applied" })
    );
    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    await waitFor(() => expect(router.state.location.search).toBe(""));
    expect(screen.getByTestId("applied-filter-state").textContent).toBe("||");
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
