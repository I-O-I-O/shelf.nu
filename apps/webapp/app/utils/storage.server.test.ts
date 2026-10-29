import { beforeEach, describe, expect, it, vi } from "vitest";
import { PUBLIC_BUCKET } from "./constants";
import { SUPABASE_URL } from "./env";
import { ShelfError } from "./error";
import {
  findShelfErrorInCause,
  isSupabaseRateLimitError,
  isSupabaseServerError,
  MAX_PUBLIC_FILES_PER_REMOVE,
  parseFileFormData,
  removePublicFiles,
  uploadFile,
} from "./storage.server";

// why: the Supabase admin client talks to storage over HTTP; stub `remove` so
// the tests stay offline and can assert the paths sent in each request
const { storageRemoveMock, storageUploadMock } = vi.hoisted(() => ({
  storageRemoveMock: vi.fn(),
  storageUploadMock: vi.fn(),
}));
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: () => ({
    storage: {
      from: () => ({
        remove: storageRemoveMock,
        upload: storageUploadMock,
      }),
    },
  }),
}));

describe("isSupabaseRateLimitError", () => {
  it("returns true for StorageApiError with numeric status 429", () => {
    const error = {
      name: "StorageApiError",
      message: "Too many requests",
      status: 429,
    };
    expect(isSupabaseRateLimitError(error)).toBe(true);
  });

  it("returns true for StorageApiError with string statusCode '429'", () => {
    const error = {
      name: "StorageApiError",
      message: "Rate limit exceeded",
      statusCode: "429",
    };
    expect(isSupabaseRateLimitError(error)).toBe(true);
  });

  it('returns true for StorageApiError with "too many" in message', () => {
    const error = {
      name: "StorageApiError",
      message: "Too many connections issued to the database",
      status: 0,
    };
    expect(isSupabaseRateLimitError(error)).toBe(true);
  });

  it('returns true for case-insensitive "too many" matching', () => {
    const error = {
      name: "StorageApiError",
      message: "TOO MANY REQUESTS",
    };
    expect(isSupabaseRateLimitError(error)).toBe(true);
  });

  it("returns false for non-StorageApiError with status 429", () => {
    const error = {
      name: "StorageUnknownError",
      message: "Some error",
      status: 429,
    };
    expect(isSupabaseRateLimitError(error)).toBe(false);
  });

  it("returns false for StorageApiError with non-429 status", () => {
    const error = {
      name: "StorageApiError",
      message: "Not found",
      status: 404,
    };
    expect(isSupabaseRateLimitError(error)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSupabaseRateLimitError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isSupabaseRateLimitError(undefined)).toBe(false);
  });

  it("returns false for non-object values", () => {
    expect(isSupabaseRateLimitError("error")).toBe(false);
    expect(isSupabaseRateLimitError(42)).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isSupabaseRateLimitError({})).toBe(false);
  });
});

describe("isSupabaseServerError", () => {
  it("returns true for StorageApiError with status 504", () => {
    const error = {
      name: "StorageApiError",
      message: "Gateway Timeout",
      status: 504,
    };
    expect(isSupabaseServerError(error)).toBe(true);
  });

  it("returns true for StorageApiError with status 502", () => {
    const error = {
      name: "StorageApiError",
      message: "Bad Gateway",
      status: 502,
    };
    expect(isSupabaseServerError(error)).toBe(true);
  });

  it("returns true for StorageApiError with status 503", () => {
    const error = {
      name: "StorageApiError",
      message: "Service Unavailable",
      status: 503,
    };
    expect(isSupabaseServerError(error)).toBe(true);
  });

  it("returns true for StorageApiError with status 500", () => {
    const error = {
      name: "StorageApiError",
      message: "Internal Server Error",
      status: 500,
    };
    expect(isSupabaseServerError(error)).toBe(true);
  });

  it("returns true for StorageApiError with string statusCode '504'", () => {
    const error = {
      name: "StorageApiError",
      message: "Gateway Timeout",
      statusCode: "504",
    };
    expect(isSupabaseServerError(error)).toBe(true);
  });

  it("returns false for non-StorageApiError with 5xx status", () => {
    const error = {
      name: "StorageUnknownError",
      message: "Some error",
      status: 504,
    };
    expect(isSupabaseServerError(error)).toBe(false);
  });

  it("returns false for StorageApiError with 4xx status", () => {
    const error = {
      name: "StorageApiError",
      message: "Not found",
      status: 404,
    };
    expect(isSupabaseServerError(error)).toBe(false);
  });

  it("returns false for StorageApiError with status 429 (rate limit)", () => {
    const error = {
      name: "StorageApiError",
      message: "Too many requests",
      status: 429,
    };
    expect(isSupabaseServerError(error)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isSupabaseServerError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isSupabaseServerError(undefined)).toBe(false);
  });

  it("returns false for non-object values", () => {
    expect(isSupabaseServerError("error")).toBe(false);
    expect(isSupabaseServerError(42)).toBe(false);
  });

  it("returns false for empty object", () => {
    expect(isSupabaseServerError({})).toBe(false);
  });
});

