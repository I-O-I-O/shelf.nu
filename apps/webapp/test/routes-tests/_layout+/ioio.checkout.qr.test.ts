import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireStudentRead: vi.fn(),
  assetFindFirst: vi.fn(),
  qrFindFirst: vi.fn(),
  resolvePhysicalUnitNumber: vi.fn(),
}));

// why: this route test exercises its actual QR resolution action while keeping
// persistence inside the isolated service mocks rather than a live database.
vi.mock("~/database/db.server", () => ({
  db: {
    asset: { findFirst: mocks.assetFindFirst },
    qr: { findFirst: mocks.qrFindFirst },
  },
}));
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireStudentRead: mocks.requireStudentRead,
}));
vi.mock("~/modules/ioio-student/borrow-item.server", () => ({
  borrowItem: vi.fn(),
  acknowledgeBorrowItemStaffReservation: vi.fn(),
  cancelBorrowItem: vi.fn(),
  getBorrowItemAvailability: vi.fn(),
  prepareBorrowItem: vi.fn(),
  requestPreparationForItem: vi.fn(),
  resolvePhysicalUnitNumber: mocks.resolvePhysicalUnitNumber,
}));
vi.mock("lottie-react", () => ({ default: () => null }));

import { action } from "~/routes/_layout+/ioio.checkout";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireStudentRead.mockResolvedValue({
    userId: "student-1",
    organizationId: "ioio-dev",
  });
  mocks.assetFindFirst.mockImplementation(({ where }) =>
    Promise.resolve(
      where.id === "logical-makey"
        ? {
            title: "Makey Kit",
            type: "INDIVIDUAL",
            assetModelId: "makey-model",
            assetKits: [],
          }
        : {
            id: "unit-003",
            title: "Makey Kit #003",
            assetModelId: "makey-model",
            assetKits: [],
          }
    )
  );
  mocks.qrFindFirst.mockResolvedValue({ assetId: "unit-003" });
  mocks.resolvePhysicalUnitNumber.mockResolvedValue({
    physicalAssetId: "unit-003",
    title: "Makey Kit #003",
    unitNumber: "003",
    qrId: "vdqo0i7hk9",
  });
});

it.each([
  "http://127.0.0.1:3000/qr/vdqo0i7hk9",
  "http://localhost:3000/qr/vdqo0i7hk9",
  "/qr/vdqo0i7hk9",
])(
  "resolves scanner input to a physical asset in Staff checkout: %s",
  async (value) => {
    const form = new FormData();
    form.set("intent", "resolve-qr");
    form.set("assetId", "logical-makey");
    form.set("candidateAssetIds", "unit-003,unit-004");
    form.set("qrId", value);

    const result = await action({
      context: { getSession: () => ({ userId: "student-1" }) } as never,
      request: new Request("http://localhost/ioio/checkout", {
        method: "POST",
        body: form,
      }),
      params: {},
    } as never);

    expect(result.data).toMatchObject({
      ok: true,
      intent: "qr-resolved",
      unit: {
        id: "unit-003",
        title: "Makey Kit #003",
        unitNumber: "003",
      },
      qrId: "vdqo0i7hk9",
    });
    expect(mocks.qrFindFirst).toHaveBeenCalledWith({
      where: { id: "vdqo0i7hk9", organizationId: "ioio-dev" },
      select: { assetId: true },
    });
    expect(mocks.resolvePhysicalUnitNumber).toHaveBeenCalledWith(
      expect.objectContaining({
        assetId: "logical-makey",
        candidateAssetIds: ["unit-003", "unit-004"],
        unitNumber: "#003",
      }),
      expect.any(Object)
    );
  }
);
