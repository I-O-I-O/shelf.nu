import { fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudentAsset } from "~/modules/ioio-student/service.server";
import IoioReportComplete from "~/routes/_layout+/ioio.report.complete";
import { loader as reportCompletionLoader } from "~/routes/_layout+/ioio.report.complete";

const mocks = vi.hoisted(() => ({
  db: { ioioWriteOperation: { findFirst: vi.fn() } },
  requireStudentRead: vi.fn(),
  getStudentAssets: vi.fn(),
}));

// why: this route test verifies completion copy, organization-scoped report lookup, and optional asset presentation.
vi.mock("~/database/db.server", () => ({ db: mocks.db }));
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireStudentRead: mocks.requireStudentRead,
}));
vi.mock("~/modules/ioio-student/service.server", () => ({
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
      reportType: "ITEM_DAMAGED",
    });
    mocks.getStudentAssets.mockResolvedValue([makeStudentAsset()]);
  });

  it("shows the damaged-item acknowledgement with its logical asset, unit, and image", async () => {
    renderCompletion();

    expect(
      await screen.findByRole("heading", { name: "Makey Kit" })
    ).toBeTruthy();
    expect(screen.getByText("Unit #003")).toBeTruthy();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Thanks for reporting the damaged item. Staff will review it."
    );
    expect(
      screen.getByAltText("Image of Makey Kit #003").getAttribute("src")
    ).toBe("https://images.example.test/makey-003.jpg");
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

  it("shows the location-specific acknowledgement for Wrong location", async () => {
    mocks.db.ioioWriteOperation.findFirst.mockResolvedValue({
      assetId: "unit-003",
      reportType: "WRONG_LOCATION",
    });
    renderCompletion();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Thanks for reporting the location issue. Staff will check it."
    );
    expect(screen.queryByText(/place this item|Broken section/i)).toBeNull();
  });

  it("shows a generic acknowledgement without an empty asset card for general reports", async () => {
    mocks.db.ioioWriteOperation.findFirst.mockResolvedValue({
      assetId: null,
      reportType: "OTHER",
    });
    renderCompletion();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Thanks for your report. Staff will review it."
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

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Thanks for letting Staff know."
    );
    expect(screen.queryByRole("heading", { name: "Makey Kit" })).toBeNull();
  });

  it("Finish returns the Student to /ioio", async () => {
    renderCompletion();
    fireEvent.click(await screen.findByRole("link", { name: "Finish" }));

    expect(await screen.findByText("Student home")).toBeTruthy();
  });
});
