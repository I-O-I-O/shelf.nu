import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/database/db.server";
import {
  DEFAULT_LAB_INFORMATION,
  createCustomLabInfoSection,
  deleteCustomLabInfoSection,
  getLabInformation,
  reorderLabInfoSections,
  updateLabInfoSectionImages,
  updateLabInformationField,
} from "./service.server";

const imageDb = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
}));

const sectionDb = vi.hoisted(() => ({
  findFirst: vi.fn(),
  delete: vi.fn(),
}));

// @vitest-environment node
vi.mock("~/database/db.server", () => ({
  db: {
    ioioLabInformation: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    ioioLabInformationSection: {
      findMany: vi.fn(),
      findFirst: sectionDb.findFirst,
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: sectionDb.delete,
    },
    ioioLabTA: {
      findMany: vi.fn(),
    },
    ioioLabInformationImage: {
      findMany: imageDb.findMany,
      update: imageDb.update,
    },
    $transaction: vi.fn((operation) =>
      typeof operation === "function"
        ? operation({ ioioLabInformationImage: imageDb })
        : Promise.all(operation)
    ),
  },
}));

describe("updateLabInformationField", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates only the selected field on an existing Lab Info record", async () => {
    await updateLabInformationField({
      organizationId: "org-1",
      field: "borrowingText",
      value: "  Staff copy  ",
    });

    expect(db.ioioLabInformation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: "org-1" },
        update: { borrowingText: "Staff copy" },
        create: {
          organizationId: "org-1",
          ...DEFAULT_LAB_INFORMATION,
          borrowingText: "Staff copy",
        },
      })
    );
  });

  it("uses the existing default when a section is saved blank", async () => {
    await updateLabInformationField({
      organizationId: "org-1",
      field: "returnText",
      value: "  ",
    });

    expect(db.ioioLabInformation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { returnText: DEFAULT_LAB_INFORMATION.returnText },
      })
    );
  });

  it("creates custom sections after the built-in sections", async () => {
    vi.mocked(db.ioioLabInformationSection.findMany).mockResolvedValueOnce(
      [] as never
    );
    vi.mocked(db.ioioLabInformationSection.create).mockResolvedValueOnce({
      key: "custom_new",
      title: "Safety",
    } as never);

    await createCustomLabInfoSection({
      organizationId: "org-1",
      title: " Safety ",
      content: "Wear eye protection.",
    });

    expect(db.ioioLabInformationSection.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-1",
          title: "Safety",
          content: "Wear eye protection.",
          position: 7,
          isCustom: true,
        }),
      })
    );
  });

  it("rejects an order that moves About away from first", async () => {
    vi.mocked(db.ioioLabInformationSection.findMany).mockResolvedValueOnce(
      [] as never
    );

    await expect(
      reorderLabInfoSections({
        organizationId: "org-1",
        orderedKeys: [
          "borrowing",
          "about",
          "rules",
          "returns",
          "help",
          "opening-hours",
          "lab-tas",
        ],
      })
    ).rejects.toThrow("The Lab Info section order is invalid.");
    expect(db.ioioLabInformationSection.upsert).not.toHaveBeenCalled();
  });

  it("persists the requested order while keeping About first and moving custom sections", async () => {
    vi.mocked(db.ioioLabInformationSection.findMany).mockResolvedValueOnce([
      { key: "custom_safety" },
    ] as never);

    await reorderLabInfoSections({
      organizationId: "org-1",
      orderedKeys: [
        "about",
        "custom_safety",
        "borrowing",
        "rules",
        "returns",
        "help",
        "opening-hours",
        "lab-tas",
      ],
    });

    expect(db.ioioLabInformationSection.update).toHaveBeenCalledWith({
      where: {
        organizationId_key: { organizationId: "org-1", key: "custom_safety" },
      },
      data: { position: 1 },
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it("deletes a custom section by organization and key", async () => {
    sectionDb.findFirst.mockResolvedValueOnce({ id: "section-1", images: [] });
    sectionDb.delete.mockResolvedValueOnce({});

    await deleteCustomLabInfoSection({
      organizationId: "org-1",
      key: "custom_safety",
    });

    expect(sectionDb.findFirst).toHaveBeenCalledWith({
      where: { organizationId: "org-1", key: "custom_safety", isCustom: true },
      select: { id: true, images: { select: { storagePath: true } } },
    });
    expect(sectionDb.delete).toHaveBeenCalledWith({
      where: {
        organizationId_key: { organizationId: "org-1", key: "custom_safety" },
      },
    });
  });

  it("serves Student Lab Information in the saved section order", async () => {
    vi.mocked(db.ioioLabInformation.findUnique).mockResolvedValueOnce(
      null as never
    );
    vi.mocked(db.ioioLabTA.findMany).mockResolvedValueOnce([] as never);
    vi.mocked(db.ioioLabInformationSection.findMany).mockResolvedValueOnce([
      {
        id: "borrowing",
        key: "borrowing",
        title: null,
        content: null,
        position: 3,
        isCustom: false,
        images: [],
      },
      {
        id: "rules",
        key: "rules",
        title: null,
        content: null,
        position: 2,
        isCustom: false,
        images: [],
      },
      {
        id: "about",
        key: "about",
        title: null,
        content: null,
        position: 7,
        isCustom: false,
        images: [],
      },
      {
        id: "custom",
        key: "custom_safety",
        title: "Safety",
        content: "Use care.",
        position: 1,
        isCustom: true,
        images: [],
      },
    ] as never);

    const information = await getLabInformation("org-1");

    expect(information.sections.map(({ key }) => key).slice(0, 3)).toEqual([
      "about",
      "custom_safety",
      "rules",
    ]);
  });
});

describe("updateLabInfoSectionImages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves captions, alt text, and order together for the section images", async () => {
    vi.mocked(db.ioioLabInformationImage.findMany).mockResolvedValueOnce([
      { id: "image-1" },
      { id: "image-2" },
    ] as never);
    vi.mocked(db.ioioLabInformationImage.update).mockResolvedValue({} as never);

    await updateLabInfoSectionImages({
      organizationId: "org-1",
      sectionKey: "about",
      images: [
        { id: "image-2", caption: " Second ", altText: " Second alt " },
        { id: "image-1", caption: "", altText: "First alt" },
      ],
    });

    expect(db.ioioLabInformationImage.update).toHaveBeenNthCalledWith(1, {
      where: { id: "image-2" },
      data: { position: 0, caption: "Second", altText: "Second alt" },
    });
    expect(db.ioioLabInformationImage.update).toHaveBeenNthCalledWith(2, {
      where: { id: "image-1" },
      data: { position: 1, caption: null, altText: "First alt" },
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
  });

  it("rejects stale or cross-section image lists without updating anything", async () => {
    vi.mocked(db.ioioLabInformationImage.findMany).mockResolvedValueOnce([
      { id: "image-1" },
    ] as never);

    await expect(
      updateLabInfoSectionImages({
        organizationId: "org-1",
        sectionKey: "about",
        images: [
          { id: "image-from-another-section", caption: "", altText: "" },
        ],
      })
    ).rejects.toThrow("The image list changed while you were editing.");
    expect(db.ioioLabInformationImage.update).not.toHaveBeenCalled();
  });
});
