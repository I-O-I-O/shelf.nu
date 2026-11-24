// @vitest-environment node
import { loader } from "~/routes/api+/asset.refresh-main-image";

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
const mockRequirePermission = vi.hoisted(() => vi.fn());

// why: use a Response-shaped data() result so the route contract can be read
// without starting a React Router server.
vi.mock("react-router", async () => {
  const actual = await vi.importActual("react-router");
  return { ...actual, data: createDataMock };
});

// why: the route is exercised at its database boundary, without a DEV database.
vi.mock("~/database/db.server", () => ({
  db: { asset: { findUnique: mockFindUnique, update: mockUpdate } },
}));

// why: signed URL creation is the external storage boundary; return deterministic
// URLs to verify canonical Storage paths are used for refreshes.
vi.mock("~/utils/storage.server", () => ({
  createSignedUrl: mockCreateSignedUrl,
  uploadFile: vi.fn(),
}));

// why: permission is external to this route behavior and must stay org-scoped.
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mockRequirePermission,
}));

describe("asset image refresh route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequirePermission.mockResolvedValue({ organizationId: "org-1" });
    mockFindUnique.mockResolvedValue({
      id: "asset-1",
      mainImage: null,
      thumbnailImage: null,
      mainImageStoragePath: "user-1/asset-1/main.jpg",
      thumbnailImageStoragePath: "user-1/asset-1/main-thumbnail.jpg",
    });
    mockCreateSignedUrl.mockImplementation(({ filename, bucketName }) =>
      Promise.resolve(`https://storage.example/${bucketName}/${filename}`)
    );
    mockUpdate.mockResolvedValue({
      id: "asset-1",
      mainImage: "https://storage.example/assets/user-1/asset-1/main.jpg",
      thumbnailImage:
        "https://storage.example/assets/user-1/asset-1/main-thumbnail.jpg",
    });
  });

  it("re-signs canonical asset image paths when legacy URL fields are empty", async () => {
    const request = new Request(
      "https://app.example/api/asset/refresh-main-image?assetId=asset-1&mainImage=https%3A%2F%2Fstorage.example%2Fassets%2Fuser-1%2Fasset-1%2Fmain.jpg"
    );
    const result = await loader({
      request,
      context: { getSession: () => ({ userId: "user-1" }) },
      params: {},
    } as never);
    if (!(result instanceof Response)) {
      throw new Error("The asset image refresh route should return a response");
    }

    expect(mockFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "asset-1", organizationId: "org-1" },
        select: expect.objectContaining({
          mainImageStoragePath: true,
          thumbnailImageStoragePath: true,
        }),
      })
    );
    expect(mockCreateSignedUrl).toHaveBeenCalledWith({
      filename: "user-1/asset-1/main.jpg",
      bucketName: "assets",
    });
    expect(mockCreateSignedUrl).toHaveBeenCalledWith({
      filename: "user-1/asset-1/main-thumbnail.jpg",
      bucketName: "assets",
    });
    const body = await result.json();
    expect(body.asset.mainImage).toBe(
      "https://storage.example/assets/user-1/asset-1/main.jpg"
    );
    expect(body.asset.thumbnailImage).toBe(
      "https://storage.example/assets/user-1/asset-1/main-thumbnail.jpg"
    );
  });
});
