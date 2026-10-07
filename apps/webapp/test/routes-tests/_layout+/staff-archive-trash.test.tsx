import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoaderArgs } from "@mocks/remix";
import { RecoverableInventoryList } from "~/components/ioio-staff/recoverable-inventory-list";

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

import { loader as archivedLoader } from "~/routes/_layout+/staff.archived";
import { loader as trashLoader } from "~/routes/_layout+/staff.trash";

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

  it("shows the archive empty state", () => {
    render(<RecoverableInventoryList items={[]} mode="archive" />);
    expect(screen.getByText("No archived items.")).toBeTruthy();
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
