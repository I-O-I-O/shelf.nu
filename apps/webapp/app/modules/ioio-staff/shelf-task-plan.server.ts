import { z } from "zod";
import { inferLocationRole, locationRoleSchema } from "./location-role.server";

const name = z.string().trim().min(1).max(300);
export type LocationTaskRef = {
  name: string;
  role?: z.infer<typeof locationRoleSchema>;
  withinRef?: LocationTaskRef;
};
const locationRef: z.ZodType<LocationTaskRef> = z.lazy(() =>
  z
    .object({
      name,
      role: locationRoleSchema.optional(),
      withinRef: locationRef.optional(),
    })
    .strict()
);
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
const quantity = z.union([
  z.object({ mode: z.literal("ALL") }).strict(),
  z
    .object({
      mode: z.literal("COUNT"),
      count: z.number().int().positive().max(100),
    })
    .strict(),
  z
    .object({
      mode: z.literal("FRACTION"),
      numerator: z.number().int().positive().max(100),
      denominator: z.number().int().positive().max(100),
    })
    .strict(),
]);
export const shelfTaskSourceSchema = z.union([
  z.object({ type: z.literal("SHELF_LOCATIONS") }).strict(),
  z.object({ type: z.literal("SHELF_INVENTORY") }).strict(),
  z
    .object({
      type: z.literal("UPLOADED_FILE"),
      fileType: z.enum(["PDF", "CSV", "XLSX"]),
      sourceRef: key,
    })
    .strict(),
]);
const stepSchema = z.union([
  z
    .object({
      id: key,
      capability: z.literal("RESOLVE_LOCATION"),
      ref: locationRef,
      within: key.optional(),
    })
    .strict(),
  z
    .object({
      id: key,
      capability: z.literal("SELECT_LOCATIONS"),
      within: key,
      role: locationRoleSchema,
    })
    .strict(),
  z
    .object({
      id: key,
      capability: z.literal("READ_LOCATION_TREE"),
      within: key,
    })
    .strict(),
  z
    .object({
      id: key,
      capability: z.literal("READ_INVENTORY_SUMMARY"),
      within: key,
    })
    .strict(),
  z
    .object({
      id: key,
      capability: z.literal("SELECT_MODELS"),
      selection: z.enum([
        "STAFF_SELECTED",
        "INSTRUCTION_SCOPE",
        "EXPLICIT_PRODUCTS",
      ]),
    })
    .strict(),
  z
    .object({
      id: key,
      capability: z.literal("PROPOSE_DELETE_LOCATIONS"),
      selection: key,
      quantity,
    })
    .strict(),
  z
    .object({
      id: key,
      capability: z.literal("PROPOSE_LOCATION_CHANGE"),
      selection: key,
      placementPressure: z.enum(["NORMAL", "USER_REPORTED_HIGH"]),
    })
    .strict(),
  z
    .object({
      id: key,
      capability: z.literal("PROPOSE_CREATE_LOCATION"),
      within: key.optional(),
      name,
      description: z.string().max(500).nullable(),
    })
    .strict(),
]);
export const shelfTaskPlanSchema = z
  .object({
    taskType: z.enum(["STRUCTURE_CHANGE", "INVENTORY_PLACEMENT", "ANALYSIS"]),
    goal: z.string().min(1).max(2000),
    inventorySelectionMode: z
      .enum(["EXPLICIT_PRODUCTS", "SELECTED_PRODUCTS", "SCOPED_QUERY"])
      .optional(),
    inventoryRefs: z
      .array(
        z
          .object({
            name,
            contextualQuantity: z.number().nonnegative().optional(),
            currentLocationRef: locationRef.optional(),
          })
          .strict()
      )
      .max(100)
      .optional(),
    locationRefs: z.array(locationRef).max(100).optional(),
    candidateDestinationScope: locationRef.optional(),
    sources: z.array(shelfTaskSourceSchema).min(1).max(5),
    steps: z.array(stepSchema).min(1).max(100),
    writesRequested: z.boolean(),
    mutationPolicy: z.literal("PROPOSAL_ONLY"),
    expectedOutput: z.enum([
      "LOCATION_PROPOSAL",
      "INVENTORY_PROPOSAL",
      "LOCATION_SUMMARY",
    ]),
  })
  .strict();
