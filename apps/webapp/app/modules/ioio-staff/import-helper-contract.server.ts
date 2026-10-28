import { createHash } from "node:crypto";
import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(200);
const confidenceSchema = z.number().finite().min(0).max(1);

export const IMPORT_HELPER_SCHEMA_VERSION = 1 as const;
export const MOUSER_ENRICHMENT_SCHEMA_VERSION = 2 as const;
export const INVENTORY_REORGANIZATION_SCHEMA_VERSION = 1 as const;
export const LOCATION_STRUCTURE_SCHEMA_VERSION = 1 as const;
export const MAX_REORGANIZATION_MODELS_PER_BATCH = 40;
export const MAX_REORGANIZATION_CATEGORIES = 20;
export const MAX_REORGANIZATION_LOCATIONS = 20;
export const MAX_IMPORT_HELPER_CANDIDATES = 50;
export const MAX_IMPORT_HELPER_ROWS = 100;
export const MOUSER_ENRICHMENT_BATCH_SIZE = 50;
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
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(300),
    description: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

const locationAllowlistEntrySchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(300).optional(),
    pathLabel: z.string().trim().min(1).max(1_000),
    description: z.string().trim().max(500).nullable().optional(),
    parentId: identifierSchema.nullable().optional(),
    hasChildren: z.boolean().optional(),
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

const mouserLocationAllowlistEntrySchema = z
  .object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(300),
    pathLabel: z.string().trim().min(1).max(1_000),
    description: z.string().trim().max(500).nullable(),
    parentId: identifierSchema.nullable(),
    hasChildren: z.boolean(),
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

const genericImportHelperRequestSchema = z
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

const mouserLineItemSchema = z
  .object({
    sourceRef: identifierSchema,
    sourcePage: z.number().int().positive(),
    supplierProductNumber: z.string().trim().min(1).max(300),
    mpn: z.string().trim().min(1).max(300).nullable(),
    rawDescription: z.string().trim().min(3).max(5_000),
    quantity: z.number().int().positive().max(1_000_000),
  })
  .strict();

const mouserEnrichmentRequestSchema = z
  .object({
    mode: z.literal("MOUSER_LINE_ITEM_ENRICHMENT"),
    schemaVersion: z.literal(MOUSER_ENRICHMENT_SCHEMA_VERSION),
    document: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    lineItems: z
      .array(mouserLineItemSchema)
      .min(1)
      .max(MOUSER_ENRICHMENT_BATCH_SIZE),
    activeCategories: z.array(categoryAllowlistEntrySchema).max(500),
    relevantLocations: z
      .array(mouserLocationAllowlistEntrySchema)
      .max(1_000)
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const refs = request.lineItems.map(({ sourceRef }) => sourceRef);
    if (new Set(refs).size !== refs.length) {
      context.addIssue({
        code: "custom",
        message: "Duplicate line item sourceRef",
        path: ["lineItems"],
      });
    }
    const categoryIds = request.activeCategories.map(({ id }) => id);
    if (new Set(categoryIds).size !== categoryIds.length) {
      context.addIssue({
        code: "custom",
        message: "Duplicate category ID",
        path: ["activeCategories"],
      });
    }
    const locationIds = (request.relevantLocations ?? []).map(({ id }) => id);
    if (new Set(locationIds).size !== locationIds.length) {
      context.addIssue({
        code: "custom",
        message: "Duplicate location ID",
        path: ["relevantLocations"],
      });
    }
  });

