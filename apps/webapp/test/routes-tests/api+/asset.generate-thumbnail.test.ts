// @vitest-environment node
import { loader } from "~/routes/api+/asset.generate-thumbnail";

const createDataMock = vi.hoisted(() =>
  vi.fn(
    (body: unknown) =>
      new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      })
  )
);
const mockFindUnique = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockCreateSignedUrl = vi.hoisted(() => vi.fn());
const mockUploadFile = vi.hoisted(() => vi.fn());
const mockRequirePermission = vi.hoisted(() => vi.fn());
const mockDownload = vi.hoisted(() => vi.fn());

// why: use a Response-shaped data() result so the route contract can be read
// without starting a React Router server.
vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return { ...actual, data: createDataMock };
});

// why: database reads/writes are the route boundary; no DEV database is used.
vi.mock("~/database/db.server", () => ({
  db: { asset: { findUnique: mockFindUnique, update: mockUpdate } },
}));

// why: storage operations are external; deterministic storage responses prove
// the route resolves and saves the canonical object paths.
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: () => ({
    storage: { from: () => ({ download: mockDownload }) },
  }),
}));
vi.mock("~/utils/storage.server", () => ({
  createSignedUrl: mockCreateSignedUrl,
  getThumbnailStoragePath: (path: string) =>
    path.replace(".jpg", "-thumbnail.jpg"),
  uploadFile: mockUploadFile,
}));

// why: permission is external to this route behavior and must remain required.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mockRequirePermission,
}));

describe("asset thumbnail generation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequirePermission.mockResolvedValue({ organizationId: "org-1" });
    mockFindUnique
      .mockResolvedValueOnce({
        id: "asset-1",
        mainImage: null,
        thumbnailImage: null,
        mainImageStoragePath: "user-1/asset-1/main.jpg",
        thumbnailImageStoragePath: null,
        organizationId: "org-1",
      })
      .mockResolvedValueOnce({ id: "asset-1" });
    mockDownload.mockResolvedValue({
      data: new Blob(["image-bytes"], { type: "image/jpeg" }),
      error: null,
    });
    mockUploadFile.mockResolvedValue("user-1/asset-1/main-thumbnail.jpg");
    mockCreateSignedUrl.mockResolvedValue(
      "https://storage.example/assets/user-1/asset-1/main-thumbnail.jpg"
    );
    mockUpdate.mockResolvedValue({
      id: "asset-1",
      thumbnailImage:
        "https://storage.example/assets/user-1/asset-1/main-thumbnail.jpg",
    });
  });

  it("generates and persists a thumbnail from the canonical main-image path", async () => {
    const request = new Request(
      "https://app.example/api/asset/generate-thumbnail?assetId=asset-1"
    );
    const result = await loader({
      request,
      context: { getSession: () => ({ userId: "user-1" }) },
      params: {},
    } as never);
    if (!(result instanceof Response)) {
      throw new Error("The thumbnail route should return a response");
    }

    expect(mockDownload).toHaveBeenCalledWith("user-1/asset-1/main.jpg");
    expect(mockUploadFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filename: "user-1/asset-1/main-thumbnail.jpg",
        bucketName: "assets",
      })
    );
    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "asset-1", organizationId: "org-1" },
        data: expect.objectContaining({
          thumbnailImageStoragePath: "user-1/asset-1/main-thumbnail.jpg",
        }),
      })
    );
    const body = await result.json();
    expect(body.asset.thumbnailImage).toBe(
      "https://storage.example/assets/user-1/asset-1/main-thumbnail.jpg"
    );
  });
});
