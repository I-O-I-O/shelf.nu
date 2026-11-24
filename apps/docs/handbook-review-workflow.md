# Handbook contribution review

Staff review pending student articles and improvements at `/handbook/review` with
**Approve** and **Reject**. Rejection accepts an optional reason, displayed in the
contributor's My Work list and editor.

Rejected work remains editable by its contributor. Editing and submitting again
uses the same article and proposed draft, while creating a new pending review
record. Previous review records remain intact. For improvements, the current
published version remains live until approval publishes the proposed revision.

Review feedback uses the existing review record's `content` field, separated by
the shared feedback marker. It is never added to published article content. No
schema change is required. Historical returned-for-changes states remain
supported, although they are no longer a normal visible staff review action.

The dashboard count and review queue share the canonical pending-review filter.
Rejection removes a contribution from that count, resubmission adds it again,
and approval removes it. Contributor ownership checks apply on the server when
saving and resubmitting; review routes remain staff-only.

Focused service tests cover reject/edit/resubmit/approve for both new articles
and improvements, retained identity and history, feedback, ownership, and count
transitions. Route tests cover the review dialog and rejected-work Edit action.
