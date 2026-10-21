import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireIoioBorrowerAccess: vi.fn(),
  getMyStudentLoans: vi.fn(),
  getWorkingHoursForOrganization: vi.fn(),
  resolveAssetImagesForPresentation: vi.fn(),
  writeOperationFindMany: vi.fn(),
  assetFindMany: vi.fn(),
  locationFindFirst: vi.fn(),
}));

// why: this route test verifies borrower scoping while keeping loan records at
// the existing database/service boundary rather than requiring a live DB.
vi.mock("~/database/db.server", () => ({
  db: {
    ioioWriteOperation: { findMany: mocks.writeOperationFindMany },
    asset: { findMany: mocks.assetFindMany },
    location: { findFirst: mocks.locationFindFirst },
  },
}));
// why: authentication is supplied as an authorized Staff borrower for this
// route-level permission test; role policy is covered by route.server tests.
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireIoioBorrowerAccess: mocks.requireIoioBorrowerAccess,
}));
// why: canonical loan query behavior is tested in service.server.test; this
// test checks that the route passes the signed-in Staff identity to it.
vi.mock("~/modules/ioio-student/service.server", () => ({
  getMyStudentLoans: mocks.getMyStudentLoans,
}));
// why: working hours are unrelated to the role access exercised here.
vi.mock("~/modules/working-hours/service.server", () => ({
  getWorkingHoursForOrganization: mocks.getWorkingHoursForOrganization,
}));
// why: the empty preparation fixture needs no storage resolution in this test.
vi.mock("~/modules/asset/service.server", () => ({
  resolveAssetImagesForPresentation: mocks.resolveAssetImagesForPresentation,
}));
// why: the loans route imports a browser animation used only by its component.
vi.mock("lottie-react", () => ({ default: () => null }));

import { loader } from "~/routes/_layout+/ioio.loans";

describe("Staff personal My Loans route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioBorrowerAccess.mockResolvedValue({
      userId: "staff-1",
      organizationId: "org-1",
      role: "ADMIN",
    });
    mocks.getMyStudentLoans.mockResolvedValue([
      { id: "staff-loan-1", bookingAssets: [{ id: "staff-loan-asset-1" }] },
    ]);
    mocks.getWorkingHoursForOrganization.mockResolvedValue([]);
    mocks.resolveAssetImagesForPresentation.mockResolvedValue([]);
    mocks.writeOperationFindMany.mockResolvedValue([]);
    mocks.assetFindMany.mockResolvedValue([]);
    mocks.locationFindFirst.mockResolvedValue(null);
  });

  it("loads the logged-in Staff user's canonical personal loan records", async () => {
    const result = await loader({
      context: { getSession: () => ({ userId: "staff-1" }) },
      request: new Request("http://localhost/ioio/loans"),
      params: {},
    } as never);

    expect(mocks.requireIoioBorrowerAccess).toHaveBeenCalledOnce();
    expect(mocks.getMyStudentLoans).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "staff-1",
      includePast: true,
    });
    expect(result.data).toMatchObject({
      error: null,
      loans: [{ id: "staff-loan-1" }],
    });
  });
});