describe("findShelfErrorInCause", () => {
  it("returns the ShelfError when it is the top-level error", () => {
    const shelfError = new ShelfError({
      cause: null,
      message: "Unsupported image format",
      title: "Bad format",
      label: "Crop image",
      shouldBeCaptured: false,
    });

    const result = findShelfErrorInCause(shelfError);

    expect(result).toBe(shelfError);
    expect(result?.message).toBe("Unsupported image format");
    expect(result?.title).toBe("Bad format");
    expect(result?.shouldBeCaptured).toBe(false);
  });

  it("finds a ShelfError nested one level deep in the cause chain", () => {
    const shelfError = new ShelfError({
      cause: null,
      message: "Unsupported image format",
      title: "Bad format",
      label: "Crop image",
      shouldBeCaptured: false,
    });

    // Simulates FormDataParseError wrapping a ShelfError
    const wrapper = new Error("Cannot parse form data");
    wrapper.cause = shelfError;

    const result = findShelfErrorInCause(wrapper);

    expect(result).toBe(shelfError);
    expect(result?.message).toBe("Unsupported image format");
    expect(result?.title).toBe("Bad format");
    expect(result?.shouldBeCaptured).toBe(false);
  });

  it("finds a ShelfError nested multiple levels deep", () => {
    const shelfError = new ShelfError({
      cause: null,
      message: "Original error",
      label: "File storage",
      shouldBeCaptured: false,
    });

    const innerWrapper = new Error("Inner wrapper");
    innerWrapper.cause = shelfError;

    const outerWrapper = new Error("Outer wrapper");
    outerWrapper.cause = innerWrapper;

    const result = findShelfErrorInCause(outerWrapper);

    expect(result).toBe(shelfError);
  });

  it("returns null when no ShelfError exists in the cause chain", () => {
    const plainError = new Error("Something went wrong");

    expect(findShelfErrorInCause(plainError)).toBeNull();
  });

  it("returns null for null input", () => {
    expect(findShelfErrorInCause(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(findShelfErrorInCause(undefined)).toBeNull();
  });
});

describe("removePublicFiles", () => {
  const publicUrlFor = (path: string) =>
    `${SUPABASE_URL}/storage/v1/object/public/${PUBLIC_BUCKET}/${path}`;

  beforeEach(() => {
    storageRemoveMock.mockReset();
    storageRemoveMock.mockResolvedValue({ data: [], error: null });
  });

  it("removes every file in a single storage request", async () => {
    const result = await removePublicFiles({
      publicUrls: [
        publicUrlFor("org-1/locations/loc-1/a.jpg"),
        publicUrlFor("org-1/locations/loc-1/a-thumbnail.jpg"),
        publicUrlFor("org-1/locations/loc-2/b.jpg"),
      ],
    });

    expect(storageRemoveMock).toHaveBeenCalledTimes(1);
    expect(storageRemoveMock).toHaveBeenCalledWith([
      "org-1/locations/loc-1/a.jpg",
      "org-1/locations/loc-1/a-thumbnail.jpg",
      "org-1/locations/loc-2/b.jpg",
    ]);
    expect(result).toEqual({ invalidUrlCount: 0 });
  });

  it("skips URLs outside the public bucket and still removes the rest", async () => {
    const result = await removePublicFiles({
      publicUrls: [
        "https://elsewhere.example.com/files/x.jpg",
        publicUrlFor("org-1/locations/loc-1/a.jpg"),
      ],
    });

    expect(storageRemoveMock).toHaveBeenCalledWith([
      "org-1/locations/loc-1/a.jpg",
    ]);
    expect(result).toEqual({ invalidUrlCount: 1 });
  });

  it("makes no request when no URL points into the public bucket", async () => {
    const result = await removePublicFiles({
      publicUrls: ["https://elsewhere.example.com/files/x.jpg"],
    });

    expect(storageRemoveMock).not.toHaveBeenCalled();
    expect(result).toEqual({ invalidUrlCount: 1 });
  });

  it("throws when the storage request fails", async () => {
    storageRemoveMock.mockResolvedValue({
      data: null,
      error: new Error("storage down"),
    });

    await expect(
      removePublicFiles({ publicUrls: [publicUrlFor("org-1/a.jpg")] })
    ).rejects.toBeInstanceOf(ShelfError);
  });

  it("refuses more files than one storage request accepts", async () => {
    const publicUrls = Array.from(
      { length: MAX_PUBLIC_FILES_PER_REMOVE + 1 },
      (_, i) => publicUrlFor(`org-1/${i}.jpg`)
    );

    await expect(removePublicFiles({ publicUrls })).rejects.toBeInstanceOf(
      ShelfError
    );
    expect(storageRemoveMock).not.toHaveBeenCalled();
  });
});

describe("unreadable image upload", () => {
  /** A JPEG cut off halfway: the header passes, the decoder fails. */
  async function truncatedJpeg(): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    const full = await sharp({
      create: { width: 64, height: 64, channels: 3, background: "#ef6820" },
    })
      .jpeg()
      .toBuffer();
    return full.subarray(0, Math.floor(full.length / 2));
  }

  it("keeps the 400 when uploadFile wraps it", async () => {
    const buffer = await truncatedJpeg();

    await expect(
      uploadFile(
        (async function* () {
          await Promise.resolve();
          yield new Uint8Array(buffer);
        })(),
        {
          filename: "asset.jpg",
          contentType: "image/jpeg",
          bucketName: "assets",
        }
      )
    ).rejects.toMatchObject({ status: 400, shouldBeCaptured: false });
  });

  it("keeps the 400 through the form-data parser's wrapping", async () => {
    const buffer = await truncatedJpeg();
    const form = new FormData();
    form.append(
      "mainImage",
      new File([new Uint8Array(buffer)], "asset.jpg", { type: "image/jpeg" })
    );

    await expect(
      parseFileFormData({
        request: new Request("http://localhost/assets/new", {
          method: "POST",
          body: form,
        }),
        newFileName: "asset-1/main",
        bucketName: "assets",
      })
    ).rejects.toMatchObject({
      status: 400,
      shouldBeCaptured: false,
      title: "Image could not be read",
    });
  });

  it("returns a useful validation error for a non-image MIME type", async () => {
    const form = new FormData();
    form.append(
      "mainImage",
      new File(["not an image"], "asset.txt", { type: "text/plain" })
    );

    await expect(
      parseFileFormData({
        request: new Request("http://localhost/assets/new", {
          method: "POST",
          body: form,
        }),
        newFileName: "asset-1/main",
        bucketName: "assets",
      })
    ).rejects.toMatchObject({
      status: 400,
      shouldBeCaptured: false,
      title: "Unsupported image format",
      message:
        "Please upload a supported image file (JPEG, PNG, GIF, WebP, or BMP).",
    });
  });

  it("reproduces an unselected file input being rejected as an unsupported image", async () => {
    const form = new FormData();
    form.append(
      "mainImage",
      new File([], "", { type: "application/octet-stream" })
    );

    await expect(
      parseFileFormData({
        request: new Request("http://localhost/assets/new", {
          method: "POST",
          body: form,
        }),
        newFileName: "asset-1/main",
        bucketName: "assets",
      })
    ).rejects.toMatchObject({
      title: "Unsupported image format",
      message:
        "Please upload a supported image file (JPEG, PNG, GIF, WebP, or BMP).",
    });
  });

  it.each(["mainImage", "image"])(
    "omits an empty %s file input when optional uploads allow it",
    async (fieldName) => {
      const form = new FormData();
      form.append(
        fieldName,
        new File([], "", { type: "application/octet-stream" })
      );

      const parsed = await parseFileFormData({
        request: new Request("http://localhost/assets/new", {
          method: "POST",
          body: form,
        }),
        newFileName: "asset-1/main",
        bucketName: "assets",
        allowEmptyFile: true,
      });

      expect(parsed.has(fieldName)).toBe(false);
    }
  );

  it("still rejects a named unsupported file when optional uploads allow no selection", async () => {
    const form = new FormData();
    form.append(
      "mainImage",
      new File(["not an image"], "asset.txt", { type: "text/plain" })
    );

    await expect(
      parseFileFormData({
        request: new Request("http://localhost/assets/new", {
          method: "POST",
          body: form,
        }),
        newFileName: "asset-1/main",
        bucketName: "assets",
        allowEmptyFile: true,
      })
    ).rejects.toMatchObject({
      status: 400,
      title: "Unsupported image format",
      message:
        "Please upload a supported image file (JPEG, PNG, GIF, WebP, or BMP).",
    });
  });

  it("returns a useful validation error when the file exceeds its limit", async () => {
    const form = new FormData();
    form.append(
      "mainImage",
      new File(["12345"], "asset.png", { type: "image/png" })
    );

    await expect(
      parseFileFormData({
        request: new Request("http://localhost/assets/new", {
          method: "POST",
          body: form,
        }),
        newFileName: "asset-1/main",
        bucketName: "assets",
        maxFileSize: 4,
        allowEmptyFile: true,
      })
    ).rejects.toMatchObject({ status: 400, title: "File too large" });
  });
});

describe("partial image upload cleanup", () => {
  beforeEach(() => {
    storageRemoveMock.mockReset().mockResolvedValue({ error: null });
    storageUploadMock.mockReset();
  });

  it("stores direct uploads with the WebP extension and content type", async () => {
    const sharp = (await import("sharp")).default;
    const buffer = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#e12d3d" },
    })
      .png()
      .toBuffer();
    storageUploadMock.mockResolvedValue({
      data: { path: "org-1/assets/legacy-thumbnail.webp" },
      error: null,
    });

    const result = await uploadFile(
      (async function* () {
        await Promise.resolve();
        yield new Uint8Array(buffer);
      })(),
      {
        filename: "org-1/assets/legacy-thumbnail.png",
        contentType: "image/png",
        bucketName: "assets",
      }
    );

    expect(result).toBe("org-1/assets/legacy-thumbnail.webp");
    expect(storageUploadMock).toHaveBeenCalledWith(
      "org-1/assets/legacy-thumbnail.webp",
      expect.any(Uint8Array),
      { contentType: "image/webp", upsert: false }
    );
  });

  it("removes the original object when thumbnail upload fails", async () => {
    const sharp = (await import("sharp")).default;
    const buffer = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#e12d3d" },
    })
      .png()
      .toBuffer();

    storageUploadMock
      .mockResolvedValueOnce({
        data: { path: "org-1/asset-1/main.webp" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: null,
        error: { name: "StorageApiError", message: "thumbnail write failed" },
      });

    await expect(
      uploadFile(
        (async function* () {
          await Promise.resolve();
          yield new Uint8Array(buffer);
        })(),
        {
          filename: "org-1/asset-1/main.png",
          contentType: "image/png",
          bucketName: "assets",
          resizeOptions: { width: 1200, withoutEnlargement: true },
          generateThumbnail: true,
        }
      )
    ).rejects.toMatchObject({ message: expect.stringContaining("uploading") });

    expect(storageRemoveMock).toHaveBeenCalledWith([
      "org-1/asset-1/main.webp",
      "org-1/asset-1/main-thumbnail.webp",
    ]);
  });

  it("stores processed image bytes as WebP and returns canonical paths", async () => {
    const sharp = (await import("sharp")).default;
    const buffer = await sharp({
      create: { width: 64, height: 48, channels: 3, background: "#e12d3d" },
    })
      .png()
      .toBuffer();
    storageUploadMock.mockImplementation((path: string) =>
      Promise.resolve({ data: { path }, error: null })
    );
    const form = new FormData();
    form.append(
      "mainImage",
      new File([new Uint8Array(buffer)], "asset.png", { type: "image/png" })
    );

    const result = await parseFileFormData({
      request: new Request("http://localhost/assets/new", {
        method: "POST",
        body: form,
      }),
      newFileName: "org-1/assets/asset-1/main-image",
      bucketName: "assets",
      resizeOptions: { width: 1200, withoutEnlargement: true },
      generateThumbnail: true,
    });

    expect(JSON.parse(String(result.get("mainImage")))).toEqual({
      originalPath: "org-1/assets/asset-1/main-image.webp",
      thumbnailPath: "org-1/assets/asset-1/main-image-thumbnail.webp",
    });
    expect(storageUploadMock).toHaveBeenNthCalledWith(
      1,
      "org-1/assets/asset-1/main-image.webp",
      expect.any(Buffer),
      { contentType: "image/webp", upsert: false }
    );
    expect(storageUploadMock).toHaveBeenNthCalledWith(
      2,
      "org-1/assets/asset-1/main-image-thumbnail.webp",
      expect.any(Buffer),
      { contentType: "image/webp", upsert: true }
    );
    expect(storageRemoveMock).not.toHaveBeenCalled();
  });
});

it("enforces the requested final byte cap after canonical processing and before storage", async () => {
  const sharp = (await import("sharp")).default;
  const bytes = await sharp({
    create: { width: 128, height: 128, channels: 3, background: "#abc" },
  })
    .png()
    .toBuffer();
  storageUploadMock.mockClear();
  await expect(
    uploadFile(
      (async function* () {
        await Promise.resolve();
        yield bytes;
      })(),
      {
        filename: "org/product",
        contentType: "image/png",
        bucketName: "assets",
        maxProcessedBytes: 1,
      }
    )
  ).rejects.toThrow();
  expect(storageUploadMock).not.toHaveBeenCalled();
});
