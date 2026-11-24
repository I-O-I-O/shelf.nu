import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const transaction = {
    ioioWriteOperation: {
      findFirst: vi.fn(),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    asset: {
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    kit: { findFirst: vi.fn() },
    teamMember: { findMany: vi.fn() },
    booking: { findFirst: vi.fn() },
    user: { findUniqueOrThrow: vi.fn() },
  };
  return {
    transaction,
    db: {
      ioioWriteOperation: { findUnique: vi.fn() },
      asset: { findFirst: vi.fn() },
      kit: { findFirst: vi.fn() },
      location: { findFirst: vi.fn() },
      teamMember: { findMany: vi.fn() },
      booking: { findFirst: vi.fn() },
      user: { findUniqueOrThrow: vi.fn() },
      $transaction: vi.fn((callback: (tx: typeof transaction) => unknown) =>
        Promise.resolve(callback(transaction))
      ),
    },
    requireStudentRead: vi.fn(),
    enforceReportRateLimit: vi.fn(),
    createReport: vi.fn(),
    getArchivedItemIds: vi.fn().mockResolvedValue([]),
    getStudentKits: vi.fn(),
    getStudentReportLocations: vi.fn(),
  };
});

// why: this test isolates the report transaction and exact-unit availability
// policy; database and report persistence are represented by transaction spies.
vi.mock("~/database/db.server", () => ({ db: mocks.db }));
vi.mock("./route.server", () => ({
  requireStudentRead: mocks.requireStudentRead,
}));
vi.mock("./rate-limit.server", () => ({
  enforceIoioReportRateLimit: mocks.enforceReportRateLimit,
  IOIO_REPORT_OPERATION: "REPORT_PROBLEM",
}));
vi.mock("~/modules/report-found/service.server", () => ({
  createReport: mocks.createReport,
}));
vi.mock("~/modules/ioio-staff/archive.server", () => ({
  getIoioArchivedItemIds: mocks.getArchivedItemIds,
  IOIO_ARCHIVE_ITEM_TYPE: { ASSET: "ASSET", KIT: "KIT" },
}));
vi.mock("~/modules/ioio-student/service.server", () => ({
  getStudentKits: mocks.getStudentKits,
  getStudentReportLocations: mocks.getStudentReportLocations,
}));
vi.mock("~/modules/asset/service.server", () => ({
  resolveAssetImagesForPresentation: vi.fn((assets) => Promise.resolve(assets)),
}));
vi.mock("~/modules/kit/service.server", () => ({
  refreshExpiredKitImages: vi.fn((kits) => Promise.resolve(kits)),
}));
vi.mock("~/modules/kit/ioio-kit-presentation", () => ({
  getIoioKitDisplayName: vi.fn((kit) => kit.name),
}));
vi.mock("~/utils/logger", () => ({ Logger: { info: vi.fn(), warn: vi.fn() } }));

import {
  createBorrowedItemProblemReport,
  prepareReportProblem,
  reportProblem,
} from "./report-problem.server";

