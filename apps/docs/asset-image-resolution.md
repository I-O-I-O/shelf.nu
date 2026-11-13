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

## Detail page content order

Staff `/assets/:assetId/overview` renders `StaffItemDetail`, which uses
`IoioAssetDetailLayout`. Student `/ioio/browse/:assetId` uses that same layout.
Previously its default placed staff descriptions in the header, while the student
route selected a separate below-details placement. The shared component now has
one order: title/actions, image and Details in the top row, full-width Description below.
The student route no longer needs a placement override.

On desktop, Image and Details are equal-height top-row cards, with Description
spanning both columns below. Smaller screens stack Image → Details → Description.
The image renderer, responsive image dimensions, preview/lightbox, placeholder,
contents and physical-unit panels are retained. Empty descriptions are omitted;
long descriptions appear exactly once below the image, with whitespace preserved.
Availability and status remain in the Details sidebar; the redundant title-area
summary (`Available · Availability: 3 / 3 items available`) is removed.

Follow-up files:

- `apps/webapp/app/components/ioio-staff/ioio-asset-detail-layout.tsx`
- `apps/webapp/app/components/ioio-staff/ioio-asset-detail-layout.test.tsx`
- `apps/webapp/app/components/ioio-staff/staff-item-detail.test.tsx`
- `apps/webapp/app/components/ioio-staff/staff-asset-detail-shell.test.tsx`
- `apps/webapp/app/routes/_layout+/ioio.browse.$assetId.tsx`
- `apps/docs/asset-image-resolution.md`

Focused UI regressions check ordering for staff and student layouts, very long
text, absent images, empty descriptions, one image region/description, responsive
column classes, retained panels and the existing preview component behavior.
No database change or migration is required. The shared detail layout and student
route are the likely upstream merge-conflict points for this follow-up.

## Detail card alignment polish

The shared staff/student layout is one responsive grid with three direct children:
Image, Details and Description. Desktop uses two columns. `items-stretch` makes
both top-row cards fill the same grid row height, determined by the taller card;
there is no fixed image height or image stretching. The existing renderer retains
`object-contain`, intrinsic sizing limits, and the preview/lightbox behavior.

Description uses `lg:col-span-2` to span the image column, gap and Details column
in the next row, sharing the grid's outer left/right edges. `gap-4` preserves the
card spacing. Below the desktop breakpoint, the grid has one column and natural
row heights, in Image → Details → Description order.

Existing card borders, radius, background, shadow and responsive padding are
unchanged. The Description body retains its `110ch` reading-width limit, natural
wrapping and original text. Page margins and the `max-w-7xl` limit are retained.

This layout follow-up changes `ioio-asset-detail-layout.tsx`, its UI regression
test, `staff-item-detail.test.tsx`, and this document. Image previews, description text, asset data and borrowing
logic are unchanged. No migration is required. The shared detail layout is the
likely merge-conflict point.

Polish validation: 41 focused UI tests passed across four suites; ESLint,
Prettier and `git diff --check` passed.
