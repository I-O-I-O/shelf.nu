import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockSafeFetch } = vi.hoisted(() => ({ mockSafeFetch: vi.fn() }));

// why: outbound Openverse and image hosts are untrusted network dependencies; mocked responses keep validation tests deterministic and prevent test traffic.
vi.mock("~/utils/ssrf.server", () => ({ safeFetch: mockSafeFetch }));

import {
  enrichImportProductRows,
  IMPORT_IMAGE_SOURCE_MAX_BYTES,
} from "./product-enrichment.server";
import type {
  ExistingImportAssetModel,
  ImportProductEnrichmentRow,
} from "./product-enrichment.server";

function buildRow(
  overrides: Partial<ImportProductEnrichmentRow> = {}
): ImportProductEnrichmentRow {
  return {
    rowNumber: 1,
    title: "Arduino Nano",
    manufacturer: "Arduino",
    manufacturerPartNumber: "A000005",
    sourceDescription: null,
    enrichmentConfidence: 0.95,
    assetModelDescription:
      "Compact development board for embedded electronics prototyping.",
    ...overrides,
  };
}

function openverseResponse(overrides: Record<string, unknown> = {}) {
  return {
    buffer: Buffer.from(
      JSON.stringify({
        results: [
          {
            url: "https://images.example.org/arduino-nano.png",
            title: "Arduino Nano A000005 board",
            creator: "Arduino",
            license: "cc0",
            foreign_landing_url: "https://openverse.org/image/1",
            width: 512,
            height: 512,
            tags: [{ name: "microcontroller" }],
            ...overrides,
          },
        ],
      })
    ),
    contentType: "application/json",
  };
}

async function pngFixture() {
  return sharp({
    create: {
      width: 128,
      height: 128,
      channels: 3,
      background: { r: 30, g: 80, b: 160 },
    },
  })
    .png()
    .toBuffer();
}

function configureSuccessfulImageLookup(imageBytes: Buffer) {
  mockSafeFetch.mockImplementation((url: string) =>
    url.includes("api.openverse.org")
      ? openverseResponse()
      : { buffer: imageBytes, contentType: "image/png" }
  );
}

describe("inventory import product enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses a practical description when the product identity is clear", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      buffer: Buffer.from(JSON.stringify({ results: [] })),
      contentType: "application/json",
    });
    const { rows, diagnostics } = await enrichImportProductRows(
      [buildRow()],
      []
    );
    expect(rows[0].assetModelDescription).toContain("embedded electronics");
    expect(rows[0].assetModelDescriptionSource).toBe("GENERATED");
    expect(diagnostics.descriptionGenerated).toBe(1);
  });

  it("leaves an ambiguous product description blank", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      buffer: Buffer.from(JSON.stringify({ results: [] })),
      contentType: "application/json",
    });
    const { rows } = await enrichImportProductRows(
      [
        buildRow({
          enrichmentConfidence: 0.4,
          assetModelDescription: "A detailed description that is not verified.",
        }),
      ],
      []
    );
    expect(rows[0].assetModelDescription).toBeNull();
    expect(rows[0].assetModelDescriptionSource).toBe("NONE");
  });

  it("preserves existing canonical description and image metadata", async () => {
    const model: ExistingImportAssetModel = {
      id: "model-1",
      name: "Arduino Nano",
      description: "Existing Shelf description.",
      imageUrl: "https://shelf.example.org/current.webp",
      thumbnailUrl: "https://shelf.example.org/current-thumb.webp",
      importIdentityKey: null,
    };
    const { rows } = await enrichImportProductRows([buildRow()], [model]);
    expect(rows[0].assetModelDescription).toBe("Existing Shelf description.");
    expect(rows[0].assetModelDescriptionSource).toBe("SHELF_EXISTING");
    expect(rows[0].existingAssetModelImageUrl).toBe(model.imageUrl);
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_PRESERVED");
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("preserves a short existing canonical description", async () => {
    const { rows } = await enrichImportProductRows(
      [buildRow()],
      [
        {
          id: "model-short-description",
          name: "Arduino Nano",
          description: "Use for prototyping.",
          imageUrl: "https://shelf.example.org/current.webp",
          thumbnailUrl: null,
          importIdentityKey: null,
        },
      ]
    );
    expect(rows[0].assetModelDescription).toBe("Use for prototyping.");
    expect(rows[0].assetModelDescriptionSource).toBe("SHELF_EXISTING");
  });

  it("uses a meaningful supplier SKU in the bounded image search query", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      buffer: Buffer.from(JSON.stringify({ results: [] })),
      contentType: "application/json",
    });
    await enrichImportProductRows(
      [buildRow({ supplierPartNumber: "SUP-4567" })],
      []
    );
    expect(mockSafeFetch.mock.calls[0]?.[0]).toContain("SUP-4567");
  });

  it("accepts a matching supported image below 2 MB as proposal data", async () => {
    const bytes = await pngFixture();
    expect(bytes.byteLength).toBeLessThan(IMPORT_IMAGE_SOURCE_MAX_BYTES);
    configureSuccessfulImageLookup(bytes);
    const { rows } = await enrichImportProductRows([buildRow()], []);
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_FOUND");
    expect(rows[0].productImageProposal?.mimeType).toBe("image/webp");
    expect(rows[0].productImageProposal?.dataBase64).toBeTruthy();
    expect(mockSafeFetch).toHaveBeenNthCalledWith(
      2,
      "https://images.example.org/arduino-nano.png",
      expect.objectContaining({
        maxBytes: IMPORT_IMAGE_SOURCE_MAX_BYTES,
        timeoutMs: expect.any(Number),
      })
    );
  });

  it("rejects a source image over the 2 MB cap", async () => {
    const bytes = Buffer.alloc(IMPORT_IMAGE_SOURCE_MAX_BYTES + 1);
    configureSuccessfulImageLookup(bytes);
    const { rows } = await enrichImportProductRows([buildRow()], []);
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_TOO_LARGE");
  });

  it("rejects an HTML response that claims to be the candidate image", async () => {
    mockSafeFetch
      .mockResolvedValueOnce(openverseResponse())
      .mockResolvedValueOnce({
        buffer: Buffer.from("<html>not an image</html>"),
        contentType: "text/html",
      });
    const { rows } = await enrichImportProductRows([buildRow()], []);
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_INVALID_TYPE");
  });

  it("rejects unsupported MIME and SVG image formats", async () => {
    mockSafeFetch
      .mockResolvedValueOnce(openverseResponse())
      .mockResolvedValueOnce({
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" />'),
        contentType: "image/svg+xml",
      });
    const { rows } = await enrichImportProductRows([buildRow()], []);
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_INVALID_TYPE");
  });

  it.each([
    ["redirect limit", new Error("Too many redirects (> 5)")],
    ["timeout", new Error("Timed out while reading the response body")],
    [
      "private-network URL",
      new Error("Refused to fetch from a private address"),
    ],
  ])(
    "keeps image lookup failure importable after %s",
    async (_label, error) => {
      mockSafeFetch.mockRejectedValueOnce(error);
      const { rows } = await enrichImportProductRows(
        [
          buildRow({
            sourceDescription: "A compact board used for prototyping.",
          }),
        ],
        []
      );
      expect(rows[0].assetModelDescription).toBe(
        "A compact board used for prototyping."
      );
      expect(rows[0].productImageProposal?.status).toBe("IMAGE_FETCH_FAILED");
    }
  );
});