const reorganizationRequestSchema = z
  .object({
    mode: z.literal("INVENTORY_REORGANIZATION"),
    schemaVersion: z.literal(INVENTORY_REORGANIZATION_SCHEMA_VERSION),
    instruction: z.string().trim().min(1).max(2_000),
    scope: z
      .object({
        categoryIds: z.array(identifierSchema).max(100).optional(),
        locationIds: z.array(identifierSchema).max(100).optional(),
      })
      .strict(),
    items: z
      .array(
        z
          .object({
            modelId: identifierSchema,
            productName: z.string().trim().min(1).max(500),
            manufacturer: z.string().max(300).nullable(),
            shortDescription: z.string().max(500).nullable(),
            currentCategoryId: identifierSchema.nullable(),
            currentLocationId: identifierSchema.nullable(),
            quantity: z.number().int().nonnegative().nullable(),
          })
          .strict()
      )
      .min(1)
      .max(MAX_REORGANIZATION_MODELS_PER_BATCH),
    categories: z
      .array(
        z
          .object({
            id: identifierSchema,
            name: z.string().trim().min(1).max(300),
            path: z.string().max(500).optional(),
            description: z.string().max(500).nullable().optional(),
          })
          .strict()
      )
      .max(MAX_REORGANIZATION_CATEGORIES),
    locations: z
      .array(
        z
          .object({
            id: identifierSchema,
            name: z.string().trim().min(1).max(300),
            path: z.string().trim().min(1).max(1_000),
            description: z.string().max(500).nullable().optional(),
            hierarchyDepth: z.number().int().nonnegative(),
            categoryAffinitySummary: z.string().max(500).optional(),
          })
          .strict()
      )
      .max(MAX_REORGANIZATION_LOCATIONS),
  })
  .strict();

const locationStructureRequestSchema = z
  .object({
    mode: z.literal("LOCATION_STRUCTURE"),
    schemaVersion: z.literal(LOCATION_STRUCTURE_SCHEMA_VERSION),
    instruction: z.string().trim().min(1).max(2_000),
    existingLocations: z
      .array(
        z
          .object({
            id: identifierSchema,
            name: z.string().trim().min(1).max(300),
            parentId: identifierSchema.nullable(),
            path: z.string().trim().min(1).max(1_000),
            description: z.string().max(500).nullable(),
          })
          .strict()
      )
      .max(1_000),
  })
  .strict();

export const importHelperRequestSchema = z.union([
  genericImportHelperRequestSchema,
  mouserEnrichmentRequestSchema,
  reorganizationRequestSchema,
  locationStructureRequestSchema,
]);

const reorganizationResponseSchema = z
  .object({
    mode: z.literal("INVENTORY_REORGANIZATION"),
    schemaVersion: z.literal(INVENTORY_REORGANIZATION_SCHEMA_VERSION),
    proposals: z
      .array(
        z
          .object({
            modelId: identifierSchema,
            suggestedCategoryId: identifierSchema.nullable(),
            categoryConfidence: confidenceSchema,
            suggestedLocationId: identifierSchema.nullable(),
            locationConfidence: confidenceSchema,
            reason: z.string().trim().min(1).max(1_000),
          })
          .strict()
      )
      .max(MAX_REORGANIZATION_MODELS_PER_BATCH),
  })
  .strict();

const locationStructureResponseSchema = z
  .object({
    mode: z.literal("LOCATION_STRUCTURE"),
    schemaVersion: z.literal(LOCATION_STRUCTURE_SCHEMA_VERSION),
    operations: z
      .array(
        z
          .object({
            action: z.literal("CREATE_LOCATION"),
            temporaryId: identifierSchema,
            parentLocationId: identifierSchema.nullable(),
            parentTemporaryId: identifierSchema.nullable(),
            name: z.string().trim().min(1).max(300),
            description: z.string().trim().max(500).nullable(),
          })
          .strict()
      )
      .max(100),
  })
  .strict();

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

const mouserEnrichmentRowSchema = z
  .object({
    sourceRef: identifierSchema,
    supplierProductNumber: z.string().trim().min(1).max(300),
    mpn: z.string().trim().min(1).max(300).nullable(),
    productName: z.string().trim().min(1).max(500),
    manufacturer: z.string().trim().min(1).max(300).nullable(),
    description: z.string().trim().min(1).max(5_000).nullable(),
    quantity: z.number().int().positive().max(1_000_000),
    categoryId: identifierSchema.nullable(),
    categoryConfidence: confidenceSchema.optional(),
    locationId: identifierSchema.nullable().optional(),
    locationConfidence: confidenceSchema.optional(),
    confidence: confidenceSchema,
  })
  .strict();

