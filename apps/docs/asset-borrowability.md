# Staff inventory borrowing control

Shelf already represents this policy with `Asset.availableToBook` (default true).
The staff edit form's **Can't borrow** control writes its inverse. No schema,
migration or environment change is required. The control does not write quantity,
location, visibility, archive markers, custody or checkout status.

The control is the first setting under **Advanced options → Borrowing** in
the IOIO asset edit form. Untouched forms omit the field so older clients and mixed grouped products
retain their saved values. An explicit edit on a grouped product applies to every
active physical unit. Reloading initializes the control from saved canonical data.
An unresolved issue report still prevents re-enabling borrowing; the control does
not resolve or remove that report.

Student discovery still includes non-borrowable items when ordinary visibility
and archive rules allow them. Catalog cards and the shared detail/assistant borrow
button say **Not available for borrowing**. A stale borrow-list entry can be removed.
QR lookup retains the normal detail destination, which uses that same button.

Server enforcement uses the canonical flag:

- Model reservation capacity excludes non-borrowable units.
- Existing reservation validation in `reserveBooking` checks current member flags.
- Student proposal/confirmation checks refuse non-borrowable stock; individual
  product borrowing validates the selected physical units independently.
- `checkoutBookingWritesWithinTx` checks every asset, including kit members and
  fulfil-and-checkout requests, before canonical checkout writes.
- `checkOutQuantity`, `bulkCheckOutAssets`, single-asset custody assignment and
  `bulkAssignKitCustody` reject non-borrowable stock at their write boundaries.
- Normal check-in and custody release remain available.

Automatic interpretation of free-form import notes was not added. Existing CSV
`bookable=no` support remains the canonical import mechanism.

## Files

- `apps/webapp/app/components/assets/borrowability-field.tsx`
- `apps/webapp/app/components/assets/borrowability-field.test.tsx`
- `apps/webapp/app/components/assets/ioio-asset-create-form.tsx`
- `apps/webapp/app/components/assets/form.tsx`
- `apps/webapp/app/modules/asset/borrowability.ts`
- `apps/webapp/app/modules/asset/borrowability.server.ts`
- `apps/webapp/app/modules/asset/types.ts`
- `apps/webapp/app/modules/asset/service.server.ts`
- `apps/webapp/app/modules/asset/service.server.test.ts`
- `apps/webapp/app/modules/booking/service.server.ts`
- `apps/webapp/app/modules/booking/service.server.test.ts`
- `apps/webapp/app/modules/kit/service.server.ts`
- `apps/webapp/app/modules/booking-model-request/service.server.ts`
- `apps/webapp/app/modules/booking-model-request/service.server.test.ts`
- `apps/webapp/app/modules/ioio-student/borrow-item.server.ts`
- `apps/webapp/app/modules/ioio-student/borrow-item.server.test.ts`
- `apps/webapp/app/modules/ioio-student/service.server.test.ts`
- `apps/webapp/app/components/ioio-student/student-ui.tsx`
- `apps/webapp/app/components/ioio-student/student-ui.test.ts`
- `apps/webapp/app/routes/_layout+/assets.$assetId_.edit.tsx`
- `apps/webapp/app/routes/_layout+/assets.$assetId.overview.assign-custody.tsx`
- `apps/webapp/test/routes-tests/_layout+/assets.$assetId_.edit.clear-image.test.ts`
- `apps/webapp/test/routes-tests/assets.$assetId.overview.assign-custody.test.tsx`
- `apps/webapp/test/routes-tests/api+/ioio.inventory-qr.test.ts`
- `apps/docs/asset-borrowability.md`

The core asset/booking/kit services and asset edit route are upstream-owned files
and are the most likely future merge-conflict points. This change was verified
locally; no live inventory was edited to test it.

## Validation

Twelve focused suites passed 999 tests (one skipped), including staff edit and
reload state, both flag values, stock/custody preservation, student discovery,
direct borrow rejection, canonical checkout refusal, model reservation refusal,
and QR detail routing. ESLint, Prettier and `git diff --check` passed.

The full TypeScript check continues to report existing edit-parser errors for
unrelated advanced settings (`requiresBorrowApproval`, preparation/photo flags,
and borrow-day limits), plus other existing repository diagnostics. Comparison
with the preceding image-task check confirmed those errors predate this change;
no new borrowing-control diagnostics were reported. This feature has not been
deployed or tested by changing live inventory.

## Staff edit layout

The normal edit area has no Can't borrow toggle or Unit of measure field.
Expand Advanced options, then use Can't borrow directly beneath the Borrowing
heading, before Maximum borrowing period. Enabled mode says “Lab use only —
this item cannot be borrowed.” Maximum borrowing period, Extension period,
Staff preparation and Return section controls are hidden until borrowing is
re-enabled. Their inputs stay mounted and retain their values; Description and
Min quantity remain accessible. There is no separate approval control rendered
by this form, and existing approval flags and server guards are unchanged.

`Asset.unitOfMeasure` remains in the database and other consumers. Editing omits
this field rather than clearing it. Creation still uses the existing field.
Borrowability still writes only `Asset.availableToBook`; visibility, archive,
physical status and staff/student access semantics are unchanged. No migration
is required.

Layout follow-up files:

- `apps/webapp/app/components/assets/advanced-options.tsx`
- `apps/webapp/app/components/assets/borrowability-field.tsx`
- `apps/webapp/app/components/assets/ioio-asset-create-form.tsx`
- `apps/webapp/app/components/assets/ioio-asset-create-form.test.tsx`
- `apps/webapp/test/routes-tests/_layout+/assets.$assetId_.edit.clear-image.test.ts`
- `apps/docs/asset-borrowability.md`

Focused regressions cover Advanced placement, absent Unit of measure controls,
unchanged creation UI, persisted lab-use state, hidden/restored borrowing settings
and unchanged form values. Existing route persistence, student visibility and
direct server borrow refusal suites verify the canonical behavior still applies.
Likely upstream conflicts are confined to the IOIO edit form and shared advanced
fields/borrowability component. No server or database implementation was changed.

The layout follow-up passed 99 tests across six focused suites, plus ESLint,
Prettier and `git diff --check`.

## Detail availability presentation

Staff and student detail routes pass canonical `availableToBook` into the shared
`IoioAssetDetailLayout`. When false, Availability reads **Not available to borrow**
with secondary text **Lab use only**, replacing numeric availability summaries.
When true, existing counts return. Student catalog/assistant and checkout labels
use the same terminology; assistant cards suppress the available count for
restricted stock. Quantity, visibility and server guards are unchanged.
No migration or environment changes are required.

Student browse cards now stretch to the grid row height with a flex-column body,
two-line title/location space and a shared minimum-height footer pushed to the
bottom. Lab-use cards show non-interactive restriction text in that footer, with
no disabled Borrow button. Loan/unavailable/approval states use the same footer.
Image sizing, title clamping and responsive grid breakpoints are preserved.
