# Staff spreadsheet inventory import

The staff CSV/XLSX path normalizes to `StaffImportRow`, then shares PDF category/location resolution, asset matching, `StaffImportProposal`, review, the import ledger and canonical Apply services. No schema changes are needed.

CSV uses csv-parse for comma, semicolon and tab detection, BOM handling and quoted fields. XLSX reads stored XML values across sheets, including formula caches; formulas are never evaluated. Macros and external workbook links remain rejected.

Header detection examines the first 40 rows for multiple known concepts and nearby data. Clear inventory tables are included automatically; Notes/Instructions sheets are skipped. Staff can specify a sheet and header row under Spreadsheet options before uploading again. Duplicate/ambiguous column layouts and invalid rows remain visible for review. Metadata, blanks, totals, VAT and freight are excluded.

Spreadsheet rows preserve source sheet/row, raw description, manufacturer, supplier SKU, MPN and quantities. Received/shipped quantities take precedence; ordered-only rows cannot become received stock. Negative/fractional quantities require correction. Duplicate SKU/MPN identities remain separate and require review; quantities are not silently combined.

Semantic enrichment uses the existing strict helper contract in sequential batches of 30 concise rows. Exact source references join results back to parsed rows; helper quantities cannot override parsed quantities. Invalid/missing helper results retain deterministic rows with diagnostics. The helper's credential allowlist is unchanged. All writes still require the existing explicit Apply action.

Product metadata enrichment runs inside the same proposal flow. It uses a useful source description first, then a verified concise helper description when product identity is clear; an existing Shelf description remains the default for an existing model. A bounded optional Openverse search uses manufacturer, product name, MPN and a meaningful supplier SKU. Candidate images are fetched through Shelf's SSRF-safe network helper with a 2 MB source cap, image signature and MIME checks, dimension limits, and static WebP preview processing. SVG and non-image responses are rejected. Description edits and image acceptance are review-stage decisions; image lookup failure does not block Apply, and existing model images are preserved. Individually tracked items store metadata on their AssetModel; quantity-tracked stock pools keep Shelf's model-link rules and store accepted descriptions/images on the stock asset.

Limits remain 5 MB and 1,000 product rows. Source-specific provenance lives in existing review details. Parsing logs counts, selected sheet/header and helper batch status without logging row contents.
