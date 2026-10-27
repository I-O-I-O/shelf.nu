import { createHash } from "node:crypto";
import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(200);
const confidenceSchema = z.number().finite().min(0).max(1);

export const IMPORT_HELPER_SCHEMA_VERSION = 1 as const;
export const MAX_IMPORT_HELPER_CANDIDATES = 50;
export const MAX_IMPORT_HELPER_ROWS = 500;
export const MAX_IMPORT_HELPER_INDIVIDUAL_UNITS_PER_ROW = 100;
export const MAX_IMPORT_HELPER_INDIVIDUAL_UNITS_PER_IMPORT = 500;

const documentPageSchema = z
  .object({
    sourceRef: identifierSchema,
    page: z.number().int().positive(),
    text: z.string().min(1).max(250_000),
  })
  .strict();

const categoryAllowlistEntrySchema = z
  .object({ id: identifierSchema, name: z.string().trim().min(1).max(300) })
  .strict();

const locationAllowlistEntrySchema = z
  .object({
    id: identifierSchema,
    pathLabel: z.string().trim().min(1).max(1_000),
    occupancy: z
      .object({
        currentUnits: z.number().int().nonnegative(),
        proposedUnits: z.number().int().nonnegative(),
        capacity: z.number().int().positive().nullable(),
        context: z.string().max(1_000).nullable(),
      })
      .strict(),
  })
  .strict();

const productCandidateSchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(500),
    manufacturer: z.string().max(300).nullable(),
    mpn: z.string().max(300).nullable(),
  })
  .strict();

const quantityStatusSchema = z.enum([
  "RECEIVED",
  "SHIPPED",
  "ORDERED",
  "UNKNOWN",
]);