export type ShelfTaskPlan = z.infer<typeof shelfTaskPlanSchema>;

/** Separate authority boundary. A syntactically valid helper plan is not executable yet. */
export function validateShelfTaskPlan(input: unknown): ShelfTaskPlan {
  const plan = shelfTaskPlanSchema.parse(input);
  if (
    plan.steps.some(
      (step) =>
        step.capability === "SELECT_MODELS" &&
        step.selection === "EXPLICIT_PRODUCTS"
    ) &&
    !plan.inventoryRefs?.length
  )
    throw new Error(
      "Explicit product selection requires inventory references."
    );
  const steps = new Map<string, ShelfTaskPlan["steps"][number]>();
  let mutations = false;
  if (
    plan.steps.some((step) =>
      [
        "RESOLVE_LOCATION",
        "SELECT_LOCATIONS",
        "READ_LOCATION_TREE",
        "PROPOSE_CREATE_LOCATION",
        "PROPOSE_DELETE_LOCATIONS",
        "PROPOSE_LOCATION_CHANGE",
      ].includes(step.capability)
    ) &&
    !plan.sources.some(({ type }) => type === "SHELF_LOCATIONS")
  )
    throw new Error("Location capabilities require Shelf locations.");
  // File sources are representable, but this executor cannot read arbitrary uploads.
  if (plan.sources.some(({ type }) => type === "UPLOADED_FILE"))
    throw new Error(
      "Uploaded-file execution is not supported by this executor."
    );
  const depth = (ref: LocationTaskRef, level = 0): void => {
    if (level > 5) throw new Error("Location reference is too deeply nested.");
    if (ref.withinRef) depth(ref.withinRef, level + 1);
  };
  for (const step of plan.steps) {
    if (steps.has(step.id)) throw new Error("Duplicate task step.");
    if ("within" in step && step.within) {
      const parent = steps.get(step.within);
      if (
        !parent ||
        !["RESOLVE_LOCATION", "PROPOSE_CREATE_LOCATION"].includes(
          parent.capability
        )
      )
        throw new Error("Invalid location dependency.");
      if (
        parent.capability === "PROPOSE_CREATE_LOCATION" &&
        step.capability !== "PROPOSE_CREATE_LOCATION"
      )
        throw new Error("Read/select requires an existing location.");
    }
    if (step.capability === "RESOLVE_LOCATION") depth(step.ref);
    if (
      step.capability === "READ_INVENTORY_SUMMARY" &&
      !plan.sources.some(({ type }) => type === "SHELF_INVENTORY")
    )
      throw new Error("Inventory summary requires an inventory source.");
    if (step.capability === "SELECT_MODELS") {
      if (!plan.sources.some(({ type }) => type === "SHELF_INVENTORY"))
        throw new Error("Model selection requires a Shelf inventory source.");
    }
    if (step.capability === "PROPOSE_DELETE_LOCATIONS") {
      const selection = steps.get(step.selection);
      if (
        selection?.capability !== "SELECT_LOCATIONS" ||
        !["CONTAINER", "DRAWER"].includes(selection.role)
      )
        throw new Error("Deletion requires a supported typed selection.");
      const scope = steps.get(selection.within);
      if (scope?.capability !== "RESOLVE_LOCATION")
        throw new Error("Deletion requires a resolved scope.");
      if (
        step.quantity.mode === "FRACTION" &&
        step.quantity.numerator > step.quantity.denominator
      )
        throw new Error("Invalid quantity fraction.");
      mutations = true;
    }
    if (step.capability === "PROPOSE_CREATE_LOCATION") mutations = true;
    if (step.capability === "PROPOSE_LOCATION_CHANGE") {
      const selection = steps.get(step.selection);
      if (selection?.capability !== "SELECT_MODELS")
        throw new Error("Location changes require a selected model set.");
      if (!plan.sources.some(({ type }) => type === "SHELF_INVENTORY"))
        throw new Error("Location changes require a Shelf inventory source.");
      if (!plan.sources.some(({ type }) => type === "SHELF_LOCATIONS"))
        throw new Error("Location changes require a Shelf location source.");
      mutations = true;
    }
    steps.set(step.id, step);
  }
  if (
    !mutations &&
    !plan.steps.some(
      ({ capability }) =>
        capability === "READ_LOCATION_TREE" ||
        capability === "READ_INVENTORY_SUMMARY"
    )
  )
    throw new Error("Analysis requires an explicit read capability.");
  if (
    mutations !== plan.writesRequested ||
    (plan.taskType === "ANALYSIS") === mutations ||
    (plan.taskType === "INVENTORY_PLACEMENT") !==
      plan.steps.some(
        (step) => step.capability === "PROPOSE_LOCATION_CHANGE"
      ) ||
    (plan.expectedOutput === "LOCATION_SUMMARY") === mutations ||
    (plan.expectedOutput === "INVENTORY_PROPOSAL") !==
      plan.steps.some(
        (step) => step.capability === "PROPOSE_LOCATION_CHANGE"
      ) ||
    (plan.expectedOutput === "LOCATION_PROPOSAL") !==
      plan.steps.some(
        (step) =>
          step.capability === "PROPOSE_CREATE_LOCATION" ||
          step.capability === "PROPOSE_DELETE_LOCATIONS"
      )
  )
    throw new Error("Task mutation/output policy is inconsistent.");
  if (
    mutations &&
    plan.steps.some((step) => step.capability.startsWith("READ_"))
  )
    throw new Error(
      "Split combined analysis and mutation into separately reviewed tasks."
    );
  return plan;
}

