import sharp from "sharp";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { updateAssetModelImage } from "~/modules/asset-model/service.server";
import {
  persistImportProductImage,
  readImportProductImage,
} from "./import-product-image.server";
import { enrichImportProductRows } from "./product-enrichment.server";
import type {
  ImportProductEnrichmentRow,
  ProductSearchProvider,
} from "./product-enrichment.server";

const mocks = vi.hoisted(() => ({
  modelFind: vi.fn(),
  modelUpdate: vi.fn(),
  imageUpsert: vi.fn(),
  imageFind: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));
// why: database and Supabase are external persistence; keep actual metadata,
// preview, multipart parsing, resizing, and canonical attachment code in this test.
vi.mock("~/database/db.server", () => ({
  db: {
    assetModel: { findFirst: mocks.modelFind, updateMany: mocks.modelUpdate },
    image: { upsert: mocks.imageUpsert, findFirst: mocks.imageFind },
  },
}));
// why: record the real encoded bytes sent by the canonical storage service,
// without accessing a live bucket or requiring service credentials.
vi.mock("~/integrations/supabase/client", () => ({
  getSupabaseAdmin: () => ({
    storage: {
      from: () => ({
        upload: mocks.upload,
        remove: mocks.remove,
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://storage.example.test/files/${path}` },
        }),
      }),
    },
  }),
}));

const model = {
  id: "new-model",
  organizationId: "org-1",
  image: null as string | null,
  thumbnailImage: null as string | null,
  imageStoragePath: null as string | null,
  thumbnailImageStoragePath: null as string | null,
};
const previews = new Map<
  string,
  { id: string; ownerOrgId: string; blob: Buffer }
>();
beforeEach(() => {
  vi.clearAllMocks();
  previews.clear();
  Object.assign(model, {
    image: null,
    thumbnailImage: null,
    imageStoragePath: null,
    thumbnailImageStoragePath: null,
  });
  mocks.modelFind.mockImplementation(({ where }) =>
    where.id === model.id && where.organizationId === model.organizationId
      ? { ...model }
      : null
  );
  mocks.modelUpdate.mockImplementation(({ where, data }) => {
    if (
      where.id !== model.id ||
      where.organizationId !== model.organizationId ||
      model.image
    )
      return { count: 0 };
    Object.assign(model, data);
    return { count: 1 };
  });
  mocks.imageUpsert.mockImplementation(({ where, create }) => {
    if (!previews.has(where.id)) previews.set(where.id, create);
    return previews.get(where.id);
  });
  mocks.imageFind.mockImplementation(({ where }) =>
    previews.get(where.id)?.ownerOrgId === where.ownerOrgId
      ? previews.get(where.id)
      : null
  );
  mocks.upload.mockImplementation((path: string) =>
    Promise.resolve({ data: { path }, error: null })
  );
  mocks.remove.mockResolvedValue({ error: null });
});
afterEach(() => vi.restoreAllMocks());

it("takes text identity through search, persisted preview and the real canonical model image service", async () => {
  const identity: ImportProductEnrichmentRow = {
    rowNumber: 2,
    title: "XIAO ESP32-S3 Sense",
    manufacturer: "Seeed Studio",
    manufacturerPartNumber: "113991115",
    sourceDescription: null,
  };
  const pageUrl = "https://www.seeedstudio.com/XIAO-ESP32S3-Sense-p-5639.html";
  const imageUrl = "https://media.seeedstudio.com/sense-product.png";
  const page = JSON.stringify({
    "@type": "Product",
    name: identity.title,
    brand: { name: identity.manufacturer },
    sku: identity.manufacturerPartNumber,
    image: imageUrl,
  });
  const source = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "#abc" },
  })
    .png()
    .toBuffer();
  // why: product pages and images are external HTTP dependencies; mocked
  // Responses pass through the actual SSRF-safe fetch and image decoder.
  vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
    Promise.resolve(
      String(input) === pageUrl
        ? new Response(`<script type="application/ld+json">${page}</script>`, {
            headers: { "content-type": "text/html" },
          })
        : new Response(source, { headers: { "content-type": "image/png" } })
    )
  );
  // why: the search subscription is external; its request/result metadata is
  // fixed while all subsequent normalization and attachment remain real.
  const provider: ProductSearchProvider = {
    name: "MOCK_WEB_SEARCH",
    search: vi.fn(() =>
      Promise.resolve([
        {
          productPageUrl: pageUrl,
          title: "Seeed Studio XIAO ESP32-S3 Sense 113991115",
          description: "Official manufacturer product",
          sourceDomain: "www.seeedstudio.com",
        },
      ])
    ),
  };
  const { rows } = await enrichImportProductRows(
    [identity],
    [],
    undefined,
    provider
  );
  const proposal = await persistImportProductImage({
    image: rows[0].productImageProposal!,
    operationId: "operation-1",
    organizationId: "org-1",
    userId: "staff-1",
  });
  expect(proposal.status).toBe("IMAGE_FOUND");
  expect(proposal.dataBase64).toBeUndefined();
  expect(previews.size).toBe(1);
  const bytes = await readImportProductImage(proposal.imageId!, "org-1");
  const request = () => {
    const form = new FormData();
    form.set(
      "image",
      new File([new Uint8Array(bytes)], "product.webp", { type: "image/webp" })
    );
    return new Request("http://localhost/import-image", {
      method: "POST",
      body: form,
    });
  };
  const url = await updateAssetModelImage({
    request: request(),
    assetModelId: model.id,
    organizationId: "org-1",
    onlyIfMissing: true,
    maxProcessedBytes: 2 * 1024 * 1024,
  });
  expect(url).toBeTruthy();
  expect(model.image).toBe(url);
  expect(model.imageStoragePath).toBeTruthy();
  expect(model.thumbnailImageStoragePath).toBeTruthy();
  expect(mocks.upload).toHaveBeenCalledTimes(2);
  for (const [, uploaded] of mocks.upload.mock.calls) {
    expect(uploaded.byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect((await sharp(uploaded).metadata()).format).toBe("webp");
  }
  expect(
    await updateAssetModelImage({
      request: request(),
      assetModelId: model.id,
      organizationId: "org-1",
      onlyIfMissing: true,
      maxProcessedBytes: 2 * 1024 * 1024,
    })
  ).toBeNull();
  expect(mocks.upload).toHaveBeenCalledTimes(2);
});
