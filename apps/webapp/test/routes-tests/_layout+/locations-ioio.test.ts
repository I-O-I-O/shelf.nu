import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/database/db.server";
import { getLocationsForCreateAndEdit } from "~/modules/asset/service.server";
import { getIoioArchivedItemIds } from "~/modules/ioio-staff/archive.server";
import {
  deleteLocation,
  createLocation,
  getLocationDescendantsTree,
  getLocationHierarchy,
  getLocation,
  getLocations,
  updateLocation,
  updateLocationImage,
} from "~/modules/location/service.server";
import {
  action as deleteLocationAction,
  loader as locationDetailLoader,
} from "~/routes/_layout+/locations.$locationId";
import {
  action as editLocationAction,
  loader as editLocationLoader,
} from "~/routes/_layout+/locations.$locationId_.edit";
import {
  action as locationsIndexAction,
  loader as locationsIndexLoader,
} from "~/routes/_layout+/locations._index";
import {
  action as newLocationAction,
  loader as newLocationLoader,
} from "~/routes/_layout+/locations.new";
import NewLocationPage from "~/routes/_layout+/locations.new";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

// why: route tests need deterministic organization-scoped permission results.
vi.mock("~/utils/roles.server", () => ({ requirePermission: vi.fn() }));
// why: these route tests verify route-to-service adaptation without database or storage I/O.
vi.mock("~/modules/location/service.server", () => ({
  deleteLocation: vi.fn(),
  createLocation: vi.fn(),
  getLocationDescendantsTree: vi.fn(),
  getLocation: vi.fn(),
  getLocationHierarchy: vi.fn(),
  getLocations: vi.fn(),
  removeLocationImage: vi.fn(),
  updateLocation: vi.fn(),
  updateLocationImage: vi.fn(),
}));
// why: the IOIO lifecycle service is an organization-scoped boundary; the route test supplies known archived IDs.
vi.mock("~/modules/ioio-staff/archive.server", () => ({
  getIoioArchivedItemIds: vi.fn(),
}));
// why: the location picker service is exercised at the route boundary while the database remains isolated.
vi.mock("~/modules/asset/service.server", () => ({
  getLocationsForCreateAndEdit: vi.fn(),
}));
// why: direct Prisma reads validate organization-scoped hierarchy input; mock only that database boundary.
vi.mock("~/database/db.server", () => ({
  db: {
    location: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    assetLocation: { findMany: vi.fn() },
    asset: { count: vi.fn() },
  },
}));
// why: route behavior is asserted without sending notifications to the app event bus.
vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: vi.fn(),
}));

const requirePermissionMock = vi.mocked(requirePermission);
const createLocationMock = vi.mocked(createLocation);
const deleteLocationMock = vi.mocked(deleteLocation);
const getLocationMock = vi.mocked(getLocation);
const getLocationHierarchyMock = vi.mocked(getLocationHierarchy);
const getLocationDescendantsTreeMock = vi.mocked(getLocationDescendantsTree);
const getLocationsMock = vi.mocked(getLocations);
const updateLocationMock = vi.mocked(updateLocation);
const updateLocationImageMock = vi.mocked(updateLocationImage);
const getLocationsForCreateAndEditMock = vi.mocked(
  getLocationsForCreateAndEdit
);
const findFirstLocationMock = vi.mocked(db.location.findFirst);
const findManyLocationsMock = vi.mocked(db.location.findMany);
const findActiveAssignmentsMock = vi.mocked(db.assetLocation.findMany);
const countUnassignedAssetsMock = vi.mocked(db.asset.count);
const getArchivedAssetIdsMock = vi.mocked(getIoioArchivedItemIds);

function loaderArgs(url: string): LoaderFunctionArgs {
  return {
    context: { getSession: () => ({ userId: "staff-1" }) },
    params: { locationId: "section-1" },
    request: new Request(url),
  } as LoaderFunctionArgs;
}

function actionArgs(
  url: string,
  formData: FormData,
  locationId = "section-1"
): ActionFunctionArgs {
  return {
    context: { getSession: () => ({ userId: "staff-1" }) },
    params: { locationId },
    request: new Request(url, { method: "POST", body: formData }),
  } as ActionFunctionArgs;
}

const locationTree = [
  { id: "room-1", name: "IOIO Lab", parentId: null, color: "#455A64" },
  { id: "section-1", name: "Section A", parentId: "room-1", color: "#1565C0" },
  { id: "shelf-1", name: "Shelf A1", parentId: "section-1", color: null },
  { id: "box-1", name: "Box 1", parentId: "shelf-1", color: null },
];

