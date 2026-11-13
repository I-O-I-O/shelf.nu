# Clipboard images in inventory edit

The existing asset/model image paste hook listened only on the owning form and
read only clipboard `items`. Pasting after opening Edit with page focus missed
the form listener; browsers exposing images through clipboard `files` were also
ignored. Handbook already supported both representations.

`getClipboardImage` now shares that extraction behavior between Handbook and the
inventory image fields. The existing hook listens at document scope and routes
page-focused images only to a single visible image form. Other forms, hidden or
inert queued drafts and page-focused paste beneath an open dialog are excluded.
Text-only paste is never prevented. Pasting within a specific form stays scoped
to that form.

Both IOIO and Shelf image fields already use this hook, including asset-model
edit. No additional upload endpoint or storage system was added. The existing
`/api/inventory-image-upload` action checks staff/update permissions and workspace
ownership, then calls `updateAssetMainImage` or `updateAssetModelImage`. These
services validate/process images, upload originals/thumbnails, persist canonical
Storage paths, and remove old objects after the replacement is saved. No base64
or blob URL is persisted. Object URLs are transient browser previews only.

Existing validation accepts PNG, JPEG and WebP, with the asset/model 8 MiB limit
(the client requires files strictly smaller than 8 MiB). Unsupported and oversized
clipboard images use the existing validation error. Upload/loading copy and Save
blocking remain in the shared hook. The old selection/preview remains until the
upload succeeds; failed and non-JSON HTTP responses show an error without
replacing it. A second successful paste replaces the first image. New, unsaved
assets still stage their image for Save because no canonical asset ID exists yet.

## Local browser verification

Verified on the Mac against the actual development server on port 3000, whose
working directory was this worktree's `apps/webapp`. Created a dedicated local
asset **Clipboard paste QA local** (`cmweslvv90000xm5ppjydfthw`); existing
inventory assets were not edited.

1. Opened a generated red PNG in macOS Preview; selected/copied its pixels with
   Cmd+A, Cmd+C.
2. Opened asset edit in Firefox, clicked the page heading outside the form and
   pressed Cmd+V. The image uploaded immediately and its preview appeared.
3. Clicked Save, then reloaded Inventory. The red image remained visible.
4. Reopened Edit. Copied a blue PNG from Preview, pasted with page focus and
   saved. Reloaded Inventory and opened the persisted image in a new browser tab.
5. Firefox displayed the blue 96×96 WebP from this browser-visible URL:

```text
http://localhost:3000/api/asset-image?assetId=cmweslvv90000xm5ppjydfthw&variant=main&v=bb7c00853141b812f18d
```

This proves clipboard upload, canonical server processing, Save, reload and
replacement locally. The QA asset remains locally for inspection. Asset-model
routing/permissions and upload/error behavior are covered by focused tests;
model editing was inspected but not separately exercised in the browser.
No remote server, production, migration, seed, reset or deployment was used.

## Changed files

- `apps/webapp/app/utils/clipboard-image.ts`
- `apps/webapp/app/utils/clipboard-image.test.ts`
- `apps/webapp/app/components/forms/use-image-paste.ts`
- `apps/webapp/app/components/editor-v2/hooks/use-editor-view.ts`
- `apps/webapp/app/components/ioio/ioio-image-picker.test.tsx`
- `apps/docs/clipboard-inventory-images.md`

Six focused suites passed 66 tests. ESLint, Prettier and `git diff --check`
passed. The suites cover both image fields, the shared extractor, image upload API,
asset edit Save/clear precedence and editor helpers. No schema change or migration
is required. Likely upstream merge conflicts are in the shared image-paste hook
and editor paste handler; canonical asset/model services were not changed.
