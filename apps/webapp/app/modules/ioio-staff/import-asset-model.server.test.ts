import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  assetModel: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  },
}));
const mockCreateAssetModel = vi.hoisted(() => vi.fn());

// why: identity resolution is tested against controlled organization-scoped
// AssetModel rows; no real database or Shelf side effects are needed here.
vi.mock("~/database/db.server", () => ({ db: database }));

// why: persistence and unique-index race recovery are tested in the AssetModel
// service suite; these tests focus on the import resolver's deterministic policy.
vi.mock("~/modules/asset-model/service.server", () => ({
  createAssetModel: mockCreateAssetModel,
}));

import {
  getImportAssetModelIdentity,
  resolveImportAssetModel,
} from "./import-asset-model.server";

type Model = {
  id: string;
  organizationId: string;
  name: string;
  importIdentityKey: string | null;
};

describe("import AssetModel identity resolution", () => {
  let models: Model[];

  beforeEach(() => {
    vi.clearAllMocks();
    models = [];
    database.assetModel.findFirst.mockImplementation(
      ({ where }) =>
        models.find(
          (model) =>
            model.organizationId === where.organizationId &&
            (where.id
              ? model.id === where.id
              : model.importIdentityKey === where.importIdentityKey)
        ) ?? null
    );
    database.assetModel.findMany.mockImplementation(({ where }) =>
      models.filter(
        (model) =>
          model.organizationId === where.organizationId &&
          model.name.toLocaleLowerCase("en-US") ===
            where.name.equals.toLocaleLowerCase("en-US")
      )
    );
    database.assetModel.updateMany.mockImplementation(({ where, data }) => {
      const model = models.find(
        (entry) =>
          entry.id === where.id &&
          entry.organizationId === where.organizationId &&
          entry.importIdentityKey === where.importIdentityKey
      );
      if (!model) return { count: 0 };
      Object.assign(model, data);
      return { count: 1 };
    });
    mockCreateAssetModel.mockImplementation(
      ({ id, organizationId, name, importIdentityKey }) => {
        const concurrent = models.find(
          (model) =>
            model.organizationId === organizationId &&
            model.importIdentityKey === importIdentityKey
        );
        if (concurrent) {
          const error = new Error("unique constraint") as Error & {
            code: string;
          };
          error.code = "P2002";
          throw error;
        }
        const model = {
          id: id ?? `model-generated-${models.length + 1}`,
          organizationId,
          name,
          importIdentityKey,
        };
        models.push(model);
        return model;
      }
    );
  });

  it("normalizes case and whitespace deterministically", () => {
    expect(
      getImportAssetModelIdentity({
        name: "  Arduino   Nano 33 BLE ",
        manufacturer: " ARDUINO  ",
        manufacturerPartNumber: " ABX00031 ",
      })
    ).toEqual(
      getImportAssetModelIdentity({
        name: "arduino nano 33 ble",
        manufacturer: "arduino",
        manufacturerPartNumber: "abx00031",
      })
    );
  });

  it("reuses the same canonical model on same-import retries", async () => {
    const first = await resolveImportAssetModel({
      organizationId: "org-1",
      userId: "staff-1",
      name: "Arduino Nano 33 BLE",
      manufacturer: "Arduino",
      manufacturerPartNumber: "ABX00031",
      preferredModelId: "model-import-a",
    });
    const retry = await resolveImportAssetModel({
      organizationId: "org-1",
      userId: "staff-1",
      name: "Arduino Nano 33 BLE",
      manufacturer: "Arduino",
      manufacturerPartNumber: "ABX00031",
      preferredModelId: "different-reserved-id",
    });

    expect(first).toMatchObject({
      status: "RESOLVED",
      assetModelId: "model-import-a",
    });
    expect(retry).toEqual(first);
    expect(mockCreateAssetModel).toHaveBeenCalledTimes(1);
  });

  it("reuses an existing exact manufacturer and MPN identity", async () => {
    const identity = getImportAssetModelIdentity({
      name: "Arduino Nano 33 BLE",
      manufacturer: "Arduino",
      manufacturerPartNumber: "ABX00031",
    });
    models.push({
      id: "model-canonical",
      organizationId: "org-1",
      name: "Arduino Nano 33 BLE Rev2",
      importIdentityKey: identity.key,
    });

    const result = await resolveImportAssetModel({
      organizationId: "org-1",
      userId: "staff-1",
      name: "Arduino Nano 33 BLE",
      manufacturer: "Arduino",
      manufacturerPartNumber: "ABX00031",
      preferredModelId: "unused-reserved-id",
    });

    expect(result).toMatchObject({
      status: "RESOLVED",
      assetModelId: "model-canonical",
      importIdentityKey: identity.key,
    });
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
  });

  it("concurrent imports for an exact manufacturer and MPN resolve to one model", async () => {
    const inputs = {
      organizationId: "org-1",
      userId: "staff-1",
      name: "Arduino Nano 33 BLE",
      manufacturer: "Arduino",
      manufacturerPartNumber: "ABX00031",
    };
    const [first, second] = await Promise.all([
      resolveImportAssetModel({ ...inputs, preferredModelId: "model-a" }),
      resolveImportAssetModel({ ...inputs, preferredModelId: "model-b" }),
    ]);

    expect(first).toMatchObject({ status: "RESOLVED" });
    expect(second).toEqual(first);
    expect(models).toHaveLength(1);
  });

  it("does not merge same-name products with different MPNs", async () => {
    const first = await resolveImportAssetModel({
      organizationId: "org-1",
      userId: "staff-1",
      name: "Arduino Nano",
      manufacturer: "Arduino",
      manufacturerPartNumber: "NANO-A",
    });
    const second = await resolveImportAssetModel({
      organizationId: "org-1",
      userId: "staff-1",
      name: "Arduino Nano",
      manufacturer: "Arduino",
      manufacturerPartNumber: "NANO-B",
    });

    expect(first).toMatchObject({ status: "RESOLVED" });
    expect(second).toMatchObject({ status: "RESOLVED" });
    expect(models).toHaveLength(2);
    expect(models[0].id).not.toBe(models[1].id);
  });

  it("does not match the same MPN across organizations", async () => {
    const inputs = {
      userId: "staff-1",
      name: "Arduino Nano 33 BLE",
      manufacturer: "Arduino",
      manufacturerPartNumber: "ABX00031",
    };
    const first = await resolveImportAssetModel({
      ...inputs,
      organizationId: "org-1",
    });
    const second = await resolveImportAssetModel({
      ...inputs,
      organizationId: "org-2",
    });

    expect(first).toMatchObject({ status: "RESOLVED" });
    expect(second).toMatchObject({ status: "RESOLVED" });
    expect(models).toHaveLength(2);
    expect(models[0].id).not.toBe(models[1].id);
  });

  it("returns a conflict for ambiguous legacy name-only matches", async () => {
    models.push(
      {
        id: "model-1",
        organizationId: "org-1",
        name: "Arduino Nano",
        importIdentityKey: null,
      },
      {
        id: "model-2",
        organizationId: "org-1",
        name: "arduino nano",
        importIdentityKey: null,
      }
    );

    const result = await resolveImportAssetModel({
      organizationId: "org-1",
      userId: "staff-1",
      name: "Arduino   Nano",
    });

    expect(result).toMatchObject({
      status: "CONFLICT",
      code: "AMBIGUOUS_IMPORT_ASSET_MODEL_NAME",
    });
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
  });

  it("adopts one exact legacy name match for name-only fallback", async () => {
    models.push({
      id: "legacy-model",
      organizationId: "org-1",
      name: "Arduino Nano",
      importIdentityKey: null,
    });

    const result = await resolveImportAssetModel({
      organizationId: "org-1",
      userId: "staff-1",
      name: "  arduino   nano ",
    });

    expect(result).toMatchObject({
      status: "RESOLVED",
      assetModelId: "legacy-model",
    });
    expect(models[0].importIdentityKey).toBe(
      getImportAssetModelIdentity({ name: "Arduino Nano" }).key
    );
    expect(mockCreateAssetModel).not.toHaveBeenCalled();
  });

  it("still reports a duplicate-name conflict when a name-keyed model exists", async () => {
    const identity = getImportAssetModelIdentity({ name: "Arduino Nano" });
    models.push(
      {
        id: "keyed-model",
        organizationId: "org-1",
        name: "Arduino Nano",
        importIdentityKey: identity.key,
      },
      {
        id: "legacy-duplicate",
        organizationId: "org-1",
        name: "Arduino Nano",
        importIdentityKey: null,
      }
    );

    const result = await resolveImportAssetModel({
      organizationId: "org-1",
      userId: "staff-1",
      name: "Arduino Nano",
    });

    expect(result).toMatchObject({
      status: "CONFLICT",
      code: "AMBIGUOUS_IMPORT_ASSET_MODEL_NAME",
    });
  });
});
