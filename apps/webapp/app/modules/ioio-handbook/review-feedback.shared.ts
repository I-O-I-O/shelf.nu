/** Review notes stay on the review record, never in the published article body. */
const FEEDBACK_MARKER = "\n\nStaff feedback:\n";
export const HANDBOOK_REVIEW_FEEDBACK_MAX_LENGTH = 1000;

export function getHandbookReviewFeedback(content?: string) {
  const index = content?.lastIndexOf(FEEDBACK_MARKER) ?? -1;
  return index < 0 ? null : content!.slice(index + FEEDBACK_MARKER.length);
}

export function appendHandbookReviewFeedback(
  content: string,
  feedback: string
) {
  return `${content}${FEEDBACK_MARKER}${feedback}`;
}
