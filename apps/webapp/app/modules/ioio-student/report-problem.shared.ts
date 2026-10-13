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
  "FOUND_SOMETHING",
  "OTHER",
] as const;

export const ioioReportTypeSchema = z.enum(IOIO_REPORT_TYPES);
export type IoioReportType = z.infer<typeof ioioReportTypeSchema>;

/** Central report display and operational classification shared by Staff UI. */
export const IOIO_REPORT_LABELS: Record<IoioReportType, string> = {
  ITEM_MISSING: "Item missing",
  ITEM_DAMAGED: "Item damaged",
  ITEM_NOT_WORKING: "Item not working",
  PART_MISSING: "Part missing",
  WRONG_LOCATION: "Wrong location",
  LOCATION_FULL: "Location full",
  CANNOT_FIND: "Can't find item",
  KIT_INCOMPLETE: "Kit incomplete",
  FOUND_SOMETHING: "Found something",
  OTHER: "Other",
};

export type IoioReportClassification = "equipment-condition" | "general";

/** Only physical-condition reports belong in Broken items. */
export function classifyIoioReport(
  reportType: string | null | undefined
): IoioReportClassification {
  return [
    "ITEM_DAMAGED",
    "ITEM_NOT_WORKING",
    "PART_MISSING",
    "KIT_INCOMPLETE",
  ].includes(reportType ?? "")
    ? "equipment-condition"
    : "general";
}

/** Student-facing success acknowledgement for each persisted report type. */
export const IOIO_REPORT_ACKNOWLEDGEMENTS: Record<IoioReportType, string> = {
  ITEM_MISSING: "Thanks for reporting this item. Staff will look into it.",
  ITEM_DAMAGED: "Thanks for reporting the damaged item. Staff will review it.",
  ITEM_NOT_WORKING:
    "Thanks for reporting the item that is not working. Staff will review it.",
  PART_MISSING: "Thanks for reporting the missing part. Staff will review it.",
  WRONG_LOCATION:
    "Thanks for reporting the location issue. Staff will check it.",
  LOCATION_FULL: "Thanks for reporting the full location. Staff will check it.",
  CANNOT_FIND: "Thanks for reporting this item. Staff will look into it.",
  KIT_INCOMPLETE:
    "Thanks for reporting the incomplete kit. Staff will review it.",
  FOUND_SOMETHING: "Thanks for letting Staff know.",
  OTHER: "Thanks for your report. Staff will review it.",
};

export const IOIO_REPORT_FORM_VALUES = [
  "DAMAGED",
  "MISSING",
  "CANT_FIND",
  "WRONG_LOCATION",
  "LOCATION_FULL",
  "KIT_INCOMPLETE",
  "OTHER",
] as const;

export type IoioReportFormValue = (typeof IOIO_REPORT_FORM_VALUES)[number];

export const IOIO_REPORT_TYPE_BY_FORM_VALUE: Record<
  IoioReportFormValue,
  IoioReportType
> = {
  DAMAGED: "ITEM_DAMAGED",
  MISSING: "ITEM_MISSING",
  CANT_FIND: "CANNOT_FIND",
  WRONG_LOCATION: "WRONG_LOCATION",
  LOCATION_FULL: "LOCATION_FULL",
  KIT_INCOMPLETE: "KIT_INCOMPLETE",
  OTHER: "OTHER",
};

export const IOIO_REPORT_CONTEXT_RULES: Record<
  IoioReportFormValue,
  {
    asset: "required" | "optional" | "none";
    location: "required" | "optional" | "none";
    exactUnit: "required-if-multiple" | "optional" | "none";
  }
> = {
  DAMAGED: {
    asset: "required",
    location: "none",
    exactUnit: "required-if-multiple",
  },
  MISSING: { asset: "required", location: "none", exactUnit: "optional" },
  CANT_FIND: { asset: "required", location: "none", exactUnit: "none" },
  WRONG_LOCATION: {
    asset: "required",
    location: "required",
    exactUnit: "required-if-multiple",
  },
  LOCATION_FULL: { asset: "none", location: "required", exactUnit: "none" },
  KIT_INCOMPLETE: {
    asset: "required",
    location: "none",
    exactUnit: "required-if-multiple",
  },
  OTHER: { asset: "none", location: "none", exactUnit: "none" },
};

export function getIoioReportAcknowledgement(reportType: string) {
  return IOIO_REPORT_ACKNOWLEDGEMENTS[
    ioioReportTypeSchema.safeParse(reportType).success
      ? (reportType as IoioReportType)
      : "OTHER"
  ];
}

/** Reports that should immediately block borrowing of the reported physical unit. */
export const IOIO_PHYSICAL_UNIT_BLOCKING_REPORT_TYPES: ReadonlySet<IoioReportType> =
  new Set([
    "ITEM_MISSING",
    "ITEM_DAMAGED",
    "ITEM_NOT_WORKING",
    "PART_MISSING",
    "KIT_INCOMPLETE",
  ]);

/** Unresolved exact-unit reports that must not be submitted a second time. */
export const IOIO_REPORTED_UNIT_LOCKING_REPORT_TYPES: ReadonlySet<IoioReportType> =
  new Set([...IOIO_PHYSICAL_UNIT_BLOCKING_REPORT_TYPES, "CANNOT_FIND"]);

export function isIoioPhysicalUnitBlockingReport(reportType: string | null) {
  return Boolean(
    reportType &&
      IOIO_PHYSICAL_UNIT_BLOCKING_REPORT_TYPES.has(reportType as IoioReportType)
  );
}

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
