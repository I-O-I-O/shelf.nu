import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAccess: vi.fn(),
  download: vi.fn(),
  from: vi.fn(),
  findFirst: vi.fn(),
}));

// why: authentication needs a real Shelf session; exercise the route with staff
// and student authorization results and rejected sessions.
vi.mock("~/modules/ioio-handbook/access.server", () => ({
  requireIoioHandbookRead: mocks.requireAccess,
}));
// why: Supabase is external storage; return image objects without network calls.
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: () => ({ storage: { from: mocks.from } }),
}));
// why: staff-only references require a database; supply query results in isolation.
vi.mock("~/database/db.server", () => ({
  db: { handbookArticle: { findFirst: mocks.findFirst } },
}));

import { loader } from "~/routes/api+/handbook-image";
import { PUBLIC_BUCKET } from "~/utils/constants";

const path = "handbook/org-1/123e4567-e89b-12d3-a456-426614174000.png";
const url = `https://app.example/api/handbook-image?path=${encodeURIComponent(
  path
)}`;
function args(imageUrl = url) {
  return {
    context: { getSession: () => ({ userId: "user-1" }) },
    request: new Request(imageUrl),
  } as never;
}

describe("Handbook image read route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAccess.mockResolvedValue({
      organizationId: "org-1",
      canEdit: true,
    });
    mocks.from.mockReturnValue({ download: mocks.download });
    mocks.findFirst.mockResolvedValue(null);
    mocks.download.mockResolvedValue({
      data: new Blob([new Uint8Array([137, 80, 78, 71])], {
        type: "image/png",
      }),
      error: null,
    });
  });

  it.each([true, false])(
    "returns image bytes on the same origin (staff=%s)",
    async (canEdit) => {
      mocks.requireAccess.mockResolvedValue({
        organizationId: "org-1",
        canEdit,
      });
      const response = await loader(args());
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("image/png");
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Location")).toBeNull();
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
        137, 80, 78, 71,
      ]);
      expect(mocks.from).toHaveBeenCalledWith(PUBLIC_BUCKET);
      expect(mocks.download).toHaveBeenCalledWith(path);
    }
  );

  it.each([
    "",
    "handbook/org-1/../../secret.png",
    "handbook/org-1/invalid.png",
  ])("rejects malformed paths: %s", async (invalidPath) => {
    await expect(
      loader(
        args(
          `https://app.example/api/handbook-image?path=${encodeURIComponent(
            invalidPath
          )}`
        )
      )
    ).rejects.toMatchObject({ init: { status: 400 } });
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("denies another organization before accessing storage", async () => {
    mocks.requireAccess.mockResolvedValue({
      organizationId: "org-2",
      canEdit: true,
    });
    await expect(loader(args())).rejects.toMatchObject({
      init: { status: 404 },
    });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("requires authentication before accessing storage", async () => {
    const denied = new Response(null, { status: 401 });
    mocks.requireAccess.mockRejectedValue(denied);
    await expect(loader(args())).rejects.toBe(denied);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("denies students access to staff-only image references", async () => {
    mocks.requireAccess.mockResolvedValue({
      organizationId: "org-1",
      canEdit: false,
    });
    mocks.findFirst.mockResolvedValue({ id: "staff-article" });
    await expect(loader(args())).rejects.toMatchObject({
      init: { status: 404 },
    });
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          staffOnly: true,
        }),
      })
    );
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns 404 for missing storage objects", async () => {
    mocks.download.mockResolvedValue({
      data: null,
      error: { message: "Not found" },
    });
    await expect(loader(args())).rejects.toMatchObject({
      init: { status: 404 },
    });
  });
});
