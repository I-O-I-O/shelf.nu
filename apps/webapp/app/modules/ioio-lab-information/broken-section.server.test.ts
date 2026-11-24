import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  location: { findMany: vi.fn(), findFirst: vi.fn() },
  ioioLabInformationSection: { findUnique: vi.fn(), upsert: vi.fn() },
}));

// why: this verifies the existing Shelf Location and Lab Info setting boundary.
vi.mock("~/database/db.server", () => ({ db: mocks }));

import {
  getBrokenSectionSettings,
  saveBrokenSectionLocation,
} from "./broken-section.server";

describe("IOIO Broken section setting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ioioLabInformationSection.findUnique.mockResolvedValue({
      content: "shelf-b",
    });
    mocks.location.findMany.mockResolvedValue([
      {
        id: "room-5",
        name: "Room 5",
        parentId: null,
        imageUrl: null,
        thumbnailUrl: null,
      },
      {
        id: "equipment",
        name: "Equipment area",
        parentId: "room-5",
        imageUrl: null,
        thumbnailUrl: null,
      },
      {
        id: "shelf-b",
        name: "Shelf B",
        parentId: "equipment",
        imageUrl: "https://example.test/location.jpg",
        thumbnailUrl: "https://example.test/location-thumb.jpg",
      },
    ]);
    mocks.location.findFirst.mockResolvedValue({ id: "shelf-b" });
    mocks.ioioLabInformationSection.upsert.mockResolvedValue({
      content: "shelf-b",
    });
  });

  it("resolves the saved Shelf location with its hierarchy and image", async () => {
    await expect(getBrokenSectionSettings("team-1")).resolves.toMatchObject({
      brokenSectionLocationId: "shelf-b",
      brokenSection: {
        id: "shelf-b",
        name: "Shelf B",
        path: "Room 5 · Equipment area · Shelf B",
        imageUrl: "https://example.test/location.jpg",
        thumbnailUrl: "https://example.test/location-thumb.jpg",
      },
    });
    expect(mocks.ioioLabInformationSection.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_key: {
            organizationId: "team-1",
            key: "ioio_broken_section_location",
          },
        },
      })
    );
  });

  it("saves the Location ID into existing organization-scoped Lab Info metadata", async () => {
    await saveBrokenSectionLocation({
      organizationId: "team-1",
      locationId: "shelf-b",
    });

    expect(mocks.location.findFirst).toHaveBeenCalledWith({
      where: { id: "shelf-b", organizationId: "team-1" },
      select: { id: true },
    });
    expect(mocks.ioioLabInformationSection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_key: {
            organizationId: "team-1",
            key: "ioio_broken_section_location",
          },
        },
        update: { content: "shelf-b" },
      })
    );
  });

  it("refuses a location from another organization", async () => {
    mocks.location.findFirst.mockResolvedValue(null);

    await expect(
      saveBrokenSectionLocation({
        organizationId: "team-1",
        locationId: "outside-location",
      })
    ).rejects.toThrow("Choose a location in this workspace.");
    expect(mocks.ioioLabInformationSection.upsert).not.toHaveBeenCalled();
  });
});
