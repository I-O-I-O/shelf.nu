import { z } from "zod";

export const returnProposalSchema = z
  .object({
    booking_id: z.string().trim().min(1).max(100),
    booking_asset_id: z.string().trim().min(1).max(100),
    asset_id: z.string().trim().min(1).max(100),
    quantity: z.coerce.number().int().min(1).max(1000),
  })
  .strict();

export type ReturnProposalDraft = z.infer<typeof returnProposalSchema>;

export function getStudentReturnIssueComment(description: string | null) {
  const submittedPrefix = "Return submitted.";
  const submitted = description?.startsWith(submittedPrefix)
    ? description.slice(submittedPrefix.length).trim()
    : description?.trim() ?? "";
  const issuePrefix = /^Issue reported:\s*[^.]+(?:\.\s*|$)/u;
  const comment = issuePrefix.test(submitted)
    ? submitted.replace(issuePrefix, "").trim()
    : submitted;

  if (
    !comment ||
    comment === "Waiting for staff check." ||
    comment === "No additional details provided."
  ) {
    return null;
  }

  return comment;
}

export function returnIntent(question: string) {
  return /\b(return|check\s*in|give\s+back|bring\s+back)\b/i.test(question);
}

export function extractReturnQuantity(question: string) {
  const match = question.match(
    /\b(?:return|check\s*in|give\s+back|bring\s+back)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i
  );
  if (!match) return null;
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  return words[match[1].toLowerCase()] ?? Number(match[1]);
}

export function extractReturnSearch(question: string) {
  return question
    .replace(
      /\b(i want to|i'd like to|please|can i|could i|let me|return|check\s*in|give\s+back|bring\s+back|my)\b/gi,
      " "
    )
    .replace(/\b\d+\b/g, " ")
    .replace(/[?!.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
