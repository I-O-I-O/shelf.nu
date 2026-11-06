# Handbook category reading order

Published articles use their existing `HandbookArticle.position`, ascending,
with slug as a deterministic tie breaker for legacy equal positions. Category
lists and Related navigation share this order. Publication dates are display
metadata and do not affect it. Existing `isStartHere` data remains in the schema
but is unused by Handbook navigation.

Category lists display sequential reading numbers. Staff can drag a handle onto
the upper or lower half of another article to place it before or after that
article. The ordering menu also provides Move up and Move down for keyboard and
touch users. Search results disable ordering controls so hidden siblings cannot
be reordered accidentally. Readers see the numbered articles without controls.

Moves run through the authorized Handbook index action. The service loads only
published siblings in the same organization and category, rejects outside drop
targets, and writes consecutive positions in a serializable transaction. This
also makes moves reliable when legacy articles have tied positions. Concurrent
transaction conflicts fail without partially applying an order; the user can
retry the move. Republishing within the same category preserves the position,
including a legacy zero position. New publications and category changes append
to the destination category.

No migration or data cleanup is required. Each category's Contribute link opens
the normal article editor with that category preselected.
