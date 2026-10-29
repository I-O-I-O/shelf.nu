import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSafeFetch } = vi.hoisted(() => ({ mockSafeFetch: vi.fn() }));

// why: outbound search providers, product pages, and image hosts are untrusted
// network dependencies; mocked responses keep tests deterministic and offline.
vi.mock("~/utils/ssrf.server", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, safeFetch: mockSafeFetch };
});

import {
  BraveProductSearchProvider,
  buildProductSearchQueries,
  enrichImportProductRows,
  IMPORT_IMAGE_SOURCE_MAX_BYTES,
  processStaffImportImageUpload,
} from "./product-enrichment.server";
import type {
  ExistingImportAssetModel,
  ImportProductEnrichmentRow,
  ProductSearchProvider,
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
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
  });

  afterEach(() => vi.unstubAllEnvs());

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

  it("builds ordered product queries from MPN, model, SKU, and description", () => {
    expect(
      buildProductSearchQueries(
        buildRow({
          title: "Seeed Studio XIAO ESP32-S3 Sense",
          manufacturer: "Seeed Studio",
          manufacturerPartNumber: "113991114",
          supplierPartNumber: "SUP-113991114",
          sourceDescription: "Compact camera-enabled microcontroller board",
          productUrl: null,
          productImageUrl: null,
        })
      )
    ).toEqual([
      "Seeed Studio 113991114",
      "Seeed Studio XIAO ESP32-S3 Sense",
      "113991114",
      "Seeed Studio Compact camera-enabled microcontroller board",
    ]);
  });

  it("calls Brave web search with a server-side token and returns only safe product pages", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      buffer: Buffer.from(
        JSON.stringify({
          web: {
            results: [
              {
                url: "https://www.seeedstudio.com/xiao.html",
                title: "Seeed Studio XIAO ESP32-S3 Sense",
                description: "MPN 113991114",
              },
              {
                url: "http://127.0.0.1/internal",
                title: "XIAO ESP32-S3 Sense",
                description: "Internal result",
              },
            ],
          },
        })
      ),
      contentType: "application/json",
    });
    const provider = new BraveProductSearchProvider("server-only-token");

    const results = await provider.search("Seeed Studio 113991114", 10);

    expect(results).toEqual([
      {
        productPageUrl: "https://www.seeedstudio.com/xiao.html",
        title: "Seeed Studio XIAO ESP32-S3 Sense",
        description: "MPN 113991114",
        sourceDomain: "www.seeedstudio.com",
      },
    ]);
    expect(mockSafeFetch).toHaveBeenCalledWith(
      expect.stringContaining("https://api.search.brave.com/res/v1/web/search"),
      expect.objectContaining({
        headers: {
          accept: "application/json",
          "x-subscription-token": "server-only-token",
        },
        timeoutMs: expect.any(Number),
      })
    );
    expect(mockSafeFetch.mock.calls[0]?.[0]).toContain(
      "q=Seeed+Studio+113991114"
    );
  });

  it("accepts a matching supported image and marks strong identity safe to apply", async () => {
    const bytes = await pngFixture();
    expect(bytes.byteLength).toBeLessThan(IMPORT_IMAGE_SOURCE_MAX_BYTES);
    configureSuccessfulImageLookup(bytes);
    const { rows } = await enrichImportProductRows([buildRow()], []);
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_FOUND");
    expect(rows[0].productImageProposal?.mimeType).toBe("image/webp");
    expect(rows[0].productImageProposal?.dataBase64).toBeTruthy();
    expect(rows[0].productImageProposal?.autoAccepted).toBe(true);
    expect(rows[0].productImageProposal?.source).toBe("OPENVERSE");
    expect(mockSafeFetch).toHaveBeenNthCalledWith(
      2,
      "https://images.example.org/arduino-nano.png",
      expect.objectContaining({
        maxBytes: IMPORT_IMAGE_SOURCE_MAX_BYTES,
        timeoutMs: expect.any(Number),
      })
    );
  });

  it("rejects a source image over the bounded 8 MB download ceiling", async () => {
    const bytes = Buffer.alloc(IMPORT_IMAGE_SOURCE_MAX_BYTES + 1);
    configureSuccessfulImageLookup(bytes);
    const { rows } = await enrichImportProductRows([buildRow()], []);
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_TOO_LARGE");
  });

  it("compresses a valid source image larger than 2 MB before proposal", async () => {
    const raw = randomBytes(3_000_000);
    const bytes = await sharp(raw, {
      raw: { width: 1000, height: 1000, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    expect(bytes.byteLength).toBeLessThan(IMPORT_IMAGE_SOURCE_MAX_BYTES);
    configureSuccessfulImageLookup(bytes);
    const { rows } = await enrichImportProductRows([buildRow()], []);
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_FOUND");
    expect(
      Buffer.from(rows[0].productImageProposal?.dataBase64 ?? "", "base64")
        .byteLength
    ).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("rejects category-only identity without making an external lookup", async () => {
    const { rows } = await enrichImportProductRows(
      [
        buildRow({
          title: "Electronics",
          manufacturer: null,
          manufacturerPartNumber: null,
        }),
      ],
      []
    );
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_AMBIGUOUS");
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });

  it("reports product-page search as unavailable when no provider key is configured", async () => {
    mockSafeFetch.mockResolvedValueOnce({
      buffer: Buffer.from(JSON.stringify({ results: [] })),
      contentType: "application/json",
    });

    const { rows, diagnostics } = await enrichImportProductRows(
      [buildRow()],
      []
    );

    expect(rows[0].productImageProposal?.status).toBe(
      "IMAGE_SEARCH_PROVIDER_UNAVAILABLE"
    );
    expect(diagnostics.searchProviderConfigured).toBe(false);
    expect(rows[0].productImageProposal?.failureReason).toBe(
      "SEARCH_PROVIDER_NOT_CONFIGURED"
    );
  });

  it("accepts a source document image URL for a clearly identified product", async () => {
    const bytes = await pngFixture();
    mockSafeFetch.mockResolvedValueOnce({
      buffer: bytes,
      contentType: "image/png",
    });
    const { rows } = await enrichImportProductRows(
      [
        buildRow({
          productImageUrl: "https://supplier.example.org/files/nano.png",
        }),
      ],
      []
    );
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_FOUND");
    expect(rows[0].productImageProposal?.source).toBe("SOURCE_DOCUMENT");
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it("automatically enriches twenty distinct product identities with mocked images", async () => {
    const inventory: ImportProductEnrichmentRow[] = [
      ["Seeed Studio", "Seeed Studio XIAO ESP32-S3 Sense", "113991115"],
      ["Raspberry Pi", "Raspberry Pi Pico 2 W", "SC1631"],
      ["Arduino", "Arduino Nano ESP32", "ABX00083"],
      ["Adafruit", "Adafruit BME280", "2652"],
      ["Rigol", "Rigol DS1054Z Digital Oscilloscope", "DS1054Z"],
      ["UNI-T", "UNI-T UT61E+ Digital Multimeter", "UT61EPLUS"],
      ["Wera", "Wera Kraftform Micro 12 Screwdriver Set", "05073675001"],
      ["Raspberry Pi", "Raspberry Pi Camera Module 3 Wide", "SC0874"],
      ["Adafruit", "Adafruit USB-C Cable", "4474"],
      ["Seeed Studio", "Seeed Studio Grove BME280 Sensor", "101020019"],
      ["Pololu", "Pololu Micro Metal Gearmotor", "2975"],
      ["SparkFun", "SparkFun Logic Level Converter", "BOB-12009"],
      ["Arduino", "Arduino Uno R4 WiFi", "ABX00087"],
      ["Adafruit", "Adafruit NeoPixel Ring", "1643"],
      ["Wago", "Wago 221 Connector Assortment", "221-413"],
      ["Mean Well", "Mean Well HDR-30-5 Power Supply", "HDR-30-5"],
      ["Hakko", "Hakko T18 Soldering Tip", "T18-D16"],
      ["Anker", "Anker USB-C Power Adapter", "A2347"],
      ["JST", "JST-XH 2-Pin Cable Assembly", "XHP-2"],
      ["Kingbright", "Kingbright 5mm LED Assortment", "WP7113"],
    ].map(([manufacturer, title, mpn], index) => ({
      rowNumber: index + 2,
      title,
      manufacturer,
      manufacturerPartNumber: mpn,
      sourceDescription: `${title} for electronics prototyping and repair.`,
      enrichmentConfidence: 0.95,
      assetModelDescription: `${title} is a component used for electronics prototyping and repair.`,
    }));
    const imageBytes = await pngFixture();
    mockSafeFetch.mockImplementation((url: string) => {
      if (url.includes("api.openverse.org")) {
        const query = new URL(url).searchParams.get("q") ?? "";
        const matched = inventory.find((row) =>
          query.includes(row.manufacturerPartNumber ?? "")
        );
        return {
          buffer: Buffer.from(
            JSON.stringify({
              results: matched
                ? [
                    {
                      url: "https://images.example.org/inventory.webp",
                      title: `${matched.title} ${matched.manufacturerPartNumber}`,
                      creator: matched.manufacturer,
                      license: "cc0",
                      foreign_landing_url: "https://openverse.org/item/1",
                      width: 512,
                      height: 512,
                      tags: [],
                    },
                  ]
                : [],
            })
          ),
          contentType: "application/json",
        };
      }
      return { buffer: imageBytes, contentType: "image/png" };
    });

    const { rows, diagnostics } = await enrichImportProductRows(inventory, []);

    expect(rows).toHaveLength(20);
    expect(
      rows.filter((row) => row.productImageProposal?.status === "IMAGE_FOUND")
    ).toHaveLength(20);
    expect(rows.filter((row) => row.assetModelDescription)).toHaveLength(20);
    expect(diagnostics.imageLookupAttempted).toBe(20);
    expect(diagnostics.imageLookupSucceeded).toBe(20);
  });

  it("finds images from text-only invoice identities through product-page search", async () => {
    vi.stubEnv(
      "IOIO_PRODUCT_IMAGE_MANUFACTURER_DOMAINS",
      JSON.stringify({ "UNI-T": ["uni-trend.com"] })
    );
    const invoiceLines = [
      ["Seeed Studio", "XIAO ESP32-S3 Sense", "113991115"],
      ["Arduino", "Arduino Nano ESP32", "ABX00083"],
      ["Raspberry Pi", "Raspberry Pi Pico 2 W", "SC1631"],
      ["Adafruit", "Adafruit BME280", "2652"],
      ["Rigol", "Rigol DS1054Z", "DS1054Z"],
      ["UNI-T", "UNI-T UT61E+", "UT61EPLUS"],
      ["Wera", "Wera Kraftform Micro 12", "05073675001"],
      ["Pololu", "Pololu 37D Metal Gearmotor", "4753"],
    ];
    const inventory: ImportProductEnrichmentRow[] = invoiceLines.map(
      ([manufacturer, title, mpn], index) => ({
        rowNumber: index + 2,
        title,
        manufacturer,
        manufacturerPartNumber: mpn,
        supplierPartNumber: `SUP-${mpn}`,
        productUrl: null,
        productImageUrl: null,
        sourceDescription: title,
        enrichmentConfidence: 0.95,
        assetModelDescription: `${title} is used in lab electronics and prototyping.`,
      })
    );
    const imageBytes = await pngFixture();
    const productPages = new Map<string, Buffer>();
    const searchMock = vi.fn((query: string) => {
      const productIndex = inventory.findIndex((row) =>
        query.includes(row.manufacturerPartNumber ?? "")
      );
      const row = inventory[productIndex];
      if (!row) return Promise.resolve([]);
      const manufacturerSlug = row.manufacturer
        ?.toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      const manufacturerDomain =
        row.manufacturer === "UNI-T"
          ? "uni-trend.com"
          : `${manufacturerSlug}.com`;
      const productPageUrl = `https://www.${manufacturerDomain}/product-${
        productIndex + 1
      }`;
      productPages.set(
        productPageUrl,
        Buffer.from(
          `<script type="application/ld+json">${JSON.stringify({
            "@type": "Product",
            name: row.title.replace(
              new RegExp(`^${row.manufacturer}\\s+`, "i"),
              ""
            ),
            brand: { "@type": "Brand", name: row.manufacturer },
            mpn: row.manufacturerPartNumber,
            image: `https://images.example.org/product-${productIndex + 1}.png`,
          })}</script>`
        )
      );
      return Promise.resolve([
        {
          productPageUrl,
          title: `${row.manufacturer} ${row.title} ${row.manufacturerPartNumber}`,
          description: row.sourceDescription ?? "",
          sourceDomain: new URL(productPageUrl).hostname,
        },
      ]);
    });
    const productSearchProvider: ProductSearchProvider = { search: searchMock };
    mockSafeFetch.mockImplementation((url: string) => {
      const page = productPages.get(url);
      if (page) return { buffer: page, contentType: "text/html" };
      return { buffer: imageBytes, contentType: "image/png" };
    });

    const { rows, diagnostics } = await enrichImportProductRows(
      inventory,
      [],
      undefined,
      productSearchProvider
    );

    expect(searchMock).toHaveBeenCalledTimes(8);
    expect(searchMock.mock.calls.map(([query]) => query)).toEqual(
      invoiceLines.map(([manufacturer, , mpn]) => `${manufacturer} ${mpn}`)
    );
    expect(rows).toHaveLength(8);
    expect(
      rows.filter((row) => row.productImageProposal?.status === "IMAGE_FOUND")
    ).toHaveLength(8);
    expect(
      rows.every(
        (row) =>
          row.productImageProposal?.autoAccepted === true &&
          row.productImageProposal.identityEvidence === "EXACT_MPN" &&
          Buffer.from(row.productImageProposal.dataBase64 ?? "", "base64")
            .byteLength <=
            2 * 1024 * 1024
      )
    ).toBe(true);
    expect(diagnostics.imageLookupSucceeded).toBe(8);
  });

  it("prefers a verified manufacturer page over a configured distributor", async () => {
    vi.stubEnv("IOIO_PRODUCT_IMAGE_TRUSTED_DISTRIBUTOR_DOMAINS", "digikey.com");
    const row = buildRow({ productUrl: null, productImageUrl: null });
    const distributorUrl =
      "https://www.digikey.com/en/products/detail/arduino/A000005";
    const manufacturerUrl = "https://www.arduino.cc/product/nano";
    const imageUrl = "https://images.example.org/arduino-nano.png";
    const imageBytes = await pngFixture();
    const productPage = Buffer.from(
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Arduino Nano",
        brand: { "@type": "Brand", name: "Arduino" },
        mpn: "A000005",
        image: imageUrl,
      })}</script>`
    );
    const provider: ProductSearchProvider = {
      search: vi.fn(() =>
        Promise.resolve([
          {
            productPageUrl: distributorUrl,
            title: "Arduino Nano A000005",
            description: "Arduino product listing, MPN A000005",
            sourceDomain: "www.digikey.com",
          },
          {
            productPageUrl: manufacturerUrl,
            title: "Arduino Nano A000005",
            description: "Arduino official product page, MPN A000005",
            sourceDomain: "www.arduino.cc",
          },
        ])
      ),
    };
    mockSafeFetch.mockImplementation((url: string) => {
      if (url === manufacturerUrl || url === distributorUrl) {
        return { buffer: productPage, contentType: "text/html" };
      }
      return { buffer: imageBytes, contentType: "image/png" };
    });

    const { rows } = await enrichImportProductRows(
      [row],
      [],
      undefined,
      provider
    );

    expect(rows[0].productImageProposal?.status).toBe("IMAGE_FOUND");
    expect(rows[0].productImageProposal?.source).toBe("MANUFACTURER");
    expect(mockSafeFetch).toHaveBeenCalledWith(
      manufacturerUrl,
      expect.anything()
    );
    expect(mockSafeFetch).not.toHaveBeenCalledWith(
      distributorUrl,
      expect.anything()
    );
  });

  it("continues to a later query to prefer an official page over an earlier distributor match", async () => {
    vi.stubEnv("IOIO_PRODUCT_IMAGE_TRUSTED_DISTRIBUTOR_DOMAINS", "digikey.com");
    const row = buildRow({ productUrl: null, productImageUrl: null });
    const distributorUrl =
      "https://www.digikey.com/en/products/detail/arduino/A000005";
    const manufacturerUrl = "https://www.arduino.cc/product/nano";
    const imageBytes = await pngFixture();
    const productPage = Buffer.from(
      `<script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Arduino Nano",
        brand: { "@type": "Brand", name: "Arduino" },
        mpn: "A000005",
        image: "https://images.example.org/arduino-nano.png",
      })}</script>`
    );
    const provider: ProductSearchProvider = {
      search: vi.fn((query: string) =>
        Promise.resolve([
          {
            productPageUrl: query.includes("A000005")
              ? distributorUrl
              : manufacturerUrl,
            title: "Arduino Nano A000005",
            description: "Arduino Nano development board, MPN A000005",
            sourceDomain: query.includes("A000005")
              ? "www.digikey.com"
              : "www.arduino.cc",
          },
        ])
      ),
    };
    mockSafeFetch.mockImplementation((url: string) => {
      if (url === manufacturerUrl || url === distributorUrl) {
        return { buffer: productPage, contentType: "text/html" };
      }
      return { buffer: imageBytes, contentType: "image/png" };
    });

    const { rows } = await enrichImportProductRows(
      [row],
      [],
      undefined,
      provider
    );

    expect(provider.search).toHaveBeenCalledTimes(2);
    expect(rows[0].productImageProposal?.source).toBe("MANUFACTURER");
    expect(rows[0].productImageProposal?.sourceUrl).toBe(manufacturerUrl);
  });

  it("attempts every unique product in a larger import with bounded lookup workers", async () => {
    mockSafeFetch.mockResolvedValue({
      buffer: Buffer.from(JSON.stringify({ results: [] })),
      contentType: "application/json",
    });
    const inventory = Array.from({ length: 35 }, (_, index) =>
      buildRow({
        rowNumber: index + 1,
        title: `Lab Maker Widget ${index + 1}`,
        manufacturer: "Lab Maker",
        manufacturerPartNumber: `LM-${index + 1}`,
      })
    );

    const { rows, diagnostics } = await enrichImportProductRows(inventory, []);

    expect(rows).toHaveLength(35);
    expect(diagnostics.imageLookupAttempted).toBe(35);
    expect(mockSafeFetch).toHaveBeenCalledTimes(35);
  });

  it.each(["113991115", "113991114"])(
    "handles real Seeed metadata shape and checks SKU %s against the Sense variant",
    async (code) => {
      const bytes = await pngFixture();
      const productPageUrl =
        "https://www.seeedstudio.com/XIAO-ESP32S3-Sense-p-5639.html";
      const imageUrl =
        "https://media-cdn.seeedstudio.com/media/catalog/product/sense.jpg";
      const page = `<meta property="og:title" content="Seeed&#x20;Studio&#x20;XIAO&#x20;ESP32-S3&#x20;Sense"><meta property="og:image" content="${imageUrl}"><script type="application/ld+json">{"@type":"Product","name":"Seeed Studio XIAO ESP32-S3 Sense", "sku":"113991115", "description":"First line
Second line &quot;camera&quot;", "image":"${imageUrl}"}</script>`;
      mockSafeFetch.mockImplementation((url: string) =>
        url.includes("openverse")
          ? {
              buffer: Buffer.from('{"results":[]}'),
              contentType: "application/json",
            }
          : url === productPageUrl
          ? { buffer: Buffer.from(page), contentType: "text/html" }
          : { buffer: bytes, contentType: "image/png" }
      );
      const provider: ProductSearchProvider = {
        name: "MOCK_WEB_SEARCH",
        search: vi.fn(() =>
          Promise.resolve([
            {
              productPageUrl,
              title: "Seeed Studio XIAO ESP32-S3 Sense 113991115",
              description: "Official product",
              sourceDomain: "www.seeedstudio.com",
            },
          ])
        ),
      };
      const { rows } = await enrichImportProductRows(
        [
          buildRow({
            title: "XIAO ESP32-S3 Sense",
            manufacturer: "Seeed Studio",
            manufacturerPartNumber: code,
            sourceDescription: null,
          }),
        ],
        [],
        undefined,
        provider
      );
      const image = rows[0].productImageProposal;
      if (code === "113991115") {
        expect(image).toMatchObject({
          status: "IMAGE_FOUND",
          source: "MANUFACTURER",
          identityEvidence: "EXACT_SUPPLIER_SKU",
          attempt: {
            productIdentityBuilt: true,
            searchAttempted: true,
            searchProvider: "MOCK_WEB_SEARCH",
            selectedProductPage: productPageUrl,
            imageMetadataFound: true,
            imageDownloadAttempted: true,
            downloadBytes: bytes.length,
            imageProcessed: true,
          },
        });
        expect(image?.attempt?.finalBytes).toBeGreaterThan(0);
        expect(image?.attempt?.finalBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      } else {
        expect(image?.status).not.toBe("IMAGE_FOUND");
        expect(image?.failureReason).toBe("IDENTITY_MISMATCH");
        expect(image?.attempt?.imageDownloadAttempted).toBe(false);
        expect(
          mockSafeFetch.mock.calls.some(([url]) =>
            String(url).includes("openverse")
          )
        ).toBe(false);
      }
    }
  );

  it("rejects an Openverse variant mismatch even when its part number matches", async () => {
    mockSafeFetch.mockResolvedValue(
      openverseResponse({
        title: "Seeed Studio XIAO ESP32-S3 113991114",
        creator: "Seeed Studio",
      })
    );
    const { rows } = await enrichImportProductRows(
      [
        buildRow({
          manufacturer: "Seeed Studio",
          title: "XIAO ESP32-S3 Sense",
          manufacturerPartNumber: "113991114",
        }),
      ],
      [],
      undefined,
      null
    );
    expect(rows[0].productImageProposal?.status).not.toBe("IMAGE_FOUND");
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(rows[0].productImageProposal?.attempt?.imageDownloadAttempted).toBe(
      false
    );
  });

  it("keeps a provider failure distinct from missing provider configuration", async () => {
    mockSafeFetch.mockResolvedValue({
      buffer: Buffer.from('{"results":[]}'),
      contentType: "application/json",
    });
    const provider: ProductSearchProvider = {
      name: "BRAVE_WEB_SEARCH",
      search: vi.fn(() => Promise.reject(new Error("HTTP 401"))),
    };
    const { rows } = await enrichImportProductRows(
      [buildRow()],
      [],
      undefined,
      provider
    );
    expect(rows[0].productImageProposal).toMatchObject({
      failureReason: "SEARCH_FAILED",
      attempt: { searchAttempted: true, searchProvider: "BRAVE_WEB_SEARCH" },
    });
  });

  it("accepts structured product page image metadata after identity validation", async () => {
    const bytes = await pngFixture();
    const page = Buffer.from(
      `<html><script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Arduino Nano",
        brand: { "@type": "Brand", name: "Arduino" },
        mpn: "A000005",
        image: "https://www.arduino.cc/images/nano.png",
      })}</script></html>`
    );
    mockSafeFetch.mockImplementation((url: string) =>
      url === "https://www.arduino.cc/nano"
        ? { buffer: page, contentType: "text/html; charset=utf-8" }
        : { buffer: bytes, contentType: "image/png" }
    );
    const { rows } = await enrichImportProductRows(
      [buildRow({ productUrl: "https://www.arduino.cc/nano" })],
      []
    );
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_FOUND");
    expect(rows[0].productImageProposal?.source).toBe("MANUFACTURER");
    expect(mockSafeFetch).toHaveBeenCalledTimes(2);
  });

  it("accepts OpenGraph product images only when the page title matches", async () => {
    const bytes = await pngFixture();
    const page = Buffer.from(
      '<html><meta property="og:title" content="Arduino Nano"><meta property="og:image" content="https://www.arduino.cc/nano.png"></html>'
    );
    mockSafeFetch.mockImplementation((url: string) =>
      url === "https://www.arduino.cc/nano"
        ? { buffer: page, contentType: "text/html" }
        : { buffer: bytes, contentType: "image/png" }
    );
    const { rows } = await enrichImportProductRows(
      [buildRow({ productUrl: "https://www.arduino.cc/nano" })],
      []
    );
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_FOUND");
    expect(rows[0].productImageProposal?.source).toBe("MANUFACTURER");
  });

  it("accepts an exact manufacturer and MPN candidate", async () => {
    const bytes = await pngFixture();
    mockSafeFetch
      .mockResolvedValueOnce(
        openverseResponse({
          title: "A000005",
          creator: "Arduino",
          tags: [{ name: "printed circuit board" }],
        })
      )
      .mockResolvedValueOnce({ buffer: bytes, contentType: "image/png" });
    const { rows } = await enrichImportProductRows([buildRow()], []);
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_FOUND");
    expect(rows[0].productImageProposal?.source).toBe("OPENVERSE");
  });

  it("does not accept a structured product page for a different MPN", async () => {
    const page = Buffer.from(
      `<html><script type="application/ld+json">${JSON.stringify({
        "@type": "Product",
        name: "Arduino Nano",
        brand: { "@type": "Brand", name: "Arduino" },
        mpn: "OTHER-123",
        image: "https://manufacturer.example.org/images/nano.png",
      })}</script></html>`
    );
    mockSafeFetch.mockImplementation((url: string) =>
      url === "https://manufacturer.example.org/nano"
        ? { buffer: page, contentType: "text/html" }
        : openverseResponse({
            title: "Electronics development board",
            creator: "Arduino",
            tags: [{ name: "electronics" }],
          })
    );
    const { rows } = await enrichImportProductRows(
      [buildRow({ productUrl: "https://manufacturer.example.org/nano" })],
      []
    );
    expect(rows[0].productImageProposal?.status).toBe("IMAGE_AMBIGUOUS");
    expect(rows[0].productImageProposal?.failureReason).toBe(
      "IDENTITY_MISMATCH"
    );
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
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

  it("normalizes an uploaded JPEG, PNG, or WebP for review", async () => {
    const bytes = await pngFixture();
    const proposal = await processStaffImportImageUpload(bytes, "image/png");
    expect(proposal.status).toBe("IMAGE_FOUND");
    expect(proposal.source).toBe("MANUAL_UPLOAD");
    expect(proposal.dataBase64).toBeTruthy();
    expect(
      Buffer.from(proposal.dataBase64 ?? "", "base64").byteLength
    ).toBeLessThanOrEqual(64 * 1024);
  });

  it.each([
    ["HTML", Buffer.from("<html>nope</html>"), "text/html"],
    ["unsupported MIME", Buffer.from("not image bytes"), "image/svg+xml"],
  ])("rejects manual image upload with %s", async (_name, bytes, mime) => {
    await expect(
      processStaffImportImageUpload(bytes as Buffer, mime as string)
    ).rejects.toThrow();
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
