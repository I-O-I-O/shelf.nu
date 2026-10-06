import { z } from "zod";

export const IOIO_REPORT_TYPES = [
  "ITEM_MISSING",
  "ITEM_DAMAGED",
  "ITEM_NOT_WORKING",
  "PART_MISSING",
  "WRONG_LOCATION",
  "LOCATION_FULL",
  "CANNOT_FIND",
  "KIT_INCOMPLETE",
  "OTHER",
] as const;

export const ioioReportTypeSchema = z.enum(IOIO_REPORT_TYPES);
export type IoioReportType = z.infer<typeof ioioReportTypeSchema>;

export const reportProposalSchema = z
  .object({
    report_type: ioioReportTypeSchema,
    asset_id: z.string().trim().min(1).max(100).nullable().optional(),
    kit_id: z.string().trim().min(1).max(100).nullable().optional(),
    location_id: z.string().trim().min(1).max(100).nullable().optional(),
    description: z.string().trim().min(3).max(2000),
  })
  .strict();

export type ReportProposalDraft = z.infer<typeof reportProposalSchema>;

function replaceControlCharacters(value: string) {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x08 ||
        codePoint === 0x0b ||
        codePoint === 0x0c ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
        ? " "
        : character;
    })
    .join("");
}

/** Remove control characters and personal contact data from report prose. */
export function sanitizeReportText(value: string) {
  const redacted = value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[redacted contact]");

  return replaceControlCharacters(redacted)
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}