describe("IOIO Locations routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requirePermissionMock.mockResolvedValue({
      organizationId: "org-1",
      userOrganizations: [],
    } as never);
    getArchivedAssetIdsMock.mockResolvedValue([]);
    findActiveAssignmentsMock.mockResolvedValue([] as never);
    countUnassignedAssetsMock.mockResolvedValue(0);
  });

  it("loads the full hierarchy and active asset-placement summary", async () => {
    getLocationsMock
      .mockResolvedValueOnce({
        locations: [locationTree[0]],
        totalLocations: 4,
      } as never)
      .mockResolvedValueOnce({
        locations: locationTree,
        totalLocations: 4,
      } as never);
    getArchivedAssetIdsMock.mockResolvedValue(["archived-asset"] as never);
    findActiveAssignmentsMock.mockResolvedValue([
      { assetId: "active-asset", locationId: "box-1" },
    ] as never);
    countUnassignedAssetsMock.mockResolvedValue(2);

    const result = await locationsIndexLoader(
      loaderArgs("https://example.com/locations")
    );

    expect(requirePermissionMock).toHaveBeenCalledWith({
      userId: "staff-1",
      request: expect.any(Request),
      entity: PermissionEntity.location,
      action: PermissionAction.read,
    });
    expect(getLocationsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        organizationId: "org-1",
        page: 1,
        perPage: 4,
      })
    );
    expect(getArchivedAssetIdsMock).toHaveBeenCalledWith({
      organizationId: "org-1",
      itemType: "ASSET",
    });
    expect(findActiveAssignmentsMock).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        asset: {
          organizationId: "org-1",
          id: { notIn: ["archived-asset"] },
        },
      },
      select: { assetId: true, locationId: true },
      distinct: ["assetId", "locationId"],
    });
    expect(countUnassignedAssetsMock).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        id: { notIn: ["archived-asset"] },
        assetLocations: { none: {} },
      },
    });
    expect(result.data).toMatchObject({
      header: { title: "Locations" },
      items: locationTree,
      inventorySummary: {
        containerAssetCounts: { "box-1": 1 },
        rooms: {
          "room-1": { sections: 1, shelves: 1, containers: 1, assets: 1 },
        },
        sections: { "section-1": { shelves: 1, containers: 1, assets: 1 } },
        unassignedOrIncompleteAssetCount: 2,
      },
    });
  });

  it.each(["room-1", "section-1", "shelf-1", "box-1", "stale-location"])(
    "reloads the Locations route for selectedLocation=%s",
    async (id) => {
      getLocationsMock.mockResolvedValue({
        locations: locationTree,
        totalLocations: locationTree.length,
      } as never);

      const result = await locationsIndexLoader(
        loaderArgs(
          `https://example.com/locations?selectedLocation=${id}&room=room-1`
        )
      );

      expect(result.data).toBeDefined();
      expect(getLocationsMock).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: "org-1" })
      );
    }
  );

  it("creates an inline child under the selected organization location", async () => {
    findFirstLocationMock.mockResolvedValue({
      id: "section-1",
      name: "Section A",
      parentId: "room-1",
      parent: { parentId: null },
    } as never);
    findManyLocationsMock.mockResolvedValue([] as never);
    createLocationMock.mockResolvedValue({ id: "shelf-new" } as never);

    const formData = new FormData();
    formData.set("intent", "inline-create");
    formData.set("locationType", "shelf");
    formData.set("parentId", "section-1");
    formData.set("name", "Shelf A2");
    const result = await locationsIndexAction(
      actionArgs("https://example.com/locations", formData)
    );

    expect(requirePermissionMock).toHaveBeenCalledWith({
      userId: "staff-1",
      request: expect.any(Request),
      entity: PermissionEntity.location,
      action: PermissionAction.create,
    });
    expect(findFirstLocationMock).toHaveBeenCalledWith({
      where: { id: "section-1", organizationId: "org-1" },
      select: {
        id: true,
        name: true,
        parentId: true,
        parent: { select: { parentId: true } },
      },
    });
    expect(createLocationMock).toHaveBeenCalledWith({
      name: "Shelf A2",
      description: "",
      address: "",
      userId: "staff-1",
      organizationId: "org-1",
      parentId: "section-1",
      color: null,
    });
    expect(result.data).toMatchObject({
      success: true,
      location: { id: "shelf-new" },
    });
  });

  it("returns to the deleted location's parent after a successful delete", async () => {
    deleteLocationMock.mockResolvedValue({
      id: "section-1",
      parentId: "room-1",
    } as never);

    const result = await deleteLocationAction(
      actionArgs("https://example.com/locations/section-1", new FormData())
    );

    expect(deleteLocationMock).toHaveBeenCalledWith({
      id: "section-1",
      organizationId: "org-1",
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe(
      "/locations?selectedLocation=room-1"
    );
  });

  it("returns to Locations after deleting a root location", async () => {
    deleteLocationMock.mockResolvedValue({
      id: "room-1",
      parentId: null,
    } as never);

    const result = await deleteLocationAction(
      actionArgs(
        "https://example.com/locations/room-1",
        new FormData(),
        "room-1"
      )
    );

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe("/locations");
  });

  it("returns a controlled response when deletion is blocked", async () => {
    deleteLocationMock.mockRejectedValueOnce({
      message:
        "This location contains child locations. Move or delete them first.",
      status: 409,
      label: "Location",
    });

    const result = await deleteLocationAction(
      actionArgs("https://example.com/locations/section-1", new FormData())
    );

    expect(result).toMatchObject({ init: { status: 409 } });
    expect(result.data).toMatchObject({
      error: {
        message:
          "This location contains child locations. Move or delete them first.",
      },
    });
  });

  it("creates an inline Section under the selected Room", async () => {
    findFirstLocationMock.mockResolvedValue({
      id: "room-1",
      name: "IOIO Lab - B477",
      parentId: null,
      parent: null,
    } as never);
    findManyLocationsMock.mockResolvedValue([] as never);
    createLocationMock.mockResolvedValue({
      id: "section-new",
      name: "Section D",
      parentId: "room-1",
    } as never);

    const formData = new FormData();
    formData.set("intent", "inline-create");
    formData.set("locationType", "section");
    formData.set("parentId", "room-1");
    formData.set("name", "Section D");
    const result = await locationsIndexAction(
      actionArgs("https://example.com/locations", formData)
    );

    expect(findFirstLocationMock).toHaveBeenCalledWith({
      where: { id: "room-1", organizationId: "org-1" },
      select: {
        id: true,
        name: true,
        parentId: true,
        parent: { select: { parentId: true } },
      },
    });
    expect(createLocationMock).toHaveBeenCalledWith({
      name: "Section D",
      description: "",
      address: "",
      userId: "staff-1",
      organizationId: "org-1",
      parentId: "room-1",
      color: null,
    });
    expect(result.data).toMatchObject({
      success: true,
      location: { id: "section-new", name: "Section D", parentId: "room-1" },
    });
  });

  it("moves the existing location record under the selected organization parent", async () => {
    findManyLocationsMock
      .mockResolvedValueOnce([
        { id: "broken", name: "Broken Section", parentId: null },
        { id: "room-1", name: "IOIO Lab - B477", parentId: null },
      ] as never)
      .mockResolvedValueOnce([] as never);
    updateLocationMock.mockResolvedValue({
      id: "broken",
      name: "Broken Section",
      parentId: "room-1",
    } as never);

    const formData = new FormData();
    formData.set("intent", "move-location");
    formData.set("locationId", "broken");
    formData.set("locationType", "section");
    formData.set("parentId", "room-1");
    const result = await locationsIndexAction(
      actionArgs("https://example.com/locations?index", formData)
    );

    expect(requirePermissionMock).toHaveBeenCalledWith({
      userId: "staff-1",
      request: expect.any(Request),
      entity: PermissionEntity.location,
      action: PermissionAction.update,
    });
    expect(updateLocationMock).toHaveBeenCalledWith({
      id: "broken",
      userId: "staff-1",
      organizationId: "org-1",
      parentId: "room-1",
    });
    expect(findActiveAssignmentsMock).not.toHaveBeenCalled();
    expect(result.data).toMatchObject({
      success: true,
      location: { id: "broken", parentId: "room-1" },
    });
  });

  it("returns a controlled error for duplicate sibling names during a move", async () => {
    findManyLocationsMock
      .mockResolvedValueOnce([
        { id: "section-a", name: "Section A", parentId: "room-1" },
        { id: "room-1", name: "IOIO Lab - B477", parentId: null },
      ] as never)
      .mockResolvedValueOnce([
        { id: "section-other", name: "Section A" },
      ] as never);

    const formData = new FormData();
    formData.set("intent", "move-location");
    formData.set("locationId", "section-a");
    formData.set("locationType", "section");
    formData.set("parentId", "room-1");
    const result = await locationsIndexAction(
      actionArgs("https://example.com/locations?index", formData)
    );

    expect(updateLocationMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      init: { status: 400 },
      data: {
        error: { message: "A location named Section A already exists here." },
      },
    });
  });

  it.each([
    {
      locationType: "room",
      parentId: null,
      parent: null,
      name: "Room Inline Test",
    },
    {
      locationType: "section",
      parentId: "room-1",
      parent: {
        id: "room-1",
        name: "IOIO Lab - B477",
        parentId: null,
        parent: null,
      },
      name: "Section Inline Test",
    },
    {
      locationType: "shelf",
      parentId: "section-1",
      parent: {
        id: "section-1",
        name: "Section A",
        parentId: "room-1",
        parent: { parentId: null },
      },
      name: "Shelf Inline Test",
    },
    {
      locationType: "container",
      parentId: "shelf-1",
      parent: {
        id: "shelf-1",
        name: "Shelf A1",
        parentId: "section-1",
        parent: { parentId: "room-1" },
      },
      name: "Container Inline Test",
    },
  ] as const)(
    "creates an inline $locationType using its selected parent",
    async ({ locationType, parentId, parent, name }) => {
      if (parent) findFirstLocationMock.mockResolvedValue(parent as never);
      findManyLocationsMock.mockResolvedValue([] as never);
      createLocationMock.mockResolvedValue({
        id: `${locationType}-inline-new`,
        name,
        parentId,
      } as never);

      const formData = new FormData();
      formData.set("intent", "inline-create");
      formData.set("locationType", locationType);
      formData.set("parentId", parentId ?? "");
      formData.set("name", name);
      const result = await locationsIndexAction(
        actionArgs("https://example.com/locations?index", formData)
      );

      if (parentId) {
        expect(findFirstLocationMock).toHaveBeenCalledWith({
          where: { id: parentId, organizationId: "org-1" },
          select: {
            id: true,
            name: true,
            parentId: true,
            parent: { select: { parentId: true } },
          },
        });
      } else {
        expect(findFirstLocationMock).not.toHaveBeenCalled();
      }
      expect(createLocationMock).toHaveBeenCalledWith({
        name,
        description: "",
        address: "",
        userId: "staff-1",
        organizationId: "org-1",
        parentId,
        color: locationType === "room" ? "#455A64" : null,
      });
      expect(result.data).toMatchObject({
        success: true,
        location: { id: `${locationType}-inline-new`, name, parentId },
      });
    }
  );

  it("rejects inline creation when the selected parent has the wrong depth", async () => {
    findFirstLocationMock.mockResolvedValue({
      id: "room-1",
      name: "IOIO Lab",
      parentId: null,
      parent: null,
    } as never);

    const formData = new FormData();
    formData.set("intent", "inline-create");
    formData.set("locationType", "container");
    formData.set("parentId", "room-1");
    formData.set("name", "Container A1-13");
    const result = await locationsIndexAction(
      actionArgs("https://example.com/locations", formData)
    );

    expect(createLocationMock).not.toHaveBeenCalled();
    expect(result.init).toMatchObject({ status: 400 });
  });

  it("loads an empty New location picker from the current organization", async () => {
    getLocationsForCreateAndEditMock.mockResolvedValue({
      locations: [],
      totalLocations: 0,
    } as never);

    const result = await newLocationLoader(
      loaderArgs("https://example.com/locations/new")
    );

    expect(getLocationsForCreateAndEditMock).toHaveBeenCalledWith({
      organizationId: "org-1",
      request: expect.objectContaining({
        url: expect.stringContaining("getAll=location"),
      }),
    });
    expect(result).toMatchObject({ locations: [], totalLocations: 0 });
  });

  it("passes the full organization hierarchy from the loader into Container creation", async () => {
    const creationLocations = [
      {
        id: "room-1",
        name: "IOIO Lab - B477",
        parentId: null,
        color: "#455A64",
      },
      {
        id: "section-a",
        name: "Section A",
        parentId: "room-1",
        color: null,
      },
      {
        id: "shelf-a1",
        name: "Shelf A1",
        parentId: "section-a",
        color: null,
      },
    ];
    getLocationsForCreateAndEditMock.mockResolvedValue({
      locations: creationLocations,
      totalLocations: creationLocations.length,
    } as never);

    const router = createMemoryRouter(
      [
        {
          path: "/locations/new",
          loader: async () => {
            const result = await newLocationLoader(
              loaderArgs("https://example.com/locations/new")
            );
            return result;
          },
          element: createElement(NewLocationPage),
        },
      ],
      { initialEntries: ["/locations/new"] }
    );
    const user = userEvent.setup();
    render(createElement(RouterProvider, { router }));

    await user.click(
      await screen.findByRole("button", { name: /Pick a room/ })
    );
    expect(getLocationsForCreateAndEditMock).toHaveBeenCalledWith({
      organizationId: "org-1",
      request: expect.objectContaining({
        url: expect.stringContaining("getAll=location"),
      }),
    });
    await user.click(
      await screen.findByRole("option", { name: "IOIO Lab - B477" })
    );
    await user.click(screen.getByRole("button", { name: /Box \/ Container/ }));
    await user.click(screen.getByRole("button", { name: /Pick a section/ }));
    await user.click(await screen.findByRole("option", { name: "Section A" }));

    const shelfTrigger = screen.getByRole("button", { name: /Pick a shelf/ });
    expect(shelfTrigger).toBeEnabled();
    expect(screen.queryByText("No shelves in this section.")).toBeNull();
    await user.click(shelfTrigger);
    await user.click(await screen.findByRole("option", { name: "Shelf A1" }));

    const form = screen.getByLabelText("Box / Container name").closest("form");
    expect(form).not.toBeNull();
    expect(new FormData(form as HTMLFormElement).get("parentId")).toBe(
      "shelf-a1"
    );
  });

  it("creates a child location without persisting a separate color", async () => {
    findFirstLocationMock.mockResolvedValue({
      id: "room-1",
      name: "IOIO Lab",
      parentId: null,
      parent: null,
    } as never);
    findManyLocationsMock.mockResolvedValue([] as never);
    createLocationMock.mockResolvedValue({
      id: "section-new",
      imageUrl: null,
      thumbnailUrl: null,
    } as never);

    const formData = new FormData();
    formData.set("locationType", "section");
    formData.set("name", "Section B");
    formData.set("parentId", "room-1");
    formData.set("color", "#1565C0");
    const result = await newLocationAction(
      actionArgs("https://example.com/locations/new", formData)
    );

    expect(createLocationMock).toHaveBeenCalledWith({
      name: "Section B",
      description: "",
      address: "",
      userId: "staff-1",
      organizationId: "org-1",
      parentId: "room-1",
      color: null,
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe(
      "/locations?selectedLocation=section-new&created=1"
    );
  });

  it("preserves the selected Section as the parent when creating a Shelf", async () => {
    findFirstLocationMock.mockResolvedValue({
      id: "section-a",
      name: "Section A",
      parentId: "room-1",
      parent: { parentId: null },
    } as never);
    findManyLocationsMock.mockResolvedValue([] as never);
    createLocationMock.mockResolvedValue({
      id: "shelf-new",
      imageUrl: null,
      thumbnailUrl: null,
    } as never);

    const formData = new FormData();
    formData.set("locationType", "shelf");
    formData.set("name", "Shelf A2");
    formData.set("parentId", "section-a");

    await newLocationAction(
      actionArgs("https://example.com/locations/new", formData)
    );

    expect(createLocationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Shelf A2",
        organizationId: "org-1",
        parentId: "section-a",
      })
    );
  });

  it("creates a Container under the selected Room → Section → Shelf", async () => {
    findFirstLocationMock.mockResolvedValue({
      id: "shelf-1",
      name: "Shelf A1",
      parentId: "section-1",
      parent: { parentId: "room-1" },
    } as never);
    findManyLocationsMock.mockResolvedValue([] as never);
    createLocationMock.mockResolvedValue({
      id: "container-new",
      imageUrl: null,
      thumbnailUrl: null,
    } as never);

    const formData = new FormData();
    formData.set("locationType", "container");
    formData.set("name", "Container A1-2");
    formData.set("parentId", "shelf-1");
    formData.set("color", "#C62828");

    const result = await newLocationAction(
      actionArgs("https://example.com/locations/new", formData)
    );

    expect(createLocationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Container A1-2",
        parentId: "shelf-1",
        color: null,
      })
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
  });

  it("stores a selected color for a new Room", async () => {
    findManyLocationsMock.mockResolvedValue([] as never);
    createLocationMock.mockResolvedValue({
      id: "room-new",
      imageUrl: null,
      thumbnailUrl: null,
    } as never);
    const formData = new FormData();
    formData.set("locationType", "room");
    formData.set("name", "IOIO Lab - B477");
    formData.set("color", "#1565C0");

    await newLocationAction(
      actionArgs("https://example.com/locations/new", formData)
    );

    expect(createLocationMock).toHaveBeenCalledWith(
      expect.objectContaining({ parentId: null, color: "#1565C0" })
    );
  });

  it("derives edit hierarchy and excludes the location's descendants", async () => {
    getLocationMock.mockResolvedValue({
      location: { id: "section-1", name: "Section A", parentId: "room-1" },
    } as never);
    getLocationsForCreateAndEditMock.mockResolvedValue({
      locations: locationTree,
      totalLocations: locationTree.length,
    } as never);

    const result = await editLocationLoader(
      loaderArgs("https://example.com/locations/section-1/edit")
    );

    expect(result).toMatchObject({
      locationType: "section",
      excludeLocationIds: ["section-1", "shelf-1", "box-1"],
      locations: locationTree,
    });
  });

  it("loads location detail, hierarchy, and asset count within the active organization", async () => {
    getLocationMock.mockResolvedValue({
      location: {
        id: "section-1",
        name: "Section A",
        address: null,
        description: "Equipment section",
        latitude: null,
        longitude: null,
      },
      totalAssetsWithinLocation: 2,
    } as never);
    getLocationHierarchyMock.mockResolvedValue([
      { id: "room-1", name: "IOIO Lab" },
      { id: "section-1", name: "Section A" },
    ] as never);
    getLocationDescendantsTreeMock.mockResolvedValue([] as never);

    const result = await locationDetailLoader(
      loaderArgs("https://example.com/locations/section-1")
    );

    expect(getLocationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "section-1",
        organizationId: "org-1",
        userOrganizations: [],
      })
    );
    expect(getLocationHierarchyMock).toHaveBeenCalledWith({
      organizationId: "org-1",
      locationId: "section-1",
    });
    expect(result.data).toMatchObject({
      header: { title: "Section A" },
      breadcrumbs: [{ id: "room-1", name: "IOIO Lab" }],
      totalAssetsWithinLocation: 2,
      mapData: null,
    });
  });

  it("updates shared location fields through the organization-scoped service", async () => {
    getLocationMock.mockResolvedValue({
      location: {
        id: "section-1",
        name: "Section A",
        parentId: "room-1",
        imageUrl: null,
        thumbnailUrl: null,
      },
    } as never);
    getLocationsForCreateAndEditMock.mockResolvedValue({
      locations: locationTree,
      totalLocations: locationTree.length,
    } as never);
    updateLocationMock.mockResolvedValue({
      id: "section-1",
      imageUrl: null,
      thumbnailUrl: null,
    } as never);
    const formData = new FormData();
    formData.set("name", "Section A updated");
    formData.set("description", "Updated description");
    formData.set("address", "");
    formData.set("parentId", "room-1");
    formData.set("color", "#2E7D32");

    await editLocationAction(
      actionArgs("https://example.com/locations/section-1/edit", formData)
    );

    expect(updateLocationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "section-1",
        organizationId: "org-1",
        parentId: "room-1",
        color: null,
        name: "Section A updated",
      })
    );
    expect(updateLocationImageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        locationId: "section-1",
        organizationId: "org-1",
      })
    );
  });

  it("updates the selected Room theme color", async () => {
    getLocationMock.mockResolvedValue({
      location: {
        id: "room-1",
        name: "IOIO Lab",
        parentId: null,
        color: "#455A64",
        imageUrl: null,
        thumbnailUrl: null,
      },
    } as never);
    getLocationsForCreateAndEditMock.mockResolvedValue({
      locations: locationTree,
      totalLocations: locationTree.length,
    } as never);
    updateLocationMock.mockResolvedValue({
      id: "room-1",
      imageUrl: null,
      thumbnailUrl: null,
    } as never);

    const formData = new FormData();
    formData.set("name", "IOIO Lab");
    formData.set("description", "IOIO Lab room");
    formData.set("address", "");
    formData.set("parentId", "");
    formData.set("color", "#C62828");

    await editLocationAction(
      actionArgs(
        "https://example.com/locations/room-1/edit",
        formData,
        "room-1"
      )
    );

    expect(updateLocationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "room-1",
        parentId: null,
        color: "#C62828",
      })
    );
  });
});
