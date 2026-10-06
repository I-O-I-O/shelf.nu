import { z } from "zod";

const optionalId = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().trim().min(1).max(100).optional()
);

export const borrowProposalSchema = z
  .object({
    asset_id: z.string().trim().min(1).max(100).nullable().optional(),
    candidate_asset_ids: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .optional(),
    scanned_asset_id: optionalId,
    scanned_qr_id: optionalId,
    scanned_asset_ids: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .optional(),
    scanned_qr_ids: z
      .array(z.string().trim().min(1).max(100))
      .max(100)
      .optional(),
    borrow_mode: z.enum(["STANDARD", "I_HAVE_ITEM"]).optional(),
    kit_id: z.string().trim().min(1).max(100).nullable().optional(),
    quantity: z.coerce.number().int().min(1).max(1000),
    // Kept as optional compatibility fields for existing assistant clients.
    // The borrow service never treats these values as authoritative.
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!!value.asset_id === !!value.kit_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select exactly one Shelf asset or kit.",
        path: ["asset_id"],
      });
    }
  });

export type BorrowProposalDraft = z.infer<typeof borrowProposalSchema>;

export function borrowIntent(question: string) {
  return /\b(borrow|loan|check\s*out|take)\b/i.test(question);
}

export function extractBorrowQuantity(question: string) {
  const match = question.match(
    /\b(?:borrow|loan|check\s*out|take)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i
  );
  if (match) return parseQuantity(match[1]);
  const standalone = question.match(
    /^\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i
  );
  if (standalone) return parseQuantity(standalone[1]);
  const natural = question.match(
    /\b(?:just\s+need|only\s+need|need|want|give\s+me)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i
  );
  return natural ? parseQuantity(natural[1]) : null;
}

function parseQuantity(value: string) {
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
  return words[value.toLowerCase()] ?? Number(value);
}

export function extractBorrowSearch(question: string) {
  return question
    .replace(
      /\b(i want to|i'd like to|please|can i|could i|let me|do we have|is there|where is|where are|that i can|that can be|borrow|loan|check\s*out|take|available)\b/gi,
      " "
    )
    .replace(/\b(?:until|return|back)\s+\d{4}-\d{2}-\d{2}\b/gi, " ")
    .replace(
      /\b(?:until|return|back)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,
      " "
    )
    .replace(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, " ")
    .replace(/(?<!#)\b\d+\b/g, " ")
    .replace(/\b(?:units?|items?)\s+of\b/gi, " ")
    .replace(/\bof\b/gi, " ")
    .replace(/\b(?:the|a|an)\b/gi, " ")
    .replace(/[?!.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractBorrowReturnDate(question: string) {
  const match = question.match(
    /\b(?:until|return(?:\s+by)?|by)\s+(\d{4}-\d{2}-\d{2})\b/i
  );
  if (match) return match[1];

  const dateOnly = question.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (dateOnly) return dateOnly[1];

  const weekdayMatch = question.match(
    /\b(?:until|return(?:\s+by)?|by)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
  );
  const resolvedWeekday =
    weekdayMatch?.[1] ??
    question.match(
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
    )?.[1];
  if (!resolvedWeekday) return null;

  const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const now = new Date();
  const targetDay = weekdays.indexOf(resolvedWeekday.toLowerCase());
  const currentDay = now.getUTCDay();
  const daysUntilTarget = (targetDay - currentDay + 7) % 7 || 7;
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  target.setUTCDate(target.getUTCDate() + daysUntilTarget);
  return target.toISOString().slice(0, 10);
}
