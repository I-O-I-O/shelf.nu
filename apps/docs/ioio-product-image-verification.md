# Verify automatic import images in development

The product-page search adapter is `BraveProductSearchProvider` in `apps/webapp/app/modules/ioio-staff/product-enrichment.server.ts`. It calls the real Brave Web Search API at `https://api.search.brave.com/res/v1/web/search`. It sends the server-only `BRAVE_SEARCH_API_KEY` in `X-Subscription-Token`; that key is never sent to result pages, images, the browser, or the isolated Claude helper.

## Configuration

Put a valid Brave Search subscription key in the repository root `.env` as `BRAVE_SEARCH_API_KEY`. Do not put it in source files or client environment configuration. Restart the development server after setting it. A full Apply check also needs the application's normal development configuration from `.env.example`, including `DATABASE_URL`, `DIRECT_URL`, `SUPABASE_URL`, `SUPABASE_ANON_PUBLIC`, and `SUPABASE_SERVICE_ROLE`. Use the intended development workspace, never production.

Optional server configuration:

- `IOIO_PRODUCT_IMAGE_MANUFACTURER_DOMAINS`: verified JSON aliases such as `{"UNI-T":["uni-trend.com"]}`. Used by manufacturer-domain ranking and identity evidence.
- `IOIO_PRODUCT_IMAGE_TRUSTED_DISTRIBUTOR_DOMAINS`: comma-separated distributor domains. Used by source ranking.

## Identity correction for the Seeed acceptance example

Seeed's official product pages identify **XIAO ESP32-S3 Sense as SKU 113991115** and **XIAO ESP32-S3 as SKU 113991114**. Use one consistent pair. An invoice combining “Sense” and 113991114 should not automatically receive either variant's image; the discrepancy needs staff review.

Official pages:

- https://www.seeedstudio.com/XIAO-ESP32S3-Sense-p-5639.html
- https://www.seeedstudio.com/XIAO-ESP32S3-p-5627.html

The Sense page uses encoded OpenGraph attributes and JSON-LD with raw line breaks inside its description string. The parser handles those without executing scripts.

## Real lookup probe

From the repository root, run:

```sh
pnpm --filter @shelf/webapp exec node --import tsx scripts/check-import-product-image.ts
```

This uses the actual configured provider and actual network fetching. It defaults to Seeed Studio / XIAO ESP32-S3 Sense / 113991115 and contains no image or product URL. It prints only status, source, identity evidence and bounded-attempt diagnostics. It makes no database or storage writes. `IMAGE_FOUND`, `imageDownloadAttempted: true`, `imageProcessed: true`, and `finalBytes <= 2097152` verify lookup and processing only. A missing key prints `SEARCH_PROVIDER_NOT_CONFIGURED` and exits with code 2.

## PDF → proposal → Apply

1. Start `pnpm webapp:dev` with the configured development environment.
2. Import a text PDF invoice containing manufacturer Seeed Studio, product XIAO ESP32-S3 Sense, SKU 113991115, and received quantity 5. Include no product or image URLs.
3. Check the `ioio_staff_import_image_attempt` event: real provider, search attempted/results, selected manufacturer page, metadata found, download bytes, processed bytes, and `proposalImageStored: true`.
4. Before Apply, confirm the actual thumbnail and “Found automatically” source details. A missing image must say “No reliable image found” and show its reason in details.
5. Reload. Save for later, leave, and reopen the same operation. The thumbnail must remain: automatic preview bytes live in Shelf's org-owned Image table; the operation stores only the image ID and metadata. Its `/api/image/:imageId` preview uses the existing authenticated organization check.
6. Import only this ready row from a multi-row proposal. Check `ioio_staff_import_image_apply` for the correct target ID, `applyImageUploaded: true` and `applyImageAttached: true`. Remaining rows and their references must remain available.
7. Open the imported inventory record and verify its actual stored image. Retry the imported row and confirm the ledger prevents another inventory/image upload.

### Canonical tracking boundary

Shelf currently prohibits an AssetModel link on a quantity-tracked Asset. A component imported with quantity 5 therefore stores its image on the canonical stock Asset using `updateAssetMainImage` and the `mainImage` multipart field. It does not create an AssetModel or QR assets to obtain an image. For a genuine individually tracked model, `updateAssetModelImage` receives the `image` field and attaches its image to that model, preserving existing images with `onlyIfMissing`.

An acceptance requirement that _quantity-tracked stock itself must have an AssetModel image_ requires a separate change to Shelf's canonical model-link rules. This implementation does not bypass that rule.

## Persistence, size and failure diagnostics

Automatic previews are static WebP, at most 128 KiB. They use deterministic Image IDs per organization, user, operation and bytes, so repeated persistence reuses a record. Previews are retained beyond the 24-hour proposal lifetime; subsequent imports prune only the current user's unlinked import previews older than 48 hours. A missing/failed preview leaves the product importable and reports `PROPOSAL_IMAGE_PERSIST_FAILED`. Manual previews remain bounded at 64 KiB.

External download limits remain 8 MiB per source image, 2 MiB per page, and 512 KiB per search response; network calls have a five-second timeout and five redirects maximum. SSRF checks cover DNS resolution and every redirect. Source MIME and image signatures must match JPEG, PNG or WebP. Sharp bounds input pixels, resizes and compresses. Apply additionally passes `maxProcessedBytes: 2097152` through the canonical upload service, so processed original/thumbnail bytes are checked before their storage writes.

Lookup attempts record `productIdentityBuilt`, `searchAttempted`, `searchProvider`, `searchResultCount`, `selectedProductPage`, `imageMetadataFound`, `imageDownloadAttempted`, `downloadBytes`, `imageProcessed`, `finalBytes`, and `proposalImageStored`. Apply events record target IDs and upload/attachment outcomes. Never log credentials or image bytes.

Failure reasons include `SEARCH_PROVIDER_NOT_CONFIGURED`, `SEARCH_FAILED`, `SEARCH_NO_RESULTS`, `NO_TRUSTED_PRODUCT_MATCH`, `IDENTITY_MISMATCH`, `NO_PRODUCT_IMAGE_METADATA`, `IMAGE_DOWNLOAD_FAILED`, `IMAGE_TOO_LARGE`, `IMAGE_PROCESSING_FAILED`, `PROPOSAL_IMAGE_PERSIST_FAILED`, and `APPLY_IMAGE_UPLOAD_FAILED`. Failure is not an import failure and must not be reported as an attached image.

## Audit probe recorded in this checkout

The real official Sense product page returned HTTP 200 (1,038,995 downloaded bytes). Its structured primary JPEG returned HTTP 200, `image/jpeg`, 16,760 bytes, 600 × 450 pixels. An isolated Sharp probe produced a 10,256-byte proposal WebP; canonical-style 800px/quality-80 processing produced 10,840 bytes. These are real page/image downloads and processing measurements, **not a successful Brave search or storage/Apply verification**. The actual provider probe exited with `SEARCH_PROVIDER_NOT_CONFIGURED` because `BRAVE_SEARCH_API_KEY` was absent. Development database/storage configuration was also absent, so no live model attachment was performed.
