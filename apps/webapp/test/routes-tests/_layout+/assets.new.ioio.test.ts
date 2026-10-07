import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateAssetMainImage } from "~/modules/asset/service.server";
import { action, loader } from "~/routes/_layout+/assets.new";

const {
  requirePermission,
  getAllEntriesForCreateAndEdit,
  getAssetModels,
  getActiveCustomFields,
  createAsset,
} = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  getAllEntriesForCreateAndEdit: vi.fn(),
  getAssetModels: vi.fn(),
  getActiveCustomFields: vi.fn(),
  createAsset: vi.fn(),
}));

// why: the route test verifies authorization and the create workflow at its
// service boundary; database, storage, and notification effects stay isolated.
vi.mock("~/modules/asset/service.server", () => ({
  bulkCreateAssetsFromModel: vi.fn(),
  createAsset,
  getAllEntriesForCreateAndEdit,
  updateAssetMainImage: vi.fn().mockResolvedValue(false),
}));
// why: custom-field definitions are organization data, and this test uses a
// fresh Team organization with no configured fields.
vi.mock("~/modules/custom-field/service.server", () => ({
  getActiveCustomFields,
}));
// why: asset-model reads/writes are unrelated to the quantity-tracked create
// path under test.
vi.mock("~/modules/asset-model/service.server", () => ({
  createAssetModel: vi.fn(),
  getAssetModel: vi.fn(),
  getAssetModels,
}));
// why: permission resolution is the authorization boundary under test and
// must not reach the real session/database services.
vi.mock("~/utils/roles.server", () => ({ requirePermission }));
// why: these side effects are asserted only through the resulting asset and
// should not access storage, notifications, or notes in this unit test.
vi.mock("~/modules/asset/utils.server", () => ({
  getInitialPlacementNoteContent: vi.fn().mockReturnValue(null),
}));
vi.mock("~/modules/note/service.server", () => ({
  createNote: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("~/modules/ioio-lab-information/service.server", () => ({
  getAcademicYear: vi.fn().mockReturnValue("2026-2027"),
}));
vi.mock("~/modules/ioio-staff/purchasing.server", () => ({
  linkPurchaseItemToAsset: vi.fn(),
}));
vi.mock("~/modules/qr/service.server", () => ({
  assertWhetherQrBelongsToCurrentOrganization: vi.fn(),
}));
vi.mock("~/modules/tag/service.server", () => ({
  buildTagsSet: vi.fn().mockReturnValue({ set: [] }),
}));
vi.mock("~/utils/emitter/send-notification.server", () => ({
  sendNotification: vi.fn(),
}));
vi.mock("~/modules/asset/sequential-id.server", () => ({
  estimateNextSequentialId: vi.fn().mockResolvedValue(1),
}));

function routeArgs(request: Request) {
  return {
    request,
    params: {},
    context: { getSession: () => ({ userId: "staff-1" }) },
  } as unknown as Parameters<typeof loader>[0];
}

function createFormData() {
  const formData = new FormData();
  formData.set("title", "Test inventory item");
  formData.set("description", "");
  formData.set("category", "category-1");
  formData.set("newLocationId", "location-1");
  formData.set("type", "QUANTITY_TRACKED");
  formData.set("quantity", "2");
  formData.set("consumptionType", "TWO_WAY");
  formData.set("maxBorrowDays", "45");
  formData.set("extensionBorrowDays", "45");
  formData.set("returnHandling", "RETURN_TO_STORAGE");
  return formData;
}

describe("IOIO /assets/new route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requirePermission.mockResolvedValue({
      organizationId: "team-org-1",
      currentOrganization: { id: "team-org-1", type: "TEAM", currency: "DKK" },
      canUseBarcodes: false,
    });
    getAllEntriesForCreateAndEdit.mockResolvedValue({
      categories: [],
      totalCategories: 0,
      tags: [],
      locations: [],
      totalLocations: 0,
    });
    getAssetModels.mockResolvedValue({ assetModels: [], totalAssetModels: 0 });
    getActiveCustomFields.mockResolvedValue([]);
    createAsset.mockResolvedValue({
      id: "asset-1",
      title: "Test inventory item",
      user: { id: "staff-1", displayName: "Staff User" },
    });
  });

  it("requires asset-create permission and loads a fresh Team workspace", async () => {
    const result = await loader(
      routeArgs(new Request("http://localhost/assets/new"))
    );

    expect(requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "staff-1",
        entity: "asset",
        action: "create",
      })
    );
    expect(result).toMatchObject({
      categories: [],
      locations: [],
      assetModels: [],
      customFields: [],
      prefillTitle: "",
      prefillQuantity: null,
    });
  });

  it("creates an asset using the modern organization-scoped asset service", async () => {
    const request = new Request("http://localhost/assets/new", {
      method: "POST",
      body: createFormData(),
    });

    const response = await action(routeArgs(request));

    expect(createAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "team-org-1",
        userId: "staff-1",
        title: "Test inventory item",
        description: "",
        categoryId: "category-1",
        locationId: "location-1",
        type: "QUANTITY_TRACKED",
        quantity: 2,
      })
    );
    expect(updateAssetMainImage).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "asset-1",
        organizationId: "team-org-1",
        isNewAsset: true,
      })
    );
    expect(requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ entity: "asset", action: "create" })
    );
    expect(response).toMatchObject({ status: 302 });
  });

  it("returns to a cleared creation form after Add another", async () => {
    const formData = createFormData();
    formData.set("addAnother", "true");
    const response = await action(
      routeArgs(
        new Request("http://localhost/assets/new", {
          method: "POST",
          body: formData,
        })
      )
    );

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      throw new Error("Add another should return a redirect response");
    }
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/assets/new?");
  });
});