type Location = { id: string; name: string; parentId: string | null };
const normalize = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
export function locationDescendants(
  locations: Location[],
  root: string
): Location[] {
  const ids = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const location of locations)
      if (
        location.parentId &&
        ids.has(location.parentId) &&
        !ids.has(location.id)
      ) {
        ids.add(location.id);
        changed = true;
      }
  }
  return locations.filter(({ id }) => id !== root && ids.has(id));
}

/** Resolve the outer reference first; child resolution never widens that branch. */
export function resolveTaskLocation(
  ref: LocationTaskRef,
  locations: Location[],
  within?: string,
  selectedId?: string
): { id: string | null; candidates: string[] } {
  let scope = within;
  if (ref.withinRef) {
    const ancestor = resolveTaskLocation(
      ref.withinRef,
      locations,
      within,
      selectedId
    );
    if (!ancestor.id) return ancestor;
    scope = ancestor.id;
  }
  const candidates = (
    scope ? locationDescendants(locations, scope) : locations
  ).filter((location) => !ref.role || inferLocationRole(location) === ref.role);
  const ownName = normalize(ref.name);
  const exact = candidates.filter(({ name }) => normalize(name) === ownName);
  // Only own-name suffixes such as room codes are tolerated. No path-token fallback.
  const matches = exact.length
    ? exact
    : candidates.filter(
        ({ name }) =>
          normalize(name.replace(/\s*-\s*[a-z]\d+$/i, "")) === ownName ||
          (ownName === "storage" &&
            normalize(name.replace(/\s*-\s*[a-z]\d+$/i, "")) === "storage room")
      );
  return {
    id:
      matches.length === 1
        ? matches[0]!.id
        : selectedId && matches.some(({ id }) => id === selectedId)
        ? selectedId
        : null,
    candidates: matches.map(({ id }) => id),
  };
}

export function resolveTaskSteps(
  planInput: unknown,
  locations: Location[],
  selectedId?: string
) {
  const plan = validateShelfTaskPlan(planInput);
  const resolved = new Map<string, string>();
  const unresolved: Array<{
    stepId: string;
    ref: LocationTaskRef;
    candidateIds: string[];
  }> = [];
  for (const step of plan.steps)
    if (step.capability === "RESOLVE_LOCATION") {
      if (step.within && !resolved.has(step.within)) {
        unresolved.push({ stepId: step.id, ref: step.ref, candidateIds: [] });
        continue;
      }
      const match = resolveTaskLocation(
        step.ref,
        locations,
        step.within ? resolved.get(step.within) : undefined,
        selectedId
      );
      if (match.id) resolved.set(step.id, match.id);
      else
        unresolved.push({
          stepId: step.id,
          ref: step.ref,
          candidateIds: match.candidates,
        });
    }
  return { plan, resolved, unresolved };
}