describe("IOIO report availability policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireStudentRead.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      role: "SELF_SERVICE",
    });
    mocks.db.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      userId: "student-1",
      organizationId: "team-1",
      status: "PREPARED",
      resultReportId: null,
      source: "IOIO_ASSISTANT",
      createdAt: new Date(),
    });
    mocks.transaction.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      userId: "student-1",
      organizationId: "team-1",
      status: "PROCESSING",
      resultReportId: null,
      source: "IOIO_ASSISTANT",
      assetId: "unit-002",
      kitId: null,
      locationId: null,
    });
    mocks.transaction.asset.findFirst.mockResolvedValue({ id: "unit-002" });
    mocks.transaction.kit.findFirst.mockResolvedValue(null);
    mocks.transaction.teamMember.findMany.mockResolvedValue([]);
    mocks.transaction.booking.findFirst.mockResolvedValue(null);
    mocks.transaction.user.findUniqueOrThrow.mockResolvedValue({
      email: "student@example.test",
    });
    mocks.transaction.ioioWriteOperation.findFirst.mockResolvedValue(null);
    mocks.db.asset.findFirst.mockResolvedValue({
      id: "unit-002",
      title: "Makey Kit #002",
      type: "INDIVIDUAL",
    });
    mocks.db.teamMember.findMany.mockResolvedValue([]);
    mocks.db.booking.findFirst.mockResolvedValue(null);
    mocks.db.kit.findFirst.mockResolvedValue(null);
    mocks.db.location.findFirst.mockResolvedValue(null);
    mocks.db.user.findUniqueOrThrow.mockResolvedValue({
      email: "student@example.test",
    });
    mocks.transaction.user.findUniqueOrThrow.mockResolvedValue({
      email: "student@example.test",
    });
    mocks.createReport.mockResolvedValue({ id: "report-1" });
  });

  it("marks only the reported physical unit unavailable for serious reports", async () => {
    await reportProblem(
      {
        confirmationToken: "token-1",
        reportType: "ITEM_DAMAGED",
        description: "The unit casing is cracked.",
      },
      {
        context: {} as never,
        request: new Request("http://localhost/ioio/ask"),
      }
    );

    expect(mocks.transaction.asset.update).toHaveBeenCalledWith({
      where: { id: "unit-002", organizationId: "team-1" },
      data: { availableToBook: false },
    });
  });

  it("leaves a healthy unit borrowable for a wrong-location report", async () => {
    await reportProblem(
      {
        confirmationToken: "token-1",
        reportType: "WRONG_LOCATION",
        description: "It is stored on Shelf A1.",
      },
      {
        context: {} as never,
        request: new Request("http://localhost/ioio/ask"),
      }
    );

    expect(mocks.transaction.asset.update).not.toHaveBeenCalled();
  });

  it("does not lock or disable a representative unit when no exact unit was reported", async () => {
    mocks.transaction.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "operation-1",
      userId: "student-1",
      organizationId: "team-1",
      status: "PROCESSING",
      resultReportId: null,
      source: "IOIO_STUDENT_REPORT",
      assetId: null,
      kitId: null,
      locationId: null,
    });

    await reportProblem(
      {
        confirmationToken: "token-1",
        reportType: "CANNOT_FIND",
        description: "Makey Kit (exact unit not specified): Cannot find it.",
      },
      {
        context: {} as never,
        request: new Request("http://localhost/ioio/report"),
      }
    );

    expect(mocks.transaction.asset.update).not.toHaveBeenCalled();
  });

  it("persists product-level Kit incomplete on the kit without attaching or blocking a unit", async () => {
    mocks.transaction.ioioWriteOperation.findUnique.mockResolvedValue({
      id: "operation-kit",
      userId: "student-1",
      organizationId: "team-1",
      status: "PROCESSING",
      resultReportId: null,
      source: "IOIO_STUDENT_REPORT",
      assetId: null,
      kitId: "grove-kit",
      locationId: null,
    });
    mocks.transaction.asset.findFirst.mockResolvedValue(null);
    mocks.transaction.kit.findFirst.mockResolvedValue({ id: "grove-kit" });

    await reportProblem(
      {
        confirmationToken: "token-kit",
        reportType: "KIT_INCOMPLETE",
        description: "One sensor is missing.",
      },
      {
        context: {} as never,
        request: new Request("http://localhost/ioio/report"),
      }
    );

    expect(mocks.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        kitId: "grove-kit",
        assetId: undefined,
      })
    );
    expect(mocks.transaction.asset.update).not.toHaveBeenCalled();
  });

  it("retains the exact borrowed unit and kit when a loan-context kit report is known", async () => {
    const checkedOutAt = new Date("2026-10-01T10:00:00Z");
    mocks.db.teamMember.findMany.mockResolvedValue([{ id: "member-1" }]);
    mocks.db.booking.findFirst.mockResolvedValue({
      from: checkedOutAt,
      to: new Date("2026-10-15T10:00:00Z"),
      bookingAssets: [
        {
          id: "booking-asset-1",
          bookingId: "booking-1",
          quantity: 1,
          checkedOutAt,
          sourceKitId: "grove-kit",
          asset: {
            id: "unit-003",
            title: "Grove Kit #003",
            type: "INDIVIDUAL",
            sequentialId: "003",
            mainImage: null,
            thumbnailImage: null,
            mainImageStoragePath: null,
            thumbnailImageStoragePath: null,
            assetModel: null,
            assetKits: [],
          },
        },
      ],
    });
    mocks.db.kit.findFirst.mockResolvedValue({
      id: "grove-kit",
      name: "Grove Kit",
      image: null,
      imageExpiration: null,
      imageStoragePath: null,
      organizationId: "team-1",
    });

    await createBorrowedItemProblemReport(
      {
        bookingId: "booking-1",
        bookingAssetId: "booking-asset-1",
        assetId: "unit-003",
        reportType: "KIT_INCOMPLETE",
        description: "One sensor is missing.",
      },
      {
        context: {} as never,
        request: new Request("http://localhost/ioio/report"),
      },
      { source: "IOIO_STUDENT_REPORT" }
    );

    expect(mocks.createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "unit-003",
        kitId: "grove-kit",
      })
    );
    expect(mocks.transaction.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assetId: "unit-003",
          kitId: "grove-kit",
          bookingId: "booking-1",
          bookingAssetId: "booking-asset-1",
          reportType: "KIT_INCOMPLETE",
        }),
      })
    );
    expect(mocks.transaction.asset.update).toHaveBeenCalledWith({
      where: { id: "unit-003", organizationId: "team-1" },
      data: { availableToBook: false },
    });
  });

  it("requires a native kit for a product-level Kit incomplete proposal", async () => {
    await expect(
      prepareReportProblem(
        {
          report_type: "KIT_INCOMPLETE",
          asset_id: "unit-002",
          description: "One sensor is missing.",
        },
        {
          context: {} as never,
          request: new Request("http://localhost/ioio/report"),
        }
      )
    ).rejects.toThrow("Choose the kit this report is about.");
    expect(mocks.transaction.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("accepts an active native kit and stores no physical asset on its proposal", async () => {
    mocks.db.kit.findFirst.mockResolvedValue({
      id: "grove-kit",
      name: "Grove Kit",
    });
    mocks.getStudentKits.mockResolvedValue([{ id: "grove-kit" }]);

    await prepareReportProblem(
      {
        report_type: "KIT_INCOMPLETE",
        kit_id: "grove-kit",
        description: "One sensor is missing.",
      },
      {
        context: {} as never,
        request: new Request("http://localhost/ioio/report"),
      },
      { source: "IOIO_STUDENT_REPORT" }
    );

    expect(mocks.transaction.ioioWriteOperation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reportType: "KIT_INCOMPLETE",
          assetId: null,
          kitId: "grove-kit",
        }),
      })
    );
  });

  it("rejects an archived kit from a product-level Kit incomplete proposal", async () => {
    mocks.db.kit.findFirst.mockResolvedValue({
      id: "archived-kit",
      name: "Old Grove Kit",
    });
    mocks.getStudentKits.mockResolvedValue([]);
    mocks.getArchivedItemIds.mockResolvedValue(["archived-kit"]);

    await expect(
      prepareReportProblem(
        {
          report_type: "KIT_INCOMPLETE",
          kit_id: "archived-kit",
          description: "One sensor is missing.",
        },
        {
          context: {} as never,
          request: new Request("http://localhost/ioio/report"),
        }
      )
    ).rejects.toThrow("The selected Shelf kit is no longer available.");
    expect(mocks.transaction.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("rejects a non-kit product ID supplied as Kit incomplete context", async () => {
    await expect(
      prepareReportProblem(
        {
          report_type: "KIT_INCOMPLETE",
          kit_id: "asset-record-id",
          description: "One sensor is missing.",
        },
        {
          context: {} as never,
          request: new Request("http://localhost/ioio/report"),
        }
      )
    ).rejects.toThrow("The selected Shelf kit is not in this workspace.");
    expect(mocks.transaction.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("rejects a location that is no longer in the active student location tree", async () => {
    mocks.db.location.findFirst.mockResolvedValue({
      id: "old-location",
      name: "Old Shelf",
    });
    mocks.getStudentReportLocations.mockResolvedValue([]);

    await expect(
      prepareReportProblem(
        {
          report_type: "LOCATION_FULL",
          location_id: "old-location",
          description: "This shelf can no longer be used.",
        },
        {
          context: {} as never,
          request: new Request("http://localhost/ioio/report"),
        }
      )
    ).rejects.toThrow("The selected Shelf location is no longer available.");
    expect(mocks.transaction.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("rejects a location ID removed from Shelf before preparing a new report", async () => {
    mocks.db.location.findFirst.mockResolvedValue(null);

    await expect(
      prepareReportProblem(
        {
          report_type: "LOCATION_FULL",
          location_id: "deleted-location",
          description: "This location no longer exists.",
        },
        {
          context: {} as never,
          request: new Request("http://localhost/ioio/report"),
        }
      )
    ).rejects.toThrow("The selected Shelf location is not in this workspace.");
    expect(mocks.getStudentReportLocations).not.toHaveBeenCalled();
    expect(mocks.transaction.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("rejects a second unresolved report for the same exact unit", async () => {
    mocks.transaction.ioioWriteOperation.findFirst.mockResolvedValue({
      id: "existing-report",
    });

    await expect(
      prepareReportProblem(
        {
          report_type: "ITEM_DAMAGED",
          asset_id: "unit-002",
          description: "The casing is cracked.",
        },
        {
          context: {} as never,
          request: new Request("http://localhost/ioio/report"),
        },
        { source: "IOIO_STUDENT_REPORT" }
      )
    ).rejects.toThrow(
      "This unit has already been reported and is waiting for Staff review."
    );

    expect(mocks.transaction.ioioWriteOperation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "team-1",
          assetId: "unit-002",
          status: { in: ["SUCCEEDED", "PROCESSING"] },
        }),
      })
    );
    expect(mocks.transaction.ioioWriteOperation.create).not.toHaveBeenCalled();
  });

  it("replays an active-loan report with the same token without creating another report", async () => {
    mocks.db.ioioWriteOperation.findUnique.mockResolvedValue({
      userId: "student-1",
      organizationId: "team-1",
      operationType: "REPORT_PROBLEM",
      source: "IOIO_STUDENT_REPORT",
      status: "SUCCEEDED",
      reportType: "ITEM_DAMAGED",
      description: "The casing is cracked.",
      assetId: "unit-003",
      bookingId: "booking-1",
      bookingAssetId: "booking-asset-1",
      resultReportId: "report-existing",
    });

    const result = await createBorrowedItemProblemReport(
      {
        bookingId: "booking-1",
        bookingAssetId: "booking-asset-1",
        assetId: "unit-003",
        reportType: "ITEM_DAMAGED",
        description: "The casing is cracked.",
      },
      {
        context: {} as never,
        request: new Request("http://localhost/ioio/report"),
      },
      {
        source: "IOIO_STUDENT_REPORT",
        submissionToken: "123e4567-e89b-42d3-a456-426614174000",
      }
    );

    expect(result).toMatchObject({
      ok: true,
      reportId: "report-existing",
    });
    expect(mocks.db.ioioWriteOperation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { idempotencyKey: "123e4567-e89b-42d3-a456-426614174000" },
      })
    );
    expect(mocks.db.$transaction).not.toHaveBeenCalled();
    expect(mocks.createReport).not.toHaveBeenCalled();
  });
});
