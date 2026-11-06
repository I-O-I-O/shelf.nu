# Handbook removal and history

Use the existing article status and review status fields. The article and
revision data model is unchanged. An additive ActivityAction enum value records
permanent deletion through the existing ActivityEvent service. All removal
controls use Shelf's AlertDialog confirmation. Triggers are neutral, with
destructive styling reserved for the confirmation action.

- Unpublished drafts: the existing `deleteHandbookDraft` validates organization,
  creator ownership (or trusted Staff capability), DRAFT status, no published
  pointer, no version history, and no pending review before deleting. Its guarded
  delete rechecks these conditions. Retained observations use the existing
  SetNull relation; they are not cascade-deleted with a draft.
- Published articles: `archiveHandbookArticle` requires Staff capability and
  changes PUBLISHED to ARCHIVED. It preserves position, draft ownership, content,
  version pointers, observations, and all published versions. Normal category,
  search, Related, and article-read queries already require PUBLISHED. Staff can
  restore ARCHIVED to PUBLISHED from Settings → AI → Knowledge, using the same
  guarded visibility transition. Stale saves and publication requests cannot
  reactivate archived articles.
- Permanent deletion: Staff can permanently delete a published article directly
  from its article action menu or an archived article from Settings → AI →
  Knowledge. The dialog requires the exact published title, and the service
  checks that value again inside a serializable transaction. Article deletion
  cascades its published versions and version
  joins; article-only observations are removed, while observations also linked
  to an asset, Kit, or conversation are detached and retained. Shared source
  records remain referenced; unreferenced database source records without a
  storage object are cleaned up. Uploaded storage objects are never removed.
  Remaining published category positions are normalized, and an
  `IOIO_HANDBOOK_ARTICLE_DELETED` activity event records the actor, article ID,
  title, slug, and event time.
- Pending submissions and improvements: `withdrawHandbookSubmission` scopes the
  pending request to the organization and contributor, unless trusted Staff
  capability is present. Withdrawal uses the existing DISMISSED review state
  and records the actor/time in the existing review fields. It retains the
  request, version links, and the editable draft. It does not reject/reset the
  shared article draft or alter any published content.
- Unsubmitted improvements: the existing discard function restores draft fields
  from the current published version after a separate explicit confirmation. It
  never deletes the article identity or a published version.

Published menus submit archive and permanent deletion to `/handbook/manage`.
Permanent deletion from archived article rows uses the same route and service.
Draft deletion, draft-improvement discard, and withdrawal use
`/handbook/my-work`. Capabilities come from Shelf authorization, never from form
fields. Historical versions have no standalone delete control. Archived version
history becomes readable again on restore; permanent article deletion removes
all revisions attached to that article.
