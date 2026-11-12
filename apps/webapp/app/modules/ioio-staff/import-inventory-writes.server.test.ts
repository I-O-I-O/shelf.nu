import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertImportInventoryOperation,
  createImportAsset,
  updateImportAsset,
} from "./import-inventory-writes.server";
const canonical = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn() }));
// why: observe the canonical mutation boundary without touching a real database.
vi.mock("~/modules/asset/service.server", () => ({
  createAsset: canonical.create,
  updateAsset: canonical.update,
}));
const scope = { importSessionId: "import-A3", importCandidateId: "row-45" };
beforeEach(() => {
  vi.clearAllMocks();
  canonical.create.mockResolvedValue({ id: "created" });
  canonical.update.mockResolvedValue({ id: "existing" });
});
describe("non-destructive import write boundary", () => {
  it.each([
    "DELETE_ASSET",
    "DELETE_ASSET_MODEL",
    "ARCHIVE_ASSET",
    "ARCHIVE_ASSET_MODEL",
    "SOFT_DELETE",
    "REMOVE_LOCATION",
    "REVERT",
    "CASCADE_DELETE",
  ])("rejects %s server-side", (operation) => {
    expect(() => assertImportInventoryOperation(operation)).toThrow(
      "cannot delete, archive, or undo"
    );
    expect(canonical.create).not.toHaveBeenCalled();
    expect(canonical.update).not.toHaveBeenCalled();
  });
  it.each([0, -1, null, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses unsafe existing quantity %s",
    async (quantity) => {
      await expect(
        updateImportAsset({
          ...scope,
          id: "existing",
          organizationId: "org",
          userId: "staff",
          request: new Request("http://localhost"),
          quantity,
        } as never)
      ).rejects.toThrow("must be positive");
      expect(canonical.update).not.toHaveBeenCalled();
    }
  );
  it.each([
    { newLocationId: null },
    { newLocationId: "new-bin", currentLocationId: "A1-1" },
    { deletedAt: new Date() },
    { status: "ARCHIVED" },
    { type: "INDIVIDUAL" },
    { assetModelId: null },
    { manualLocations: [] },
  ])("refuses destructive or unsupported patches %j", async (patch) => {
    await expect(
      updateImportAsset({
        ...scope,
        id: "existing",
        organizationId: "org",
        userId: "staff",
        request: new Request("http://localhost"),
        quantity: 25,
        ...patch,
      } as never)
    ).rejects.toThrow();
    expect(canonical.update).not.toHaveBeenCalled();
  });
  it("passes reviewed positive quantities without placement/lifecycle fields", async () => {
    await updateImportAsset({
      ...scope,
      id: "existing",
      organizationId: "org",
      userId: "staff",
      request: new Request("http://localhost"),
      quantity: 25,
    } as never);
    expect(canonical.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: "existing", quantity: 25 })
    );
    expect(canonical.update.mock.calls[0][0]).not.toHaveProperty(
      "newLocationId"
    );
    expect(canonical.update.mock.calls[0][0]).not.toHaveProperty(
      "importSessionId"
    );
  });
  it("creates stock at its assigned bin and refuses lifecycle flags", async () => {
    await createImportAsset({
      ...scope,
      title: "A3 stock",
      organizationId: "org",
      userId: "staff",
      type: "QUANTITY_TRACKED",
      quantity: 25,
      locationId: "A3-10",
    } as never);
    expect(canonical.create).toHaveBeenCalledWith(
      expect.objectContaining({ locationId: "A3-10", quantity: 25 })
    );
    await expect(
      createImportAsset({
        ...scope,
        title: "hidden",
        type: "QUANTITY_TRACKED",
        quantity: 25,
        ioioHidden: true,
      } as never)
    ).rejects.toThrow();
    expect(canonical.create).toHaveBeenCalledOnce();
  });
});
