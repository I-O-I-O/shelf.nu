import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLocation,
  getLocationDescendantsTree,
  getLocationHierarchy,
  getLocation,
  getLocations,
  updateLocation,
  updateLocationImage,
} from "~/modules/location/service.server";
import { getLocationsForCreateAndEdit } from "~/modules/asset/service.server";
import { requirePermission } from "~/utils/roles.server";
import { db } from "~/database/db.server";
import { loader as locationsIndexLoader } from "~/routes/_layout+/locations._index";
import {
  action as newLocationAction,
  loader as newLocationLoader,
} from "~/routes/_layout+/locations.new";
import {
  action as editLocationAction,
  loader as editLocationLoader,
} from "~/routes/_layout+/locations.$locationId_.edit";
import { loader as locationDetailLoader } from "~/routes/_layout+/locations.$locationId";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";

// why: route tests need deterministic organization-scoped permission results.
vi.mock("~/utils/roles.server", () => ({ requirePermission: vi.fn() }));
// why: these route tests verify route-to-service adaptation without database or storage I/O.
vi.mock("~/modules/location/service.server", () => ({
  createLocation: vi.fn(),
  getLocationDescendantsTree: vi.fn(),
  getLocation: vi.fn(),
  getLocationHierarchy: vi.fn(),
  getLocations: vi.fn(),
  removeLocationImage: vi.fn(),
  updateLocation: vi.fn(),
  updateLocationImage: vi.fn(),
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
  },
}));
// why: route behavior is asserted without sending notifications to the app event bus.
vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: vi.fn(),
}));

const requirePermissionMock = vi.mocked(requirePermission);
const createLocationMock = vi.mocked(createLocation);
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

function loaderArgs(url: string): LoaderFunctionArgs {
  return {
    context: { getSession: () => ({ userId: "staff-1" }) },
    params: { locationId: "section-1" },
    request: new Request(url),
  } as LoaderFunctionArgs;
}

function actionArgs(url: string, formData: FormData): ActionFunctionArgs {
  return {
    context: { getSession: () => ({ userId: "staff-1" }) },
    params: { locationId: "section-1" },
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
  });

  it("loads the full filtered location hierarchy for the IOIO landing page", async () => {
    getLocationsMock
      .mockResolvedValueOnce({
        locations: [locationTree[0]],
        totalLocations: 4,
      } as never)
      .mockResolvedValueOnce({
        locations: locationTree,
        totalLocations: 4,
      } as never);

    const result = await locationsIndexLoader(
      loaderArgs("https://example.com/locations?s=IOIO&selectedLocation=room-1")
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
        search: "IOIO",
      })
    );
    expect(result.data).toMatchObject({
      header: { title: "Locations - 4" },
      items: locationTree,
      selectedLocationId: "room-1",
      searchFieldLabel: "Search locations",
    });
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

  it("creates a location with the selected IOIO level and color", async () => {
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
      color: "#1565C0",
    });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("Location")).toBe(
      "/locations?selectedLocation=section-new&created=1"
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
        color: "#2E7D32",
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
});