export const mouserEnrichmentResponseSchema = z
  .object({
    mode: z.literal("MOUSER_LINE_ITEM_ENRICHMENT"),
    schemaVersion: z.literal(MOUSER_ENRICHMENT_SCHEMA_VERSION),
    rows: z.array(mouserEnrichmentRowSchema).max(MOUSER_ENRICHMENT_BATCH_SIZE),
  })
  .strict();

export type ImportHelperRequest = z.infer<
  typeof genericImportHelperRequestSchema
>;
export type MouserLineItemInput = z.infer<typeof mouserLineItemSchema>;
export type MouserEnrichmentRequest = z.infer<
  typeof mouserEnrichmentRequestSchema
>;
export type AnyImportHelperRequest = z.infer<typeof importHelperRequestSchema>;
export type ImportHelperResponse = z.infer<typeof importHelperResponseSchema>;
export type MouserEnrichmentResponse = z.infer<
  typeof mouserEnrichmentResponseSchema
>;
export type AnyImportHelperResponse =
  | ImportHelperResponse
  | MouserEnrichmentResponse
  | z.infer<typeof reorganizationResponseSchema>
  | z.infer<typeof locationStructureResponseSchema>;
export type ImportHelperCandidateRow = ImportHelperResponse["rows"][number];
export type MouserEnrichmentRow = MouserEnrichmentResponse["rows"][number];

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
  const parsed = genericImportHelperRequestSchema.safeParse({
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

export function createMouserEnrichmentRequest({
  fileSha256,
  lineItems,
  activeCategories,
  relevantLocations = [],
}: {
  fileSha256: string;
  lineItems: MouserLineItemInput[];
  activeCategories: MouserEnrichmentRequest["activeCategories"];
  relevantLocations?: NonNullable<MouserEnrichmentRequest["relevantLocations"]>;
}): MouserEnrichmentRequest {
  const parsed = mouserEnrichmentRequestSchema.safeParse({
    mode: "MOUSER_LINE_ITEM_ENRICHMENT",
    schemaVersion: MOUSER_ENRICHMENT_SCHEMA_VERSION,
    document: { sha256: fileSha256 },
    lineItems,
    activeCategories,
    relevantLocations,
  });
  if (!parsed.success) {
    throw new ImportHelperValidationError(
      "Shelf generated an invalid Mouser enrichment request."
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
  requestInput: AnyImportHelperRequest | unknown
): AnyImportHelperResponse {
  const requestResult = importHelperRequestSchema.safeParse(requestInput);
  if (!requestResult.success) {
    throw new ImportHelperValidationError(
      "The Shelf helper request is invalid."
    );
  }
  const request = requestResult.data;
  if ("mode" in request) {
    if (request.mode === "LOCATION_STRUCTURE") {
      const parsed = locationStructureResponseSchema.safeParse(response);
      if (!parsed.success)
        throw new ImportHelperValidationError(
          "The helper returned a malformed location structure proposal."
        );
      const locationIds = new Set(
        request.existingLocations.map(({ id }) => id)
      );
      const temporaryIds = new Set<string>();
      for (const operation of parsed.data.operations) {
        if (temporaryIds.has(operation.temporaryId))
          throw new ImportHelperValidationError(
            "The helper returned duplicate temporary location IDs."
          );
        if (
          operation.parentLocationId &&
          !locationIds.has(operation.parentLocationId)
        )
          throw new ImportHelperValidationError(
            "The helper referenced a location outside the supplied organization hierarchy."
          );
        if (
          operation.parentTemporaryId &&
          !temporaryIds.has(operation.parentTemporaryId)
        )
          throw new ImportHelperValidationError(
            "The helper returned a child before its proposed parent."
          );
        if (operation.parentLocationId && operation.parentTemporaryId)
          throw new ImportHelperValidationError(
            "A location may have only one parent reference."
          );
        temporaryIds.add(operation.temporaryId);
      }
      return parsed.data;
    }
    if (request.mode === "INVENTORY_REORGANIZATION") {
      const parsed = reorganizationResponseSchema.safeParse(response);
      if (!parsed.success)
        throw new ImportHelperValidationError(
          "The helper returned a malformed inventory reorganization response."
        );
      const modelIds = new Set(request.items.map(({ modelId }) => modelId));
      const categoryIds = new Set(request.categories.map(({ id }) => id));
      const locationIds = new Set(request.locations.map(({ id }) => id));
      const seen = new Set<string>();
      for (const proposal of parsed.data.proposals) {
        if (!modelIds.has(proposal.modelId) || seen.has(proposal.modelId))
          throw new ImportHelperValidationError(
            "The helper returned an unknown or duplicate model ID."
          );
        seen.add(proposal.modelId);
        if (
          proposal.suggestedCategoryId &&
          !categoryIds.has(proposal.suggestedCategoryId)
        ) {
          proposal.suggestedCategoryId = null;
          proposal.categoryConfidence = 0;
        }
        if (
          proposal.suggestedLocationId &&
          !locationIds.has(proposal.suggestedLocationId)
        ) {
          proposal.suggestedLocationId = null;
          proposal.locationConfidence = 0;
        }
      }
      return parsed.data;
    }
    const responseResult = mouserEnrichmentResponseSchema.safeParse(response);
    if (!responseResult.success) {
      throw new ImportHelperValidationError(
        "The helper returned a malformed Mouser enrichment response."
      );
    }
    const parsedResult = responseResult.data;
    const inputBySourceRef = new Map(
      request.lineItems.map((lineItem) => [lineItem.sourceRef, lineItem])
    );
    const categoryIds = new Set(request.activeCategories.map(({ id }) => id));
    const locationIds = new Set(
      (request.relevantLocations ?? []).map(({ id }) => id)
    );
    if (parsedResult.rows.length !== request.lineItems.length) {
      throw new ImportHelperValidationError(
        "The helper must return exactly one enriched row for each grouped Mouser line item."
      );
    }
    const seenSourceRefs = new Set<string>();
    parsedResult.rows.forEach((row, rowIndex) => {
      const input = inputBySourceRef.get(row.sourceRef);
      if (!input || seenSourceRefs.has(row.sourceRef)) {
        throw new ImportHelperValidationError(
          `Helper response references an unknown or duplicate Mouser line at rows.${rowIndex}.sourceRef.`
        );
      }
      seenSourceRefs.add(row.sourceRef);
      if (
        row.supplierProductNumber !== input.supplierProductNumber ||
        row.mpn !== input.mpn ||
        row.quantity !== input.quantity
      ) {
        throw new ImportHelperValidationError(
          `Helper response changed a deterministic Mouser identifier or quantity at rows.${rowIndex}.`
        );
      }
      if (row.categoryId && !categoryIds.has(row.categoryId)) {
        row.categoryId = null;
        row.categoryConfidence = 0;
      }
      if (row.locationId && !locationIds.has(row.locationId)) {
        row.locationId = null;
        row.locationConfidence = 0;
      }
    });
    return parsedResult;
  }

  const responseResult = importHelperResponseSchema.safeParse(response);
  if (!responseResult.success) {
    throw new ImportHelperValidationError(
      "The helper returned a malformed or unsupported response."
    );
  }

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
      row.categorySuggestion.categoryId = null;
      row.categorySuggestion.confidence = 0;
    }
    row.locationSuggestions = row.locationSuggestions.filter((suggestion) =>
      locationIds.has(suggestion.locationId)
    );
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
  request: AnyImportHelperRequest
): AnyImportHelperResponse {
  let response: unknown;
  try {
    response = JSON.parse(responseText);
  } catch {
    throw new ImportHelperValidationError("The helper returned invalid JSON.");
  }
  return validateImportHelperResponse(response, request);
}
