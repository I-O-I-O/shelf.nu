import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";
import { RecoverableInventoryList } from "~/components/ioio-staff/recoverable-inventory-list";
import type { RecoverableInventoryItem } from "~/components/ioio-staff/recoverable-inventory-list";

// why: locale/date formatting is unrelated to these row-layout assertions.
vi.mock("~/components/shared/date", () => ({
  DateS: () => <time>Oct 14, 2026</time>,
}));

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  getRecoverableCategories: vi.fn(),
  getRecoverableItems: vi.fn(),
}));

// why: archive services query the database; returning empty collections keeps
// these route tests focused on the fresh-organization behavior.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/modules/ioio-staff/recoverable-categories.server", () => ({
  getIoioRecoverableCategories: mocks.getRecoverableCategories,
}));
vi.mock("~/modules/ioio-staff/recoverable-items.server", () => ({
  getIoioRecoverableInventoryItems: mocks.getRecoverableItems,
}));

import ArchivedPage from "~/routes/_layout+/staff.archived";
import { loader as archivedLoader } from "~/routes/_layout+/staff.archived";
import TrashPage from "~/routes/_layout+/staff.trash";
import { loader as trashLoader } from "~/routes/_layout+/staff.trash";

function makeItem(
  index: number,
  overrides: Partial<RecoverableInventoryItem> = {}
): RecoverableInventoryItem {
  const itemId = `asset-${index}`;
  return {
    id: `recoverable-${index}`,
    itemId,
    itemType: "ASSET",
    name: `Makey Kit #${String(index).padStart(3, "0")}`,
    category: "Inventory",
    location: "Container A1-13",
    archivedAt: new Date("2026-10-14T12:00:00.000Z"),
    archivedBy: "Andrzej Radziejowski",
    quantity: null,
    duplicateRecordCount: 1,
    lifecycleItems: [{ itemId, itemType: "ASSET" }],
    needsReview: false,
    assetImage: null,
    kitImage: null,
    ...overrides,
  };
}