// CLI output constraint mirrors the runtime schema; the independent validator
// still checks dependencies and mutation policy before state is retrieved.
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties)
) => ({ type: "object", additionalProperties: false, properties, required });
const string = { type: "string", minLength: 1, maxLength: 300 };
const id = { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,79}$" };
const ref = { $ref: "#/$defs/locationRef" };
const role = { type: "string", enum: locationRoleSchema.options };
const withStep = (
  capability: string,
  fields: Record<string, unknown>,
  required?: string[]
) =>
  object({ id, capability: { const: capability }, ...fields }, [
    "id",
    "capability",
    ...(required ?? Object.keys(fields)),
  ]);
export const SHELF_TASK_RESPONSE_JSON_SCHEMA = {
  ...object({
    mode: { const: "SHELF_TASK_PLAN" },
    schemaVersion: { const: 1 },
    taskPlan: object(
      {
        taskType: {
          enum: ["STRUCTURE_CHANGE", "INVENTORY_PLACEMENT", "ANALYSIS"],
        },
        goal: { type: "string", minLength: 1, maxLength: 2000 },
        inventorySelectionMode: {
          enum: ["EXPLICIT_PRODUCTS", "SELECTED_PRODUCTS", "SCOPED_QUERY"],
        },
        inventoryRefs: {
          type: "array",
          maxItems: 100,
          items: object(
            {
              name: string,
              contextualQuantity: { type: "number", minimum: 0 },
              currentLocationRef: ref,
            },
            ["name"]
          ),
        },
        locationRefs: { type: "array", maxItems: 100, items: ref },
        candidateDestinationScope: ref,
        sources: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            oneOf: [
              object({ type: { const: "SHELF_LOCATIONS" } }),
              object({ type: { const: "SHELF_INVENTORY" } }),
              object({
                type: { const: "UPLOADED_FILE" },
                fileType: { enum: ["PDF", "CSV", "XLSX"] },
                sourceRef: id,
              }),
            ],
          },
        },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            oneOf: [
              withStep("RESOLVE_LOCATION", { ref, within: id }, ["ref"]),
              withStep("SELECT_LOCATIONS", { within: id, role }),
              withStep("READ_LOCATION_TREE", { within: id }),
              withStep("READ_INVENTORY_SUMMARY", { within: id }),
              withStep("SELECT_MODELS", {
                selection: {
                  enum: [
                    "STAFF_SELECTED",
                    "INSTRUCTION_SCOPE",
                    "EXPLICIT_PRODUCTS",
                  ],
                },
              }),
              withStep("PROPOSE_DELETE_LOCATIONS", {
                selection: id,
                quantity: {
                  oneOf: [
                    object({ mode: { const: "ALL" } }),
                    object({
                      mode: { const: "COUNT" },
                      count: { type: "integer", minimum: 1, maximum: 100 },
                    }),
                    object({
                      mode: { const: "FRACTION" },
                      numerator: { type: "integer", minimum: 1, maximum: 100 },
                      denominator: {
                        type: "integer",
                        minimum: 1,
                        maximum: 100,
                      },
                    }),
                  ],
                },
              }),
              withStep("PROPOSE_LOCATION_CHANGE", {
                selection: id,
                placementPressure: {
                  enum: ["NORMAL", "USER_REPORTED_HIGH"],
                },
              }),
              withStep(
                "PROPOSE_CREATE_LOCATION",
                {
                  within: id,
                  name: string,
                  description: {
                    anyOf: [
                      { type: "string", maxLength: 500 },
                      { type: "null" },
                    ],
                  },
                },
                ["name", "description"]
              ),
            ],
          },
        },
        writesRequested: { type: "boolean" },
        mutationPolicy: { const: "PROPOSAL_ONLY" },
        expectedOutput: {
          enum: ["LOCATION_PROPOSAL", "INVENTORY_PROPOSAL", "LOCATION_SUMMARY"],
        },
      },
      [
        "taskType",
        "goal",
        "sources",
        "steps",
        "writesRequested",
        "mutationPolicy",
        "expectedOutput",
      ]
    ),
  }),
  $defs: {
    locationRef: object({ name: string, role, withinRef: ref }, ["name"]),
  },
};
