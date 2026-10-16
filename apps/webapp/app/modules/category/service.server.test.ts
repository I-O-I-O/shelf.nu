import { beforeEach, describe, expect, it, vi } from "vitest";

const { dbMock, archiveIdsMock, moveToDispositionMock } = vi.hoisted(() => ({
  dbMock: {
    category: {
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
  },
  archiveIdsMock: vi.fn(),
  moveToDispositionMock: vi.fn(),
}));

// why: these tests verify category reads and ordinary edits/deletes without
// writing to the development database.
vi.mock("~/database/db.server", () => ({ db: dbMock }));

// why: IOIO trash markers are an existing delete workflow boundary; observe
// calls without invoking unrelated lifecycle persistence.
vi.mock("../ioio-staff/archive.server", () => ({
  IOIO_ITEM_DISPOSITION: { TRASH: "TRASH" },
  getIoioArchivedCategoryIds: archiveIdsMock,
  moveIoioCategoryToDisposition: moveToDispositionMock,
}));

import {
  bulkDeleteCategories,
  createCategory,
  deleteCategory,
  getActiveCategoriesForOrganization,
  getCategories,
  updateCategory,
} from "./service.server";

const orgId = "ioio-team";

function category(name: string, id = name.toLowerCase()) {
  return {
    id,
    name,
    description: null,
    color: "#808080",
    _count: { assets: 0 },
  };
}

describe("IOIO category records", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    archiveIdsMock.mockResolvedValue([]);
  });

  it("uses only current organization categories and does not recreate a deleted default", async () => {
    const currentCategories = [
      { id: "custom", name: "Robotics", color: "#123456" },
      { id: "legacy", name: "Inventory", color: "#654321" },
    ];
    dbMock.category.findMany.mockResolvedValue(currentCategories);

    const firstRead = await getActiveCategoriesForOrganization({
      organizationId: orgId,
    });
    const secondRead = await getActiveCategoriesForOrganization({
      organizationId: orgId,
    });

    expect(firstRead).toEqual(currentCategories);
    expect(secondRead).toEqual(currentCategories);
    expect(dbMock.category.create).not.toHaveBeenCalled();
    expect(dbMock.category.findMany).toHaveBeenCalledTimes(2);
  });

  it("keeps current category relationships intact during reads", async () => {
    const existingCategories = [
      { ...category("Cables"), _count: { assets: 0 } },
      { ...category("Furniture"), _count: { assets: 0 } },
      { ...category("Inventory"), _count: { assets: 5 } },
      { ...category("Machinery"), _count: { assets: 1 } },
      { ...category("Office Equipment"), _count: { assets: 0 } },
      { ...category("Other"), _count: { assets: 0 } },
      { ...category("Supplies"), _count: { assets: 0 } },
    ];
    dbMock.category.findMany.mockResolvedValue(existingCategories);
    dbMock.category.count.mockResolvedValue(existingCategories.length);

    const result = await getCategories({ organizationId: orgId, perPage: 20 });

    expect(result.categories).toEqual(existingCategories);
    expect(dbMock.category.update).not.toHaveBeenCalled();
    expect(dbMock.category.deleteMany).not.toHaveBeenCalled();
    expect(dbMock.category.create).not.toHaveBeenCalled();
  });

  it("allows editing a default category name, description, and color", async () => {
    dbMock.category.update.mockResolvedValue({ id: "electronics" });

    await expect(
      updateCategory({
        id: "electronics",
        organizationId: orgId,
        name: "Robotics",
        description: "Updated description",
        color: "#123456",
      })
    ).resolves.toEqual({ id: "electronics" });
    expect(dbMock.category.update).toHaveBeenCalledWith({
      where: { id: "electronics", organizationId: orgId },
      data: {
        name: "Robotics",
        description: "Updated description",
        color: "#123456",
      },
    });
  });

  it("allows Staff to create ordinary custom categories", async () => {
    dbMock.category.create.mockResolvedValue({
      id: "robotics",
      name: "Robotics",
    });

    await expect(
      createCategory({
        name: "Robotics",
        description: "Custom category",
        color: "#123456",
        userId: "staff-1",
        organizationId: orgId,
      })
    ).resolves.toEqual({ id: "robotics", name: "Robotics" });
    expect(dbMock.category.create).toHaveBeenCalledOnce();
  });

  it("deletes a default category through the normal category delete flow", async () => {
    dbMock.category.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      deleteCategory({ id: "electronics", organizationId: orgId })
    ).resolves.toEqual({ count: 1 });
    expect(dbMock.category.deleteMany).toHaveBeenCalledWith({
      where: { id: "electronics", organizationId: orgId },
    });
  });

  it("keeps the normal custom category delete and bulk trash flows", async () => {
    dbMock.category.deleteMany.mockResolvedValue({ count: 1 });
    dbMock.category.findMany.mockResolvedValue([{ id: "robotics" }]);

    await deleteCategory({ id: "robotics", organizationId: orgId });
    await bulkDeleteCategories({
      categoryIds: ["robotics"],
      organizationId: orgId,
      movedById: "staff-1",
    });

    expect(dbMock.category.deleteMany).toHaveBeenCalledWith({
      where: { id: "robotics", organizationId: orgId },
    });
    expect(moveToDispositionMock).toHaveBeenCalledWith({
      organizationId: orgId,
      categoryId: "robotics",
      movedById: "staff-1",
      disposition: "TRASH",
    });
  });
});