describe("archive and trash empty states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    mocks.getRecoverableCategories.mockResolvedValue([]);
    mocks.getRecoverableItems.mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it("loads an empty archive", async () => {
    const result = (await archivedLoader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    )) as unknown as { items: unknown[]; categories: unknown[] };

    expect(result.items).toEqual([]);
    expect(result.categories).toEqual([]);
  });

  it("starts Archive and Trash with their section heading instead of a back link", async () => {
    const archiveRouter = createMemoryRouter(
      [
        {
          path: "/staff/archived",
          loader: () => ({ items: [], categories: [] }),
          element: <ArchivedPage />,
        },
      ],
      { initialEntries: ["/staff/archived"] }
    );
    const trashRouter = createMemoryRouter(
      [
        {
          path: "/staff/trash",
          loader: () => ({ items: [], categories: [] }),
          element: <TrashPage />,
        },
      ],
      { initialEntries: ["/staff/trash"] }
    );

    const archiveView = render(<RouterProvider router={archiveRouter} />);
    expect(
      await screen.findByRole("heading", { name: "Archived inventory" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: /back to inventory/i })
    ).toBeNull();
    archiveView.unmount();

    render(<RouterProvider router={trashRouter} />);
    expect(await screen.findByRole("heading", { name: "Trash" })).toBeTruthy();
    expect(
      screen.queryByRole("link", { name: /back to inventory/i })
    ).toBeNull();
  });

  it("shows the archive empty state", () => {
    render(<RecoverableInventoryList items={[]} mode="archive" />);
    expect(screen.getByText("No archived items.")).toBeTruthy();
  });

  it("keeps bulk actions hidden with no selection and matches row action styling after selecting five", () => {
    const items = Array.from({ length: 5 }, (_, index) => makeItem(index + 1));
    const router = createMemoryRouter(
      [
        {
          path: "/staff/trash",
          element: <RecoverableInventoryList items={items} mode="trash" />,
        },
      ],
      { initialEntries: ["/staff/trash"] }
    );
    render(<RouterProvider router={router} />);

    expect(
      screen.queryByRole("button", { name: "Restore selected" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Delete permanently selected" })
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Makey Kit #001" })
    );
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(screen.queryByText("Select all (1 selected)")).toBeNull();
    const bulkRestore = screen.getByRole("button", {
      name: "Restore selected",
    });
    const rowRestore = screen.getAllByRole("button", { name: "Restore" })[0];
    expect(bulkRestore.className).toBe(rowRestore.className);

    const permanentDeleteButtons = screen.getAllByRole("button", {
      name: "Delete permanently",
    });
    expect(permanentDeleteButtons[0].className).toBe(
      permanentDeleteButtons[1].className
    );
    expect(permanentDeleteButtons[0].className).toContain("bg-red-600");
    expect(permanentDeleteButtons[0].className).toContain("text-white");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all items" }));
    expect(screen.getByText("5 selected")).toBeTruthy();
  });

  it("uses aligned columns, compact contained thumbnails, and a responsive row", () => {
    const longName =
      "A very long test equipment name that should wrap without shifting the aligned columns";
    const router = createMemoryRouter(
      [
        {
          path: "/staff/trash",
          element: (
            <RecoverableInventoryList
              items={[makeItem(1, { name: longName })]}
              mode="trash"
            />
          ),
        },
      ],
      { initialEntries: ["/staff/trash"] }
    );
    render(<RouterProvider router={router} />);

    const row = screen.getByRole("article");
    expect(row.className).toContain("xl:grid-cols-");
    expect(row.className).toContain("grid-cols-[20px_56px_minmax(0,1fr)]");
    expect(row.className).toContain("p-3");
    expect(screen.getByRole("link", { name: longName }).className).toContain(
      "break-words"
    );
    expect(document.querySelector("img")?.className).toContain(
      "object-contain"
    );
    expect(
      document.querySelector('img[src="/static/images/asset-placeholder.jpg"]')
    ).toBeTruthy();
    expect(screen.getByText("Previous location")).toBeTruthy();
    expect(screen.getByText("Deleted by")).toBeTruthy();
    expect(screen.getByText("Oct 14, 2026")).toBeTruthy();
  });

  it("uses the same compact action sizing for Archive row and bulk actions", () => {
    const items = [makeItem(1), makeItem(2)];
    const router = createMemoryRouter(
      [
        {
          path: "/staff/archived",
          element: <RecoverableInventoryList items={items} mode="archive" />,
        },
      ],
      { initialEntries: ["/staff/archived"] }
    );
    render(<RouterProvider router={router} />);

    const rowRestore = screen.getAllByRole("button", { name: "Restore" })[0];
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Makey Kit #001" })
    );
    expect(screen.getByText("1 selected")).toBeTruthy();

    const bulkRestore = screen.getByRole("button", {
      name: "Restore selected",
    });
    const bulkTrash = screen.getByRole("button", {
      name: "Move selected to Trash",
    });
    const rowTrash = screen.getAllByRole("button", { name: "Trash" })[0];

    expect(bulkRestore.className).toBe(rowRestore.className);
    expect(bulkTrash.className).toBe(rowTrash.className);
    expect(bulkRestore.className).toContain("border-red-200");
    expect(bulkRestore.className).not.toContain("bg-red-600");
    expect(bulkTrash.className).toContain("bg-red-600");
    expect(bulkTrash.className).toContain("text-white");
    expect(bulkTrash.className).toContain("hover:bg-red-800");
    expect(bulkTrash.className).toContain("focus:ring-red-700");
  });

  it("loads an empty trash and shows its empty state", async () => {
    const result = (await trashLoader(
      createLoaderArgs({
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    )) as unknown as { items: unknown[]; categories: unknown[] };

    expect(result.items).toEqual([]);
    expect(result.categories).toEqual([]);
    render(<RecoverableInventoryList items={[]} mode="trash" />);
    expect(screen.getByText("Trash is empty.")).toBeTruthy();
  });
});
