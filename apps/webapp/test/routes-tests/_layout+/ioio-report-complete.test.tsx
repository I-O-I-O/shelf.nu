import { fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ASSET_IMAGE_PLACEHOLDER } from "~/modules/asset/image-resolution";
import type { StudentAsset } from "~/modules/ioio-student/service.server";
import IoioReportComplete from "~/routes/_layout+/ioio.report.complete";
import { loader as reportCompletionLoader } from "~/routes/_layout+/ioio.report.complete";

const mocks = vi.hoisted(() => ({
  db: {
    ioioWriteOperation: { findFirst: vi.fn() },
    location: { findMany: vi.fn() },
  },
  requireStudentRead: vi.fn(),
  getStudentAssets: vi.fn(),
  formatStudentLocationPath: vi.fn(),
}));

// why: this route test verifies completion copy, organization-scoped report lookup, and optional asset presentation.
vi.mock("~/database/db.server", () => ({ db: mocks.db }));
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireStudentRead: mocks.requireStudentRead,
}));
vi.mock("~/modules/ioio-student/service.server", () => ({
  formatStudentLocationPath: mocks.formatStudentLocationPath,
  getStudentAssets: mocks.getStudentAssets,
}));

function makeStudentAsset(overrides: Partial<StudentAsset> = {}): StudentAsset {
  return {
    id: "unit-003",
    title: "Makey Kit #003",
    description: null,
    mainImage: "https://images.example.test/makey-003.jpg",
    mainImageExpiration: null,
    thumbnailImage: null,
    assetModel: {
      id: "makey-model",
      name: "Makey Kit",
      image: null,
      thumbnailImage: null,
    },
    status: "AVAILABLE",
    type: "INDIVIDUAL",
    quantity: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    assetModelId: "makey-model",
    availableQuantity: 0,
    availableToBook: false,
    sequentialId: "003",
    category: null,
    locations: [],
    kits: [],
    qrIds: [],
    kitImage: null,
    ...overrides,
  };
}

function renderCompletion() {
  const Stub = createRoutesStub([
    {
      path: "/ioio/report/complete",
      Component: IoioReportComplete,
      loader: reportCompletionLoader,
      HydrateFallback: () => null,
    },
    {
      path: "/ioio",
      Component: () => <div>Student home</div>,
    },
  ]);
  return render(
    <Stub initialEntries={["/ioio/report/complete?reportId=report-1"]} />
  );
}

function getReportedUnitLabel() {
  return screen.getByText(
    (_content, element) =>
      element?.tagName === "P" && element.textContent?.trim() === "Unit #003"
  );
}

function expectSuccessAcknowledgement(message: string) {
  const status = screen.getByRole("status");
  expect(status).toHaveClass("border-green-200", "bg-green-50");
  expect(status).not.toHaveClass("bg-red-50", "text-red-900");
  expect(
    screen.getByRole("heading", { level: 1, name: "Report sent" })
  ).toHaveClass("text-green-950");
  expect(status).toHaveTextContent(message);
}

