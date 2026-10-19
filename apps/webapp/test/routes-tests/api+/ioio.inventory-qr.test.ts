// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "~/database/db.server";
import {
  getStudentAssets,
  getStudentKits,
  getStudentLocations,
} from "~/modules/ioio-student/service.server";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";
import { loader } from "~/routes/api+/ioio.inventory-qr";

// why: exercise the resolver's permission and organization scoping without connecting to a live database.
vi.mock("~/database/db.server", () => ({
  db: {
    qr: { findFirst: vi.fn() },
    asset: { findFirst: vi.fn() },
    kit: { findFirst: vi.fn() },
    location: { findFirst: vi.fn() },
  },
}));
// why: student catalog services have image and availability dependencies; the route test only needs their visibility result.
vi.mock("~/modules/ioio-student/service.server", () => ({
  getStudentAssets: vi.fn(),
  getStudentKits: vi.fn(),
  getStudentLocations: vi.fn(),
}));
// why: use controlled auth scopes to verify that scan resolution is permission-bound.
vi.mock("~/modules/ioio-student/route.server", () => ({
  requireStudentRead: vi.fn(),
}));
vi.mock("~/utils/roles.server", () => ({ requirePermission: vi.fn() }));

const locationTree = [
  {
    id: "room",
    name: "IOIO Lab - B477",
    parentId: null,
    children: [
      {
        id: "section-c",
        name: "Section C",
        parentId: "room",
        children: [
          {
            id: "container-4",
            name: "Container 4",
            parentId: "section-c",
            children: [],
            assetCount: 0,
            imageUrl: null,
            thumbnailUrl: null,
          },
        ],
        assetCount: 0,
        imageUrl: null,
        thumbnailUrl: null,
      },
    ],
    assetCount: 0,
    imageUrl: null,
    thumbnailUrl: null,
  },
];

function args(value: string, audience: "student" | "staff" = "student") {
  return {
    request: new Request(
      `http://localhost:3000/api/ioio/inventory-qr?${new URLSearchParams({
        value,
        audience,
      })}`
    ),
    context: { getSession: () => ({ userId: "user-1" }) },
  } as never;
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("IOIO inventory QR resolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireStudentRead).mockResolvedValue({
      organizationId: "org-1",
      userId: "student-1",
    } as never);
    vi.mocked(requirePermission).mockResolvedValue({
      organizationId: "org-1",
    } as never);
    vi.mocked(getStudentLocations).mockResolvedValue(locationTree as never);
  });

  it("resolves a student-visible asset QR to the existing student asset route", async () => {
    vi.mocked(db.qr.findFirst).mockResolvedValue({
      assetId: "asset-1",
      kitId: null,
    } as never);
    vi.mocked(getStudentAssets).mockResolvedValue([{ id: "asset-1" }] as never);

    const response = await loader(args("https://shelf.nu/qr/cmv1234567"));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      destination: "/ioio/browse/asset-1",
    });
  });

  it("blocks a student when the scanned asset is outside their visible inventory", async () => {
    vi.mocked(db.qr.findFirst).mockResolvedValue({
      assetId: "hidden-asset",
      kitId: null,
    } as never);
    vi.mocked(getStudentAssets).mockResolvedValue([] as never);

    const response = await loader(args("cmv1234567"));

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({
      error: "This item is not available to your account.",
    });
  });

  it("resolves a student-visible Shelf kit QR to the existing student kit list", async () => {
    vi.mocked(db.qr.findFirst).mockResolvedValue({
      assetId: null,
      kitId: "kit-1",
    } as never);
    vi.mocked(getStudentKits).mockResolvedValue([{ id: "kit-1" }] as never);

    const response = await loader(args("cmv1234567"));

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      destination: "/ioio/kits?kit=kit-1",
    });
  });

  it("accepts an accessible nested student location and keeps the current filter route", async () => {
    const response = await loader(
      args("https://shelf.nu/ioio/browse?location=container-4")
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      destination: "/ioio/browse?location=container-4",
    });
  });

  it("rejects a missing Shelf QR and an unsupported payload", async () => {
    vi.mocked(db.qr.findFirst).mockResolvedValue(null);
    const missing = await loader(args("cmv1234567"));
    expect(missing.status).toBe(404);

    const invalid = await loader(args("not-a-qr"));
    expect(invalid.status).toBe(400);

    vi.mocked(getStudentLocations).mockResolvedValue([] as never);
    const missingLocation = await loader(
      args("https://shelf.nu/ioio/browse?location=missing-location")
    );
    expect(missingLocation.status).toBe(404);
  });

  it("uses Staff asset permissions and the existing staff asset detail route", async () => {
    vi.mocked(db.qr.findFirst).mockResolvedValue({
      assetId: "asset-1",
      kitId: null,
    } as never);
    vi.mocked(db.asset.findFirst).mockResolvedValue({ id: "asset-1" } as never);

    const response = await loader(
      args("https://shelf.nu/qr/cmv1234567", "staff")
    );

    expect(requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        entity: PermissionEntity.asset,
        action: PermissionAction.read,
      })
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      destination: "/assets/asset-1/overview",
    });
    expect(getStudentAssets).not.toHaveBeenCalled();
  });
});
