import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAsset: vi.fn(),
}));

// why: the focused loader test stops after the organization-scoped asset lookup
// and verifies navigation without depending on a live Shelf database.
vi.mock("~/modules/asset/service.server", () => ({
  bulkUpdateAssetCategory: vi.fn(),
  bulkUpdateAssetLocation: vi.fn(),
  convertIndividualProductToQuantityTracked: vi.fn(),
  convertQuantityTrackedAssetBulk: vi.fn(),
  ensureIndividualAssetModel: vi.fn(),
  getAllEntriesForCreateAndEdit: vi.fn(),
  getAsset: mocks.getAsset,
  updateAsset: vi.fn(),
  updateAssetMainImage: vi.fn(),
}));

// why: this route test isolates the scoped edit redirect from Shelf's role
// resolution and verifies that the destination remains permission protected.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: vi.fn().mockResolvedValue({
    organizationId: "org-1",
    currentOrganization: { id: "org-1", type: "TEAM" },
    userOrganizations: [],
  }),
}));

import { loader } from "~/routes/_layout+/assets.$assetId_.edit";

describe("physical unit Edit navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAsset.mockResolvedValue({
      id: "unit-1",
      type: "INDIVIDUAL",
      assetModelId: "model-1",
    });
  });

  it("opens the existing general-item editor instead of availability controls", async () => {
    const response = await loader({
      context: { getSession: () => ({ userId: "staff-1" }) },
      request: new Request("http://localhost/assets/unit-1/edit"),
      params: { assetId: "unit-1" },
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("Location")).toBe(
      "/assets/unit-1/edit?productGroup=1"
    );
  });
});