describe("IOIO Student report completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    mocks.db.ioioWriteOperation.findFirst.mockResolvedValue({
      assetId: "unit-003",
      locationId: null,
      reportType: "ITEM_DAMAGED",
    });
    mocks.db.location.findMany.mockResolvedValue([]);
    mocks.formatStudentLocationPath.mockImplementation(
      (
        locationId: string,
        locations: Array<{ id: string; name: string; parentId: string | null }>
      ) => {
        const byId = new Map(
          locations.map((location) => [location.id, location])
        );
        const path: string[] = [];
        let currentId: string | null = locationId;
        while (currentId) {
          const location = byId.get(currentId);
          if (!location) break;
          path.unshift(location.name);
          currentId = location.parentId;
        }
        return path;
      }
    );
    mocks.getStudentAssets.mockResolvedValue([makeStudentAsset()]);
  });

  it("shows the damaged-item acknowledgement with its logical asset, unit, and image", async () => {
    renderCompletion();

    expect(
      await screen.findByRole("heading", { name: "Makey Kit" })
    ).toBeTruthy();
    expect(getReportedUnitLabel()).toBeTruthy();
    expectSuccessAcknowledgement(
      "Thanks for reporting the damaged item. Staff will review it."
    );
    const assetImage = screen.getByAltText("Image of Makey Kit #003");
    expect(assetImage.getAttribute("src")).toBe(
      "https://images.example.test/makey-003.jpg"
    );
    expect(assetImage.className).toContain("object-contain");
    expect(assetImage.className).toContain("size-auto");
    expect(assetImage.className).toContain("max-h-full");
    expect(assetImage.className).toContain("max-w-full");
    expect(assetImage.className).not.toContain("size-full");
    expect(assetImage.className).not.toContain("object-cover");
    const imagePanel = screen.getByRole("group", {
      name: "Asset image preview",
    });
    expect(imagePanel.className).toContain("max-w-[26rem]");
    expect(imagePanel.className).toContain("clamp(13rem,32vh,19rem)");
    expect(imagePanel.className).toContain("overflow-hidden");
    expect(
      screen.queryByText(/Broken section|Return section|Take this item/i)
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Finish" })).toBeTruthy();
    expect(mocks.db.ioioWriteOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "student-1",
          organizationId: "team-1",
          resultReportId: "report-1",
        }),
      })
    );
  });

  it.each([
    ["landscape", "https://images.example.test/landscape.jpg"],
    ["portrait", "https://images.example.test/portrait.jpg"],
    ["square", "https://images.example.test/square.jpg"],
  ])(
    "keeps the full %s asset image inside the responsive preview",
    async (_, imageUrl) => {
      mocks.getStudentAssets.mockResolvedValue([
        makeStudentAsset({ mainImage: imageUrl }),
      ]);
      renderCompletion();

      const image = await screen.findByAltText("Image of Makey Kit #003");
      expect(image.getAttribute("src")).toBe(imageUrl);
      expect(image.className).toContain("object-contain");
      expect(image.className).not.toContain("object-cover");
      expect(
        screen.getByRole("group", { name: "Asset image preview" }).className
      ).toContain("w-full");
    }
  );

  it("uses the standard contained asset placeholder when no image is uploaded", async () => {
    mocks.getStudentAssets.mockResolvedValue([
      makeStudentAsset({
        mainImage: null,
        assetModel: {
          id: "makey-model",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
      }),
    ]);
    renderCompletion();

    const image = await screen.findByAltText("Image of Makey Kit #003");
    expect(image.getAttribute("src")).toBe(ASSET_IMAGE_PLACEHOLDER);
    expect(image.className).toContain("object-contain");
    expect(getReportedUnitLabel()).toBeTruthy();
  });

  it("keeps the historical reported location visible for Wrong location", async () => {
    mocks.db.ioioWriteOperation.findFirst.mockResolvedValue({
      assetId: "unit-003",
      locationId: "container-13",
      reportType: "WRONG_LOCATION",
    });
    mocks.db.location.findMany.mockResolvedValue([
      { id: "room", name: "IOIO Lab - B477", parentId: null },
      { id: "section-a", name: "Section A", parentId: "room" },
      { id: "shelf-a1", name: "Shelf A1", parentId: "section-a" },
      {
        id: "container-13",
        name: "Container A1-13",
        parentId: "shelf-a1",
      },
    ]);
    renderCompletion();

    expect(
      await screen.findByRole("heading", { name: "Makey Kit" })
    ).toBeTruthy();
    expect(getReportedUnitLabel()).toBeTruthy();
    expect(screen.getByText("Reported location")).toBeTruthy();
    // This is the location recorded with the report, not the item's current
    // inventory location; keep the report's historical context intact.
    expect(screen.getByText("IOIO Lab - B477 · Container A1-13")).toBeTruthy();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Thanks for reporting the location issue. Staff will review it."
    );
    expectSuccessAcknowledgement(
      "Thanks for reporting the location issue. Staff will review it."
    );
    expect(
      screen.queryByText(/Section A|Shelf A1|place this item|Broken section/i)
    ).toBeNull();
    expect(mocks.db.location.findMany).toHaveBeenCalledWith({
      where: { organizationId: "team-1" },
      select: { id: true, name: true, parentId: true },
    });
  });

  it("shows an associated item for Can't find item without an exact unit", async () => {
    mocks.db.ioioWriteOperation.findFirst.mockResolvedValue({
      assetId: "makey-product",
      locationId: null,
      reportType: "CANNOT_FIND",
    });
    mocks.getStudentAssets.mockResolvedValue([
      makeStudentAsset({
        id: "makey-product",
        title: "Makey Kit",
        type: "CONSUMABLE",
        mainImage: "https://images.example.test/makey.jpg",
        sequentialId: null,
      }),
    ]);
    renderCompletion();

    expect(
      await screen.findByRole("heading", { name: "Makey Kit" })
    ).toBeTruthy();
    expect(screen.queryByText(/exact unit not specified/i)).toBeNull();
    expect(screen.getByAltText("Image of Makey Kit").getAttribute("src")).toBe(
      "https://images.example.test/makey.jpg"
    );
    expectSuccessAcknowledgement(
      "Thanks for letting us know. Staff will help check where this item is."
    );
  });

  it("shows a location-only card for Location full without an asset image", async () => {
    mocks.db.ioioWriteOperation.findFirst.mockResolvedValue({
      assetId: null,
      locationId: "shelf-a1",
      reportType: "LOCATION_FULL",
    });
    mocks.db.location.findMany.mockResolvedValue([
      { id: "room", name: "IOIO Lab - B477", parentId: null },
      { id: "section-a", name: "Section A", parentId: "room" },
      { id: "shelf-a1", name: "Shelf A1", parentId: "section-a" },
    ]);
    renderCompletion();

    expect(await screen.findByText("Location full")).toBeTruthy();
    expect(screen.getByText("IOIO Lab - B477 · Shelf A1")).toBeTruthy();
    expect(screen.queryByAltText(/Image of/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "Makey Kit" })).toBeNull();
    expect(mocks.getStudentAssets).not.toHaveBeenCalled();
  });

  it("shows a generic acknowledgement without an empty asset card for general reports", async () => {
    mocks.db.ioioWriteOperation.findFirst.mockResolvedValue({
      assetId: null,
      reportType: "OTHER",
    });
    renderCompletion();

    await screen.findByRole("status");
    expectSuccessAcknowledgement(
      "Thanks for letting us know. Staff will review your report."
    );
    expect(screen.queryByRole("heading", { name: "Makey Kit" })).toBeNull();
    expect(screen.queryByAltText(/Image of/)).toBeNull();
    expect(mocks.getStudentAssets).not.toHaveBeenCalled();
  });

  it("continues to display acknowledgements for historical Found something reports", async () => {
    mocks.db.ioioWriteOperation.findFirst.mockResolvedValue({
      assetId: null,
      reportType: "FOUND_SOMETHING",
    });
    renderCompletion();

    await screen.findByRole("status");
    expectSuccessAcknowledgement("Thanks for letting Staff know.");
    expect(screen.queryByRole("heading", { name: "Makey Kit" })).toBeNull();
  });

  it.each([
    [
      "ITEM_MISSING",
      "Thanks for reporting the missing item. Staff will look into it.",
    ],
    [
      "ITEM_NOT_WORKING",
      "Thanks for reporting the item that is not working. Staff will review it.",
    ],
    [
      "PART_MISSING",
      "Thanks for reporting the missing part. Staff will review it.",
    ],
    [
      "WRONG_LOCATION",
      "Thanks for reporting the location issue. Staff will review it.",
    ],
    ["LOCATION_FULL", "Thanks for reporting the full location."],
    [
      "CANNOT_FIND",
      "Thanks for letting us know. Staff will help check where this item is.",
    ],
    [
      "KIT_INCOMPLETE",
      "Thanks for reporting the incomplete kit. Staff will review it.",
    ],
    ["FOUND_SOMETHING", "Thanks for letting Staff know."],
    ["OTHER", "Thanks for letting us know. Staff will review your report."],
  ] as const)(
    "styles %s acknowledgements as success",
    async (reportType, message) => {
      mocks.db.ioioWriteOperation.findFirst.mockResolvedValue({
        assetId: null,
        locationId: null,
        reportType,
      });
      renderCompletion();

      await screen.findByRole("status");
      expectSuccessAcknowledgement(message);
    }
  );

  it("Finish returns the Student to /ioio", async () => {
    renderCompletion();
    fireEvent.click(await screen.findByRole("link", { name: "Finish" }));

    expect(await screen.findByText("Student home")).toBeTruthy();
  });

  it("redirects when a reportId is not owned by this Student", async () => {
    mocks.db.ioioWriteOperation.findFirst.mockResolvedValue(null);
    renderCompletion();

    expect(await screen.findByText("Student home")).toBeTruthy();
    expect(mocks.getStudentAssets).not.toHaveBeenCalled();
    expect(mocks.db.ioioWriteOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "student-1",
          organizationId: "team-1",
          resultReportId: "report-1",
          source: "IOIO_STUDENT_REPORT",
          status: "SUCCEEDED",
        }),
      })
    );
  });

  it("falls back to Shelf's asset placeholder when the associated asset has no image", async () => {
    mocks.getStudentAssets.mockResolvedValue([
      makeStudentAsset({
        mainImage: null,
        assetModel: {
          id: "makey-model",
          name: "Makey Kit",
          image: null,
          thumbnailImage: null,
        },
      }),
    ]);
    renderCompletion();

    const image = await screen.findByAltText("Image of Makey Kit #003");
    expect(image.getAttribute("src")).toBe(
      "/static/images/asset-placeholder.jpg"
    );
  });
});