const settingRuleSchema = z.discriminatedUnion("key", [
  z
    .object({
      key: z.literal("minQuantity"),
      minimum: z.number().int().nonnegative(),
      maximum: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      key: z.literal("unitOfMeasure"),
      allowedValues: z.array(z.string().min(1).max(100)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      key: z.literal("consumptionType"),
      allowedValues: z
        .array(z.enum(["ONE_WAY", "TWO_WAY"]))
        .min(1)
        .max(2),
    })
    .strict(),
]);

export const importHelperRequestSchema = z
  .object({
    schemaVersion: z.literal(IMPORT_HELPER_SCHEMA_VERSION),
    document: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        pages: z.array(documentPageSchema).min(1).max(1_000),
      })
      .strict(),
    activeCategories: z.array(categoryAllowlistEntrySchema).max(500),
    relevantLocations: z.array(locationAllowlistEntrySchema).max(1_000),
    productCandidates: z
      .array(productCandidateSchema)
      .max(MAX_IMPORT_HELPER_CANDIDATES),
    allowedTrackingModes: z
      .array(z.enum(["INDIVIDUAL", "QUANTITY_TRACKED"]))
      .min(1)
      .max(2),
    allowedSettings: z.array(settingRuleSchema).max(3),
  })
  .strict()
  .superRefine((request, context) => {
    const duplicateCheck = <T extends { id?: string; sourceRef?: string }>(
      entries: T[],
      field: "id" | "sourceRef",
      path: (string | number)[]
    ) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        const value = entry[field];
        if (value && seen.has(value)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate ${field}`,
            path: [...path, index, field],
          });
        }
        if (value) seen.add(value);
      });
    };
    duplicateCheck(request.document.pages, "sourceRef", ["document", "pages"]);
    duplicateCheck(request.activeCategories, "id", ["activeCategories"]);
    duplicateCheck(request.relevantLocations, "id", ["relevantLocations"]);
    duplicateCheck(request.productCandidates, "id", ["productCandidates"]);
    const settingKeys = request.allowedSettings.map(({ key }) => key);
    if (new Set(settingKeys).size !== settingKeys.length) {
      context.addIssue({
        code: "custom",
        message: "Duplicate setting rule",
        path: ["allowedSettings"],
      });
    }
    request.allowedSettings.forEach((rule, index) => {
      if (rule.key === "minQuantity" && rule.maximum < rule.minimum) {
        context.addIssue({
          code: "custom",
          message: "Setting maximum must be greater than or equal to minimum",
          path: ["allowedSettings", index, "maximum"],
        });
      }
    });
  });

const candidateProposalRowSchema = z
  .object({
    sourceRef: identifierSchema,
    productName: z.string().trim().min(1).max(500),
    supplierProductNumber: z.string().max(300).nullable(),
    quantity: z.number().int().positive().max(1_000_000).nullable(),
    quantityStatus: quantityStatusSchema,
    manufacturer: z.string().max(300).nullable(),
    mpn: z.string().max(300).nullable(),
    description: z.string().max(5_000).nullable(),
    productMatch: z
      .object({
        matchType: z.enum(["EXISTING", "NEW", "UNCERTAIN"]),
        candidateId: identifierSchema.nullable(),
        confidence: confidenceSchema,
      })
      .strict(),
    categorySuggestion: z
      .object({
        categoryId: identifierSchema.nullable(),
        proposedName: z.null(),
        confidence: confidenceSchema,
      })
      .strict()
      .refine(
        (suggestion) => !(suggestion.categoryId && suggestion.proposedName)
      ),
    trackingSuggestion: z
      .object({
        mode: z.enum(["INDIVIDUAL", "QUANTITY_TRACKED"]).nullable(),
        confidence: confidenceSchema,
      })
      .strict(),
    kitHint: z
      .object({
        isKit: z.boolean(),
        name: z.string().trim().min(1).max(500).nullable(),
        confidence: confidenceSchema,
      })
      .strict(),
    settingsSuggestions: z
      .array(
        z
          .object({
            key: z.enum(["minQuantity", "unitOfMeasure", "consumptionType"]),
            value: z.union([z.number().int(), z.string().max(100)]),
            confidence: confidenceSchema,
          })
          .strict()
      )
      .max(3),
    locationSuggestions: z
      .array(
        z
          .object({
            locationId: identifierSchema,
            confidence: confidenceSchema,
          })
          .strict()
      )
      .max(1),
    questions: z.array(z.string().trim().min(1).max(1_000)).max(1),
    evidence: z
      .array(
        z
          .object({
            sourceRef: identifierSchema,
            text: z.string().trim().min(1).max(2_000),
          })
          .strict()
      )
      .min(1)
      .max(30),
  })
  .strict()
  .superRefine((row, context) => {
    if (
      (row.quantityStatus === "RECEIVED" || row.quantityStatus === "SHIPPED") &&
      row.quantity === null
    ) {
      context.addIssue({
        code: "custom",
        message: "A supplied quantity is required for a received/shipped row.",
        path: ["quantity"],
      });
    }
  });

export const importHelperResponseSchema = z
  .object({
    schemaVersion: z.literal(IMPORT_HELPER_SCHEMA_VERSION),
    rows: z.array(candidateProposalRowSchema).max(MAX_IMPORT_HELPER_ROWS),
    questions: z.array(z.string().trim().min(1).max(1_000)).max(100),
  })
  .strict();

export type ImportHelperRequest = z.infer<typeof importHelperRequestSchema>;
export type ImportHelperResponse = z.infer<typeof importHelperResponseSchema>;
export type ImportHelperCandidateRow = ImportHelperResponse["rows"][number];

export class ImportHelperValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportHelperValidationError";
  }
}

export function createImportHelperRequest(
  request: Omit<ImportHelperRequest, "schemaVersion" | "document"> & {
    document: {
      sha256?: string;
      pages: ImportHelperRequest["document"]["pages"];
    };
  }
): ImportHelperRequest {
  const sha256 =
    request.document.sha256 ??
    createHash("sha256")
      .update(
        request.document.pages
          .map(({ sourceRef, page, text }) => `${sourceRef}\0${page}\0${text}`)
          .join("\0")
      )
      .digest("hex");
  const parsed = importHelperRequestSchema.safeParse({
    ...request,
    schemaVersion: IMPORT_HELPER_SCHEMA_VERSION,
    document: { ...request.document, sha256 },
  });
  if (!parsed.success) {
    throw new ImportHelperValidationError(
      "Shelf generated an invalid import helper request."
    );
  }
  return parsed.data;
}

function filterInvoiceNoiseRows(rows: ImportHelperResponse["rows"]) {
  return rows.flatMap((row) => {
    const cleanText = (value: string | null) => {
      const cleaned =
        value
          ?.replace(
            /\s*(?:[,;|–—-]\s*)?(?:TARIC|HTS(?:\s+code)?|ECCN|COO|Country of Origin)\s*[:#-]?\s*[A-Z0-9./-]+(?:\s+.*)?$/i,
            ""
          )
          .trim() ?? null;
      if (!cleaned || !row.manufacturer?.trim()) return cleaned;
      const duplicatedPrefix = `${row.manufacturer.trim()} ${row.manufacturer.trim()} `;
      return cleaned
        .toLocaleLowerCase("en")
        .startsWith(duplicatedPrefix.toLocaleLowerCase("en"))
        ? `${row.manufacturer.trim()} ${cleaned.slice(duplicatedPrefix.length)}`
        : cleaned;
    };
    const description = cleanText(row.description);
    const originalTitle = cleanText(row.productName) ?? "";
    const normalizedTitle = originalTitle
      .replace(/[.:]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const titleKey = normalizedTitle.toLocaleLowerCase("en");
    const nonProductLabels = new Set([
      "continued",
      "fortsätter",
      "radnr",
      "line no",
      "line number",
      "mousers artikelnummer",
      "kundens/tillv. artikelnr",
      "tillv. artikelnr",
      "beskrivning",
      "ordered",
      "shipped",
      "pending",
      "price",
      "total",
      "subtotal",
      "currency",
      "currency code",
      "eur",
      "usd",
      "sek",
      "dkk",
      "gbp",
      "nok",
      "pln",
      "vat",
      "tax",
      "tax total",
      "freight",
      "shipping charge",
      "invoice number",
      "order number",
      "account number",
      "taric",
      "tariff code",
      "hts",
      "hts code",
      "eccn",
      "coo",
      "country of origin",
    ]);
    const numericOrPrice = /^[€$£]?\s*\d[\d\s.,/-]*\s*[€$£]?$/u.test(
      normalizedTitle
    );
    const shortProductTitles = new Set([
      "led",
      "usb",
      "pcb",
      "smd",
      "lcd",
      "ic",
      "imu",
      "mcu",
      "cpu",
      "ram",
      "ssd",
      "nvme",
      "can",
      "dvi",
      "fan",
      "fuse",
      "gpio",
      "chip",
      "cap",
      "res",
      "pot",
      "relay",
      "bnc",
      "rj45",
      "rfid",
      "nfc",
      "pir",
      "ttl",
      "spi",
      "i2c",
      "uart",
      "adc",
      "dac",
      "pwm",
      "rtc",
      "npn",
      "pnp",
    ]);
    const shortFragment =
      normalizedTitle.length <= 4 && !shortProductTitles.has(titleKey);
    const metadataLabel =
      /^(?:\.?\s*)?(?:tillv\.?\s*)?(?:artikelnr|artikelnummer)\s*[:#-]?/i.test(
        normalizedTitle
      );
    const codeOnly =
      numericOrPrice ||
      [row.supplierProductNumber, row.mpn]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.trim().toLocaleLowerCase("en") === titleKey);
    const productName =
      (codeOnly ||
        shortFragment ||
        nonProductLabels.has(titleKey) ||
        metadataLabel) &&
      description &&
      description.length >= 5
        ? description
        : normalizedTitle;
    if (
      !productName ||
      (numericOrPrice && !description) ||
      (nonProductLabels.has(titleKey) && !description) ||
      (metadataLabel && !description) ||
      (shortFragment && !description)
    ) {
      return [];
    }
    return [{ ...row, productName, description }];
  });
}

export function validateImportHelperResponse(
  response: unknown,
  requestInput: ImportHelperRequest | unknown
): ImportHelperResponse {
  const requestResult = importHelperRequestSchema.safeParse(requestInput);
  if (!requestResult.success) {
    throw new ImportHelperValidationError(
      "The Shelf helper request is invalid."
    );
  }
  const responseResult = importHelperResponseSchema.safeParse(response);
  if (!responseResult.success) {
    throw new ImportHelperValidationError(
      "The helper returned a malformed or unsupported response."
    );
  }

  const request = requestResult.data;
  const parsedResult = responseResult.data;
  const result = {
    ...parsedResult,
    rows: filterInvoiceNoiseRows(parsedResult.rows),
  };
  const categoryIds = new Set(request.activeCategories.map(({ id }) => id));
  const locationIds = new Set(request.relevantLocations.map(({ id }) => id));
  const productIds = new Set(request.productCandidates.map(({ id }) => id));
  const pagesBySourceRef = new Map(
    request.document.pages.map((page) => [page.sourceRef, page.text])
  );
  const settingRules = new Map(
    request.allowedSettings.map((rule) => [rule.key, rule])
  );
  let individualUnits = 0;

  result.rows.forEach((row, rowIndex) => {
    const invalid = (message: string, path: (string | number)[]): never => {
      throw new ImportHelperValidationError(
        `Helper response ${message} at rows.${rowIndex}.${path.join(".")}.`
      );
    };
    if (!pagesBySourceRef.has(row.sourceRef))
      invalid("references an unknown source", ["sourceRef"]);
    if (
      row.trackingSuggestion.mode &&
      !request.allowedTrackingModes.includes(row.trackingSuggestion.mode)
    ) {
      invalid("uses a tracking mode not allowed by Shelf", [
        "trackingSuggestion",
        "mode",
      ]);
    }
    if (row.productMatch.matchType === "EXISTING") {
      if (
        !row.productMatch.candidateId ||
        !productIds.has(row.productMatch.candidateId)
      ) {
        invalid("references an unknown product candidate", [
          "productMatch",
          "candidateId",
        ]);
      }
    } else {
      if (
        row.productMatch.matchType === "NEW" &&
        row.productMatch.candidateId
      ) {
        invalid(
          "marks a product as new while referencing an existing candidate",
          ["productMatch"]
        );
      }
      if (
        row.productMatch.candidateId &&
        !productIds.has(row.productMatch.candidateId)
      ) {
        invalid("references an unknown product candidate", [
          "productMatch",
          "candidateId",
        ]);
      }
    }
    if (
      row.categorySuggestion.categoryId &&
      !categoryIds.has(row.categorySuggestion.categoryId)
    ) {
      invalid("references a category outside Shelf's allowlist", [
        "categorySuggestion",
        "categoryId",
      ]);
    }
    for (const [index, suggestion] of row.locationSuggestions.entries()) {
      if (!locationIds.has(suggestion.locationId)) {
        invalid("references a location outside Shelf's allowlist", [
          "locationSuggestions",
          index,
          "locationId",
        ]);
      }
    }
    for (const [index, suggestion] of row.settingsSuggestions.entries()) {
      const rule = settingRules.get(suggestion.key);
      if (!rule) {
        throw new ImportHelperValidationError(
          `Helper response suggests a setting that Shelf did not allow at rows.${rowIndex}.settingsSuggestions.${index}.key.`
        );
      }
      if (suggestion.key === "minQuantity") {
        if (rule.key !== "minQuantity") {
          throw new ImportHelperValidationError(
            `Helper request has a mismatched minQuantity setting rule at rows.${rowIndex}.settingsSuggestions.${index}.key.`
          );
        }
        if (
          typeof suggestion.value !== "number" ||
          suggestion.value < rule.minimum ||
          suggestion.value > rule.maximum
        ) {
          invalid("suggests an invalid minQuantity", [
            "settingsSuggestions",
            index,
            "value",
          ]);
        }
      } else {
        if (rule.key === "minQuantity") {
          throw new ImportHelperValidationError(
            `Helper request has a mismatched ${suggestion.key} setting rule at rows.${rowIndex}.settingsSuggestions.${index}.key.`
          );
        }
        if (
          typeof suggestion.value !== "string" ||
          !rule.allowedValues.some(
            (allowedValue) => allowedValue === suggestion.value
          )
        ) {
          invalid(`suggests a disallowed ${suggestion.key}`, [
            "settingsSuggestions",
            index,
            "value",
          ]);
        }
      }
    }
    for (const [index, evidence] of row.evidence.entries()) {
      const sourceText = pagesBySourceRef.get(evidence.sourceRef);
      if (!sourceText || !sourceText.includes(evidence.text)) {
        invalid("contains evidence that cannot be verified in the document", [
          "evidence",
          index,
        ]);
      }
    }
    if (row.trackingSuggestion.mode === "INDIVIDUAL" && row.quantity !== null) {
      if (row.quantity > MAX_IMPORT_HELPER_INDIVIDUAL_UNITS_PER_ROW) {
        invalid("exceeds the individual-unit row limit", ["quantity"]);
      }
      individualUnits += row.quantity;
    }
  });

  if (individualUnits > MAX_IMPORT_HELPER_INDIVIDUAL_UNITS_PER_IMPORT) {
    throw new ImportHelperValidationError(
      "Helper response exceeds the individual-unit import limit."
    );
  }

  return result;
}

export function parseAndValidateImportHelperResponse(
  responseText: string,
  request: ImportHelperRequest
): ImportHelperResponse {
  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch {
    throw new ImportHelperValidationError("The helper returned invalid JSON.");
  }
  return validateImportHelperResponse(response, request);
}
