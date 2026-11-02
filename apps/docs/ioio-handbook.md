# IOIO Lab Handbook

The Handbook is a staff-governed knowledge base for IOIO Lab. Published
articles have one stable page identity and an append-only sequence of approved
versions. Students can save drafts and submit article or revision proposals;
staff decides what becomes current.

## Student workflow

Students can start a new article proposal from the Handbook home page or
propose a revision from a current article. Drafts are private to their author.
Submitting a draft sends it to the staff review queue. The current approved
version stays live while a revision is pending. Staff can approve it, return it
with a note, or reject it. A returned draft can be edited and submitted again.

## Staff workflow

Use **Review proposals** on the Handbook home page to compare a proposal with
the current approved version. The review page shows a deterministic text change
summary, bounded duplicate candidates, and structured Claude findings when
Claude is available. Staff may approve despite warnings, publish a new article
separately, convert a new proposal into a revision of an existing article,
return it, reject it, or mark a duplicate suggestion as incorrect.

Staff can publish directly from the editor. Published articles can be archived
and restored from **Handbook health and review**. Archived articles remain in
the database with their version history.

## Article content

Articles have a category, topic, article type, and optional Shelf Location.
Article types are Guide, Tutorial, Procedure, Equipment guide,
Troubleshooting, Reference, and Safety. Categories and topics are organization
scoped; the browse page lists taxonomy used by published articles.

The editor supports headings, paragraphs, bold and italic text, lists, links,
and inline images. Images are stored through Shelf's image service, must be
PNG, JPEG, or WebP, and may be no larger than 2 MB each. Video uploads are not
supported; authors can add HTTPS video links.

## AI review boundary

Shelf retrieves at most five current approved candidate articles using
organization-scoped text and taxonomy matching. The review request contains a
bounded, sanitized excerpt and asks Claude for structured duplication,
conflict, structure, and staleness findings. Claude has no tools, database
access, or write path. Shelf validates findings before storing them. Staff
remains the publishing authority, and Handbook editing and approval continue
when Claude is unavailable.

The staff-only global **Run knowledge check** action is shown as a deferred
interface seam. It does not execute an audit in this release. Findings can
still be created during proposal review and manually dismissed or resolved.

## Development notes

The existing `HandbookArticle` and `HandbookArticleVersion` records remain the
canonical page and approved-version records. New category, topic, proposal
revision, and staff finding models extend them. `HandbookRevision` records
drafts and pending submissions; approving one creates a new immutable
`HandbookArticleVersion` and only then moves the article's current-version
pointer.

The additive migration is
`packages/database/prisma/migrations/20261102120000_ioio_handbook_revisions_taxonomy/migration.sql`.
It preserves existing published versions and carries legacy unsent edits into
private draft revisions. Apply it through the normal database deployment
process after review; do not reset the database.
