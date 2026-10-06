export function makeHandbookSlug(title: string) {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

export function getKnowledgeTerms(value: string) {
  return [
    ...new Set(
      value
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .match(/[a-z0-9]{3,}/g) ?? []
    ),
  ].filter((term) => !COMMON_TERMS.has(term));
}

const COMMON_TERMS = new Set([
  "about",
  "again",
  "also",
  "and",
  "are",
  "been",
  "can",
  "could",
  "does",
  "for",
  "from",
  "has",
  "have",
  "help",
  "how",
  "into",
  "its",
  "just",
  "more",
  "not",
  "our",
  "should",
  "some",
  "that",
  "the",
  "their",
  "them",
  "there",
  "this",
  "what",
  "when",
  "where",
  "with",
]);

/** Lexical similarity is a review hint only, never proof or AI memory. */
export function getKnowledgeOverlap(left: string, right: string) {
  const leftTerms = new Set(getKnowledgeTerms(left));
  const rightTerms = new Set(getKnowledgeTerms(right));
  if (!leftTerms.size || !rightTerms.size) return 0;
  let shared = 0;
  for (const term of leftTerms) if (rightTerms.has(term)) shared += 1;
  return shared / Math.max(leftTerms.size, rightTerms.size);
}

export function normalizeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
