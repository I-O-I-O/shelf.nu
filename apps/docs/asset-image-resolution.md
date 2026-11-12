# Shared asset image resolution

## Private server image delivery follow-up

Live inspection confirmed that Shelf's HTTPS page received HTTP Storage URLs
containing an IP address and private port. Storage signing succeeded and the
objects were readable server-side, but those image sources cross the browser's
mixed-content boundary. No canonical image path was missing from the inspected
staff/student queries. The database had seven asset main-image paths; all seven
originals and their thumbnails were downloadable from private Storage.

Asset web read boundaries now return `/api/asset-image` URLs scoped to the asset
and image variant. The authenticated resource loader checks workspace ownership,
student visibility and active archive markers, reads the current canonical path,
and downloads bytes through Shelf's Supabase admin client. It derives Content-Type
from raster signatures, rejects non-image responses, and never redirects to
Storage. Failed delivery logs asset ID, model ID when inherited, object path,
variant, failure class and status, without signed URLs, tokens or error payloads.
Replacement paths change the URL version; no-image rows remain placeholders.
Legacy repair endpoints cannot overwrite a proxy source with an internal URL.
Native/mobile re-signing retains its existing behavior.

Live verification used existing browser sessions through native browser control:
staff inventory thumbnail, staff detail image and reload, student inventory
thumbnail and reload, and direct student image delivery all displayed the cable
asset correctly. Firefox Network Monitor confirmed HTTPS same-origin delivery:
200 OK, image/webp, 16,080 response bytes, with no Storage redirect. The adjacent
asset without an image retained its placeholder. Actual replacement of a live
asset was not performed; replacement identity and revalidation are covered by
focused automated tests. No canonical inventory records or Storage objects were
changed by these checks.

The patch is applied to the running development worktree and loaded by Vite.
No schema or environment change, public Supabase exposure, or helper restart is
required. Production builds must deploy/restart the webapp normally. The likely
upstream conflicts remain the asset service, shared Storage utility and image
component; new proxy files are localized.

The focused follow-up suites passed 316 tests (one skipped). ESLint, Prettier,
and `git diff --check` passed. The full TypeScript program still has unrelated
repository errors; none are reported in the changed image files.

Follow-up files:

- `apps/webapp/app/modules/asset/image-proxy.server.ts` (new)
- `apps/webapp/app/routes/api+/asset-image.ts` (new)
- `apps/webapp/app/modules/asset/service.server.ts`
- `apps/webapp/app/utils/storage.server.ts`
- `apps/webapp/app/components/assets/asset-image/component.tsx`
- `apps/webapp/app/modules/asset/service.server.test.ts`
- `apps/webapp/app/components/assets/asset-image/component.test.tsx`
- `apps/webapp/test/routes-tests/api+/asset-image.test.ts` (new)
- `apps/docs/asset-image-resolution.md`

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
