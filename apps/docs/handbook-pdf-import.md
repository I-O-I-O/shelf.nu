# Handbook PDF import

PDF import extracts page text locally and shows a proposed Handbook category,
article list, source sections, and references before it writes anything. The
proposal is deterministic and works without an AI provider.

## Structure extraction

The importer reads pages in order, removes repeated page-edge text and page
numbers, uses a detected table of contents to recover heading depth, and uses
PDF.js font-size cues plus numbered and short standalone headings when
available. Lists remain lists and article content is stored as the same
Markdown/Markdoc body used by manual editing and revisions. H2 and H3 remain
article sections and subsections inside that body.

Laser cutting documents are grouped around recognizable knowledge areas such
as basics, joints, software, Inkscape, parametric generators, CAD, and
resources. Unknown documents with a detected hierarchy stay together unless
they have at least four clear top-level sections, in which case those major
sections are offered as separate draft articles for review. Headingless text
uses the single-article fallback editor.

The review step lets the user rename and remove article proposals, move source
sections, merge proposals, choose or create a category on approval, continue as
one article, and select a possible existing article. Existing article matches
are title-overlap hints within the chosen category. Selecting “Use existing /
improve” creates a proposed revision by appending imported sections to the
published body; the published version stays live until the normal review or
publish action completes.

Only the approval action writes article drafts. New categories are created in
the same database transaction as the draft set. Staff drafts and Student-owned
drafts both open in the regular Handbook editor. Students can submit them later
through its normal Staff review flow. Import never publishes automatically.

Imported article bodies retain a short `Imported from: <filename>` callout.
Only the client-provided basename is shown. External URLs stay with the source
section that contained them and become that article's references.

## Optional Claude review

“Improve structure with Claude” is available only when the server has an
Anthropic API key. Claude receives extracted section IDs, headings, hierarchy,
source order, and section text. It returns category and article grouping
suggestions; the server requires every source section exactly once and maps
suggestions back to the original extracted Markdown. Claude does not create,
rewrite, publish, or delete article content. The user reviews the resulting
proposal before approval.

## Current limits

PDFs must be 5 MB or smaller and no more than 50 pages. Scanned PDFs depend on
the existing local OCR path, which supports up to 20 pages. Images are not
extracted into article bodies. The supplied `Challenge 6 Laser cutting done
right` source PDF should be checked in the review UI before production use; the
repository test fixture covers its described headings but does not replace
inspection of the original file.
