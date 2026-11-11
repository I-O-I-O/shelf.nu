# Shared asset image resolution

## Confirmed code defects

Image uploads store `Asset.mainImageStoragePath` /
`thumbnailImageStoragePath` and clear the corresponding legacy URL fields.
AssetModel uploads do the same with `imageStoragePath` /
`thumbnailImageStoragePath`. AssetModel objects use `PUBLIC_BUCKET` (`files`);
asset objects use the existing private `assets` bucket.

The advanced inventory SQL projected and serialized only legacy URLs, and its
read service did not resolve canonical paths. Model rollups also omitted both
canonical paths. Several booking, kit, audit, report and API selects omitted
asset paths, and some read boundaries serialized raw rows. Null legacy URLs
therefore became placeholders despite stored image paths.

The student inventory already selected canonical paths, but its batch resolver
could reject for one failed thumbnail. The student service then fell back to
the entire unresolved batch, whose path-only rows still had null URLs.

The shared Storage resolver signed private images on every read. Tokens could
change on every loader/SSE revalidation. Concurrent and repeated signatures
are now coalesced in a bounded, process-local cache (one hour, below the
72-hour signature lifetime). Failures are evicted and log bucket/object
identity without credentials. Public model URLs remain public Storage URLs;
external legacy image URLs remain supported. No network endpoints are hardcoded.

AssetImage also retained repair results until the asset ID changed. Replacing
an image on the same asset could keep showing the old repaired URL. Its reset
now follows object identity, ignoring Supabase signature query changes. Repair
requests no longer cover an already displayed image with a loading overlay,
and no-image placeholders have no loading overlay. Lazy loading and async
decoding remain enabled. No random image keys or timestamp cache busters are
introduced.

## Validation limits

The 18 focused suites passed 1,114 tests (one skipped), with two further
component regressions covering background generation and no-image overlays.
Focused tests exercise SQL projections, path-only asset/model resolution,
signature reuse and retry, isolated thumbnail failures, replacement after a
repair, DOM/source stability on revalidation, and existing student, booking,
kit, API and authorization behavior. Tests use external-storage mocks and do
not establish real browser reachability of a deployment's Supabase URL.

Live upload/save/reload and visual SSE verification could not be completed:
there was no accessible development database (Prisma initialization failed),
and native browser control refused the inventory-tab switch due to detected
user activity. No deployment or production data changes were performed.
The initial TypeScript check exhausted its heap; the larger-heap retry was
stopped after more than four minutes without a result.

After deploying, verify one image-bearing asset in staff list/detail and
student inventory, a model cover in model detail/rollup, and booking/checkout.
Record the actual image request URL and HTTP Content-Type, trigger SSE/loader
revalidation, then replace the asset/model cover and save/reload. Check that a
no-image asset remains a stable placeholder. Confirm storage URLs are browser
reachable before attributing any remaining failure to networking.

No schema, migration or environment changes are required by this patch.
Upstream merge conflicts are most likely in asset query/service code,
booking/kit services and shared select constants.

## Changed files

- `apps/webapp/app/components/assets/asset-image/component.test.tsx`
- `apps/webapp/app/components/assets/asset-image/component.tsx`
- `apps/webapp/app/modules/api/mobile-auth.server.ts`
- `apps/webapp/app/modules/asset-model/rollup.server.test.ts`
- `apps/webapp/app/modules/asset-model/rollup.server.ts`
- `apps/webapp/app/modules/asset/query.server.test.ts`
- `apps/webapp/app/modules/asset/query.server.ts`
- `apps/webapp/app/modules/asset/service.server.test.ts`
- `apps/webapp/app/modules/asset/service.server.ts`
- `apps/webapp/app/modules/asset/types.ts`
- `apps/webapp/app/modules/audit/service.server.ts`
- `apps/webapp/app/modules/booking/constants.ts`
- `apps/webapp/app/modules/booking/service.server.ts`
- `apps/webapp/app/modules/kit/service.server.ts`
- `apps/webapp/app/modules/kit/types.ts`
- `apps/webapp/app/modules/reports/helpers.server.ts`
- `apps/webapp/app/routes/_layout+/bookings.return-check.$operationId.tsx`
- `apps/webapp/app/routes/api+/assets.tsx`
- `apps/webapp/app/routes/api+/bookings.$bookingId.assets-sidebar.ts`
- `apps/webapp/app/routes/api+/kits.tsx`
- `apps/webapp/app/routes/api+/mobile+/assets.$assetId.ts`
- `apps/webapp/app/routes/api+/mobile+/assets.ts`
- `apps/webapp/app/routes/api+/mobile+/bookings.$bookingId.ts`
- `apps/webapp/app/routes/api+/mobile+/dashboard.ts`
- `apps/webapp/app/routes/api+/mobile+/kits.$kitId.ts`
- `apps/webapp/app/utils/storage.server.test.ts`
- `apps/webapp/app/utils/storage.server.ts`
- `apps/webapp/test/routes-tests/api+/assets.test.tsx`
- `apps/webapp/test/routes-tests/api+/bookings.$bookingId.assets-sidebar.test.ts`
- `apps/webapp/test/routes-tests/api+/kits.test.tsx`
- `apps/docs/asset-image-resolution.md` (this report)
