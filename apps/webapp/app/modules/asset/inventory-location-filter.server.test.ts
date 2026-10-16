import { beforeEach, describe, expect, it, vi } from "vitest";

const { getLocationDescendantIdsMock } = vi.hoisted(() => ({
  getLocationDescendantIdsMock: vi.fn(),
}));

// why: keep this adapter test database-free while verifying it delegates each
// selected node to Shelf's canonical recursive location-tree helper.
vi.mock("~/modules/location/descendants.server", () => ({
  getLocationDescendantIds: getLocationDescendantIdsMock,
}));

import { getInventoryLocationFilterIds } from "./inventory-location-filter.server";

describe("getInventoryLocationFilterIds", () => {
  beforeEach(() => {
    getLocationDescendantIdsMock.mockReset();
  });

  it.each([
    ["room", ["room", "section", "shelf", "container"]],
    ["section", ["section", "shelf", "container"]],
    ["shelf", ["shelf", "container"]],
    ["container", ["container"]],
  ])("expands a selected %s to its descendants", async (selected, expected) => {
    getLocationDescendantIdsMock.mockResolvedValue(expected);

    await expect(
      getInventoryLocationFilterIds({
        organizationId: "org-1",
        locationIds: [selected as string],
      })
    ).resolves.toEqual(expected);
    expect(getLocationDescendantIdsMock).toHaveBeenCalledWith({
      organizationId: "org-1",
      locationId: selected,
    });
  });

  it("passes the no-location sentinel through unchanged", async () => {
    await expect(
      getInventoryLocationFilterIds({
        organizationId: "org-1",
        locationIds: ["without-location"],
      })
    ).resolves.toEqual(["without-location"]);
    expect(getLocationDescendantIdsMock).not.toHaveBeenCalled();
  });

  it("expands selected locations while retaining the no-location option", async () => {
    getLocationDescendantIdsMock.mockResolvedValue(["room", "section"]);

    await expect(
      getInventoryLocationFilterIds({
        organizationId: "org-1",
        locationIds: ["room", "without-location"],
      })
    ).resolves.toEqual(["room", "section", "without-location"]);
  });
});
