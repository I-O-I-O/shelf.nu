import { db } from "~/database/db.server";
import { requestImportHelperProposal } from "~/modules/ioio-staff/import-helper-client.server";
import {
  MAX_REORGANIZATION_CATEGORIES,
  MAX_REORGANIZATION_LOCATIONS,
  MAX_REORGANIZATION_MODELS_PER_BATCH,
  type AnyImportHelperRequest,
} from "~/modules/ioio-staff/import-helper-contract.server";
import { MAX_ORGANIZE_SELECTED_MODELS } from "~/modules/ioio-staff/organize-selection";
import {
  validateShelfTaskPlan,
  resolveTaskLocation,
  locationDescendants,
  type ShelfTaskPlan,
} from "~/modules/ioio-staff/shelf-task-plan.server";
import { Logger } from "~/utils/logger";
import {
  findMentionedProducts,
  resolveInventoryReference,
  normalizeInventoryName,
  type InventoryReference,
} from "./inventory-grounding";

export const MAX_SELECTED_MODELS_FOR_ORGANIZE = MAX_ORGANIZE_SELECTED_MODELS;
const MAX_MODELS_PER_REORGANIZATION_RUN = 500;
const MAX_CANDIDATES_PER_MODEL = 15;
const MAX_UNIQUE_CANDIDATE_LOCATIONS_PER_BATCH = MAX_REORGANIZATION_LOCATIONS;

export type LocationSnapshot = {
  modelCatalog?: Array<{ id: string; name: string }>;
  locations: Array<{
    id: string;
    name: string;
    path: string;
    parentId: string | null;
    hierarchyDepth: number;
    childCount: number;
    assignable: boolean;
    description: string | null;
    modelCount: number;
    assetCount: number;
    unitCount: number;
    categoryDistribution: Array<{
      categoryId: string;
      name: string;
      count: number;
    }>;
    representativeConcepts: string[];
  }>;
  categories: Array<{
    id: string;
    name: string;
    description: string | null;
    modelCount: number;
    commonLocations: Array<{ locationId: string; path: string; count: number }>;
    representativeConcepts: string[];
  }>;
};

const tokens = (text: string) =>
  [...new Set(text.toLowerCase().match(/[a-z0-9-]{3,}/g) ?? [])].slice(0, 8);

export async function buildLocationIntelligenceSnapshot(
  organizationId: string
): Promise<LocationSnapshot> {
  const [locations, categories, models, placements] = await Promise.all([
    db.location.findMany({
      where: { organizationId },
      select: { id: true, name: true, parentId: true, description: true },
    }),
    db.category.findMany({
      where: { organizationId },
      select: { id: true, name: true, description: true },
    }),
    db.assetModel.findMany({
      where: { organizationId },
      select: {
        id: true,
        name: true,
        defaultCategoryId: true,
        assets: {
          where: { organizationId },
          select: {
            quantity: true,
            categoryId: true,
            assetLocations: {
              where: { organizationId, assetKitId: null },
              select: { locationId: true, quantity: true },
            },
          },
        },
      },
    }),
    db.assetLocation.findMany({
      where: { organizationId, assetKitId: null },
      select: {
        assetId: true,
        locationId: true,
        quantity: true,
        asset: { select: { assetModelId: true, categoryId: true } },
      },
    }),
  ]);
  const locationById = new Map(
    locations.map((location) => [location.id, location])
  );
  const paths = new Map<string, { path: string; depth: number }>();
  const getPath = (
    id: string,
    seen = new Set<string>()
  ): { path: string; depth: number } => {
    const cached = paths.get(id);
    if (cached) return cached;
    const location = locationById.get(id);
    if (!location) return { path: "", depth: 0 };
    if (seen.has(id)) return { path: location.name, depth: 0 };
    seen.add(id);
    const parent = location.parentId ? getPath(location.parentId, seen) : null;
    const result = {
      path: parent?.path ? `${parent.path} / ${location.name}` : location.name,
      depth: parent ? parent.depth + 1 : 0,
    };
    paths.set(id, result);
    return result;
  };
  const modelIdsByLocation = new Map<string, Set<string>>();
  const assetsByLocation = new Map<string, Set<string>>();
  const categoryCountsByLocation = new Map<string, Map<string, number>>();
  const locationsByCategory = new Map<string, Map<string, number>>();
  const unitsByLocation = new Map<string, number>();
  const conceptsByLocation = new Map<string, Set<string>>();
  for (const placement of placements) {
    const { locationId, assetId, asset } = placement;
    if (asset.assetModelId) {
      const set = modelIdsByLocation.get(locationId) ?? new Set();
      set.add(asset.assetModelId);
      modelIdsByLocation.set(locationId, set);
    }
    const assetSet = assetsByLocation.get(locationId) ?? new Set();
    assetSet.add(assetId);
    assetsByLocation.set(locationId, assetSet);
    unitsByLocation.set(
      locationId,
      (unitsByLocation.get(locationId) ?? 0) + (placement.quantity ?? 1)
    );
    if (asset.categoryId) {
      const map = categoryCountsByLocation.get(locationId) ?? new Map();
      map.set(asset.categoryId, (map.get(asset.categoryId) ?? 0) + 1);
      categoryCountsByLocation.set(locationId, map);
      const reverse = locationsByCategory.get(asset.categoryId) ?? new Map();
      reverse.set(locationId, (reverse.get(locationId) ?? 0) + 1);
      locationsByCategory.set(asset.categoryId, reverse);
    }
  }
  for (const model of models) {
    for (const asset of model.assets) {
      for (const placement of asset.assetLocations) {
        const concepts =
          conceptsByLocation.get(placement.locationId) ?? new Set();
        for (const token of tokens(model.name)) concepts.add(token);
        conceptsByLocation.set(placement.locationId, concepts);
      }
    }
  }
  const catName = new Map(
    categories.map((category) => [category.id, category.name])
  );
  const childCounts = new Map<string, number>();
  for (const location of locations)
    if (location.parentId)
      childCounts.set(
        location.parentId,
        (childCounts.get(location.parentId) ?? 0) + 1
      );
  const snapshotLocations = locations.map((location) => {
    const path = getPath(location.id);
    const distribution = [
      ...(categoryCountsByLocation.get(location.id) ?? new Map()),
    ]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([categoryId, count]) => ({
        categoryId,
        name: catName.get(categoryId) ?? "Unknown",
        count,
      }));
    return {
      id: location.id,
      name: location.name,
      path: path.path,
      parentId: location.parentId,
      hierarchyDepth: path.depth,
      childCount: childCounts.get(location.id) ?? 0,
      assignable: true,
      description: location.description,
      modelCount: modelIdsByLocation.get(location.id)?.size ?? 0,
      assetCount: assetsByLocation.get(location.id)?.size ?? 0,
      unitCount: unitsByLocation.get(location.id) ?? 0,
      categoryDistribution: distribution,
      representativeConcepts: tokens(
        `${location.name} ${location.description ?? ""} ${distribution
          .map((entry) => entry.name)
          .join(" ")} ${[...(conceptsByLocation.get(location.id) ?? [])].join(
          " "
        )}`
      ).slice(0, 12),
    };
  });
  return {
    modelCatalog: models.map(({ id, name }) => ({ id, name })),
    locations: snapshotLocations,
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      description: category.description,
      modelCount: models.filter(
        (model) =>
          model.defaultCategoryId === category.id ||
          model.assets.some((asset) => asset.categoryId === category.id)
      ).length,
      commonLocations: [...(locationsByCategory.get(category.id) ?? new Map())]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([locationId, count]) => ({
          locationId,
          path: paths.get(locationId)?.path ?? "",
          count,
        })),
      representativeConcepts: tokens(
        `${category.name} ${category.description ?? ""}`
      ),
    })),
  };
}

type PlacementPressure = "NORMAL" | "USER_REPORTED_HIGH";
type PlacementStrength =
  | "RECOMMENDED"
  | "SUGGESTED"
  | "POSSIBLE"
  | "KEEP_CURRENT"
  | "UNRESOLVED";
type PlacementFailureReason =
  | "NO_VALID_CANDIDATES"
  | "CURRENT_LOCATION_BEST"
  | "AMBIGUOUS"
  | "HELPER_FAILED"
  | "VALIDATION_REJECTED";

function inferPlacementPressure(instruction: string): PlacementPressure {
  return /\b(overflow(?:ing)?|too full|too crowded|overcrowded|overcrowding|redistribution|reduces? concentration|spread (?:these|them|the items)?\s*out|need more space|move (?:these|them|the items) elsewhere)\b/i.test(
    instruction
  )
    ? "USER_REPORTED_HIGH"
    : "NORMAL";
}

function refersToUnselectedItems(instruction: string) {
  return (
    /\b(these|those|this|that|selected)\s+(items?|products?|assets?|models?)\b/i.test(
      instruction
    ) ||
    /\bwhere else could this go\b|\bspread (?:these|them) out\b/i.test(
      instruction
    )
  );
}

function conceptTokens(value: string) {
  return tokens(value).map((token) =>
    token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token
  );
}

type RankedPlacementLocation = LocationSnapshot["locations"][number] & {
  score: number;
  rawScore: number;
};

export function rankPlacementLocations(input: {
  locations: LocationSnapshot["locations"];
  productName: string;
  categoryName: string | null;
  categoryId: string | null;
  currentLocationIds: string[];
  selectedCurrentLocationCounts: Map<string, number>;
  placementPressure: PlacementPressure;
}): RankedPlacementLocation[] {
  const productConcepts = new Set(
    conceptTokens(`${input.productName} ${input.categoryName ?? ""}`)
  );
  return input.locations
    .filter((location) => location.assignable)
    .map((location) => {
      const categoryPlacement = location.categoryDistribution.find(
        (entry) => entry.categoryId === input.categoryId
      );
      const semanticMatches = location.representativeConcepts.filter((token) =>
        productConcepts.has(
          token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token
        )
      ).length;
      const genericStorage =
        /\b(storage|electronics|workshop|robotics|prototyping|general)\b/i.test(
          location.path
        );
      const emptyBonus = location.assetCount === 0 ? 4 : 0;
      const lightUseBonus =
        location.assetCount > 0 && location.assetCount <= 3 ? 2 : 0;
      const rawScore =
        (categoryPlacement
          ? 10 + Math.min(categoryPlacement.count, 20) * 0.2
          : 0) +
        semanticMatches * 2.5 +
        emptyBonus +
        lightUseBonus +
        (location.childCount === 0 ? 1.5 : 0) +
        Math.min(location.hierarchyDepth, 4) * 0.35 +
        (genericStorage ? 1 : 0);
      let score = rawScore;
      if (input.currentLocationIds.includes(location.id)) {
        score -= input.placementPressure === "USER_REPORTED_HIGH" ? 12 : 0;
        if (input.placementPressure === "USER_REPORTED_HIGH")
          score -=
            Math.max(
              0,
              (input.selectedCurrentLocationCounts.get(location.id) ?? 1) - 1
            ) * 3;
      } else if (
        input.placementPressure === "USER_REPORTED_HIGH" &&
        input.selectedCurrentLocationCounts.has(location.id)
      ) {
        score -= 2;
      }
      const hasPlacementEvidence =
        Boolean(categoryPlacement) || semanticMatches > 0 || genericStorage;
      const eligible =
        hasPlacementEvidence ||
        (location.assetCount === 0 && genericStorage) ||
        (location.assetCount > 0 && location.assetCount <= 3 && genericStorage);
      return { ...location, score, rawScore, eligible };
    })
    .filter((location) => location.eligible)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.hierarchyDepth - left.hierarchyDepth ||
        left.path.localeCompare(right.path, undefined, { numeric: true })
    )
    .map(({ eligible: _eligible, ...location }) => location);
}

export function currentPlacementIsBest(input: {
  placementPressure: PlacementPressure;
  currentScore: number;
  bestAlternativeScore: number;
  currentRawScore: number;
  bestAlternativeRawScore: number;
}) {
  return input.placementPressure === "USER_REPORTED_HIGH"
    ? input.currentRawScore >= input.bestAlternativeRawScore + 6
    : input.currentScore >= input.bestAlternativeScore + 3;
}

export function createInventoryPlacementTaskPlan(input: {
  instruction: string;
  hasStaffSelection: boolean;
  inventoryRefs?: InventoryReference[];
  placementPressure: PlacementPressure;
}): ShelfTaskPlan {
  return validateShelfTaskPlan({
    taskType: "INVENTORY_PLACEMENT",
    goal: input.instruction,
    inventorySelectionMode: input.inventoryRefs?.length
      ? "EXPLICIT_PRODUCTS"
      : input.hasStaffSelection
      ? "SELECTED_PRODUCTS"
      : "SCOPED_QUERY",
    inventoryRefs: input.inventoryRefs ?? [],
    sources: [{ type: "SHELF_INVENTORY" }, { type: "SHELF_LOCATIONS" }],
    steps: [
      {
        id: "selected-models",
        capability: "SELECT_MODELS",
        selection: input.inventoryRefs?.length
          ? "EXPLICIT_PRODUCTS"
          : input.hasStaffSelection
          ? "STAFF_SELECTED"
          : "INSTRUCTION_SCOPE",
      },
      {
        id: "placement-proposal",
        capability: "PROPOSE_LOCATION_CHANGE",
        selection: "selected-models",
        placementPressure: input.placementPressure,
      },
    ],
    writesRequested: true,
    mutationPolicy: "PROPOSAL_ONLY",
    expectedOutput: "INVENTORY_PROPOSAL",
  });
}

export async function generateInventoryOrganizationProposal(input: {
  organizationId: string;
  instruction: string;
  categoryIds?: string[];
  locationIds?: string[];
  selectedModelIds?: string[];
  inventoryRefs?: InventoryReference[];
  referenceChoices?: Record<string, string>;
}) {
  const startedAt = Date.now();
  let selectedModelIds = [...new Set(input.selectedModelIds ?? [])];
  const staffSelectedCount = selectedModelIds.length;
  if (selectedModelIds.length > MAX_SELECTED_MODELS_FOR_ORGANIZE)
    throw new Error(
      `Select no more than ${MAX_SELECTED_MODELS_FOR_ORGANIZE} products at a time.`
    );
  const placementPressure = inferPlacementPressure(input.instruction);
  let taskPlan = createInventoryPlacementTaskPlan({
    instruction: input.instruction,
    hasStaffSelection: selectedModelIds.length > 0,
    placementPressure,
  });
  const snapshot = await buildLocationIntelligenceSnapshot(
    input.organizationId
  );
  const catalog = snapshot.modelCatalog ?? [];
  const mentioned = findMentionedProducts(input.instruction, catalog);
  if (
    selectedModelIds.length === 0 &&
    !input.inventoryRefs?.length &&
    mentioned.length === 0 &&
    refersToUnselectedItems(input.instruction)
  ) {
    const diagnostics = {
      selectedModelCount: 0,
      modelsConsidered: 0,
      modelsSentToClaude: 0,
      categoriesSent: 0,
      locationsSent: 0,
      candidateLocationCountBeforeRanking: 0,
      candidateLocationCountAfterRanking: 0,
      locationsSentToClaude: 0,
      batches: 0,
      helperFailures: 0,
      requestBytes: 0,
      placementPressure,
      recommendedCount: 0,
      suggestedCount: 0,
      keepCount: 0,
      unresolvedCount: 0,
      reasonCounts: {},
      requiresSelection: true,
      validationRejectedCount: 0,
      analysisScope: "No explicit staff selection was supplied",
      durationMs: Date.now() - startedAt,
    };
    Logger.info({
      event: "ioio_inventory_organization_analysis",
      taskType: taskPlan.taskType,
      plannerUsed: "DETERMINISTIC_TASK_PLAN",
      fastPathUsed: false,
      capabilitiesRequested: taskPlan.steps.map((step) => step.capability),
      selectedModelIdsCount: 0,
      referencesResolved: 0,
      referencesUnresolved: 0,
      sourcesUsed: taskPlan.sources.map((source) => source.type),
      proposalOperationCount: 0,
      ...diagnostics,
    });
    return { proposalItems: [], diagnostics, previewOnly: true };
  }

  let inventoryRefs = input.inventoryRefs ?? mentioned;
  let plannerUsed = false;
  let plannerScopedQuery = false;
  let locationRefs: NonNullable<ShelfTaskPlan["locationRefs"]> =
    findMentionedProducts(input.instruction, snapshot.locations);
  let destinationScope: ShelfTaskPlan["candidateDestinationScope"];
  if (!staffSelectedCount && !input.inventoryRefs) {
    const interpretation = await requestImportHelperProposal({
      mode: "SHELF_TASK_PLAN",
      schemaVersion: 1,
      instruction: input.instruction,
      availableSources: [
        { type: "SHELF_LOCATIONS" },
        { type: "SHELF_INVENTORY" },
      ],
      locationContext: snapshot.locations
        .filter(
          (location) =>
            !location.parentId ||
            input.instruction
              .toLowerCase()
              .includes(location.name.toLowerCase())
        )
        .slice(0, 100)
        .map(({ name, path, childCount }) => ({
          name,
          path,
          childSummary: `${childCount} direct children`,
        })),
    });
    if (
      interpretation.status === "ready" &&
      "mode" in interpretation.proposal &&
      interpretation.proposal.mode === "SHELF_TASK_PLAN"
    ) {
      const interpreted = validateShelfTaskPlan(
        interpretation.proposal.taskPlan
      );
      if (interpreted.taskType !== "INVENTORY_PLACEMENT")
        throw new Error(
          "This is not an inventory placement task. No products were analyzed."
        );
      // Canonical mentions cannot be discarded by a partial helper interpretation.
      inventoryRefs = [
        ...new Map(
          [
            ...mentioned,
            ...(interpreted.inventoryRefs ?? []).filter((ref) =>
              ` ${normalizeInventoryName(input.instruction)} `.includes(
                ` ${normalizeInventoryName(ref.name)} `
              )
            ),
          ].map((ref) => [normalizeInventoryName(ref.name), ref])
        ).values(),
      ];
      locationRefs = interpreted.locationRefs ?? locationRefs;
      destinationScope = interpreted.candidateDestinationScope;
      plannerScopedQuery =
        interpreted.inventorySelectionMode === "SCOPED_QUERY";
      plannerUsed = true;
    }
  }
  const resolutions = inventoryRefs.map((ref) => {
    const resolution = resolveInventoryReference(ref, catalog);
    const choice = input.referenceChoices?.[ref.name];
    return choice &&
      resolution.candidates.some((candidate) => candidate.id === choice)
      ? { ...resolution, modelId: choice }
      : resolution;
  });
  const explicitMode = inventoryRefs.length > 0;
  if (explicitMode)
    selectedModelIds = [
      ...new Set(
        resolutions.flatMap((resolution) =>
          resolution.modelId ? [resolution.modelId] : []
        )
      ),
    ];
  taskPlan = createInventoryPlacementTaskPlan({
    instruction: input.instruction,
    hasStaffSelection: !explicitMode && staffSelectedCount > 0,
    inventoryRefs,
    placementPressure,
  });
  taskPlan = validateShelfTaskPlan({
    ...taskPlan,
    locationRefs,
    candidateDestinationScope: destinationScope,
  });
  const resolvedLocations = locationRefs.map((reference) => ({
    reference,
    ...resolveTaskLocation(reference, snapshot.locations),
  }));
  const grounding = {
    currentLocations: resolvedLocations,
    inventorySelectionMode: explicitMode
      ? "EXPLICIT_PRODUCTS"
      : staffSelectedCount
      ? "SELECTED_PRODUCTS"
      : "SCOPED_QUERY",
    explicitInventoryRefCount: inventoryRefs.length,
    resolvedInventoryRefCount: resolutions.filter((ref) => ref.modelId).length,
    unresolvedInventoryRefCount: resolutions.filter((ref) => !ref.modelId)
      .length,
    selectedInventoryIdCount: staffSelectedCount,
    references: resolutions,
  };
  const normalizedInstruction = input.instruction.toLocaleLowerCase();
  const inferredCategoryIds = snapshot.categories
    .filter((category) =>
      normalizedInstruction.includes(category.name.toLocaleLowerCase())
    )
    .map(({ id }) => id);
  const inferredLocationIds = snapshot.locations
    .filter(
      (location) =>
        normalizedInstruction.includes(location.name.toLocaleLowerCase()) ||
        normalizedInstruction.includes(location.path.toLocaleLowerCase())
    )
    .map(({ id }) => id);
  const categoryIds = input.categoryIds?.length
    ? input.categoryIds
    : inferredCategoryIds;
  const locationIds = input.locationIds?.length
    ? input.locationIds
    : inferredLocationIds;
  const selectedLocationIds = locationIds.length ? new Set(locationIds) : null;
  const scopeLocations = selectedLocationIds
    ? new Set(
        snapshot.locations
          .filter((location) => {
            let parentId = location.parentId;
            while (parentId) {
              if (selectedLocationIds.has(parentId)) return true;
              parentId =
                snapshot.locations.find(
                  (candidate) => candidate.id === parentId
                )?.parentId ?? null;
            }
            return selectedLocationIds.has(location.id);
          })
          .map((location) => location.id)
      )
    : null;
  const scopeCategories = categoryIds.length ? new Set(categoryIds) : null;
  const hasBroadScope =
    /\b(all inventory|everything|whole lab|across the organization|entire inventory|misplaced|wrong place|reorganize our inventory)\b/i.test(
      input.instruction
    );
  if (
    !explicitMode &&
    !selectedModelIds.length &&
    ((!scopeCategories && !scopeLocations) ||
      (!plannerScopedQuery &&
        !input.categoryIds?.length &&
        !input.locationIds?.length)) &&
    !hasBroadScope
  ) {
    const diagnostics = {
      selectedModelCount: 0,
      modelsConsidered: 0,
      modelsSentToClaude: 0,
      categoriesSent: 0,
      locationsSent: 0,
      candidateLocationCountBeforeRanking: snapshot.locations.filter(
        (location) => location.assignable
      ).length,
      candidateLocationCountAfterRanking: 0,
      locationsSentToClaude: 0,
      batches: 0,
      helperFailures: 0,
      requestBytes: 0,
      placementPressure,
      recommendedCount: 0,
      suggestedCount: 0,
      keepCount: 0,
      unresolvedCount: 0,
      reasonCounts: {},
      requiresSelection: true,
      validationRejectedCount: 0,
      analysisScope: "No selected products or explicit inventory scope",
      durationMs: Date.now() - startedAt,
    };
    Logger.info({
      event: "ioio_inventory_organization_analysis",
      taskType: taskPlan.taskType,
      plannerUsed: "DETERMINISTIC_TASK_PLAN",
      fastPathUsed: false,
      capabilitiesRequested: taskPlan.steps.map((step) => step.capability),
      referencesResolved: 0,
      referencesUnresolved: 0,
      sourcesUsed: taskPlan.sources.map((source) => source.type),
      proposalOperationCount: 0,
      ...diagnostics,
    });
    return { proposalItems: [], diagnostics, previewOnly: true };
  }
  const modelWhere =
    explicitMode || selectedModelIds.length
      ? {
          organizationId: input.organizationId,
          id: { in: selectedModelIds },
        }
      : {
          organizationId: input.organizationId,
          assets: {
            some: {
              organizationId: input.organizationId,
              ...(scopeCategories
                ? { categoryId: { in: [...scopeCategories] } }
                : {}),
              ...(scopeLocations
                ? {
                    assetLocations: {
                      some: {
                        locationId: { in: [...scopeLocations] },
                        assetKitId: null,
                      },
                    },
                  }
                : {}),
            },
          },
        };
  const models = await db.assetModel.findMany({
    where: modelWhere,
    orderBy: { name: "asc" },
    take: selectedModelIds.length || MAX_MODELS_PER_REORGANIZATION_RUN,
    select: {
      id: true,
      name: true,
      description: true,
      defaultCategoryId: true,
      assets: {
        where: { organizationId: input.organizationId },
        select: {
          quantity: true,
          categoryId: true,
          assetLocations: {
            where: { organizationId: input.organizationId, assetKitId: null },
            select: { locationId: true, quantity: true },
          },
        },
      },
    },
  });
  if (
    (explicitMode || staffSelectedCount) &&
    models.some((model) => !selectedModelIds.includes(model.id))
  )
    throw new Error("Inventory grounding rejected an unrequested product.");
  const loadedModelIds = new Set(models.map((model) => model.id));
  if (
    selectedModelIds.length > 0 &&
    (models.length !== selectedModelIds.length ||
      selectedModelIds.some((id) => !loadedModelIds.has(id)))
  )
    throw new Error(
      "One or more selected products are no longer available in this organization. Reload inventory and select them again."
    );
  const categories = snapshot.categories;
  const destination = destinationScope
    ? resolveTaskLocation(destinationScope, snapshot.locations)
    : null;
  const destinationIds = destination?.id
    ? new Set(
        locationDescendants(snapshot.locations, destination.id).map(
          ({ id }) => id
        )
      )
    : null;
  const locations = snapshot.locations.filter(
    (location) =>
      location.assignable &&
      (!destinationScope || Boolean(destinationIds?.has(location.id)))
  );
  const candidates = models
    .map((model) => {
      const assets = model.assets;
      const catCounts = new Map<string, number>();
      const locCounts = new Map<string, number>();
      let quantity = 0;
      for (const asset of assets) {
        quantity += asset.quantity ?? 1;
        if (asset.categoryId)
          catCounts.set(
            asset.categoryId,
            (catCounts.get(asset.categoryId) ?? 0) + (asset.quantity ?? 1)
          );
        for (const placement of asset.assetLocations)
          locCounts.set(
            placement.locationId,
            (locCounts.get(placement.locationId) ?? 0) +
              (placement.quantity ?? 1)
          );
      }
      const currentCategoryId =
        [...catCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ??
        model.defaultCategoryId ??
        null;
      const currentLocationId =
        [...locCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const expectedLocation = currentCategoryId
        ? snapshot.categories.find(
            (category) => category.id === currentCategoryId
          )?.commonLocations[0]?.locationId
        : null;
      const suspicious =
        currentLocationId === null ||
        (expectedLocation && currentLocationId !== expectedLocation);
      return {
        modelId: model.id,
        productName: model.name,
        manufacturer: null,
        shortDescription: model.description?.slice(0, 500) ?? null,
        currentCategoryId,
        currentLocationId,
        currentLocationIds: [...locCounts.keys()],
        quantity,
        rank: suspicious ? 0 : 1,
        categoryName:
          snapshot.categories.find(
            (category) => category.id === currentCategoryId
          )?.name ?? null,
      };
    })
    .sort(
      (a, b) => a.rank - b.rank || a.productName.localeCompare(b.productName)
    );
  const narrowedCandidates = (
    explicitMode ||
    selectedModelIds.length ||
    categoryIds.length ||
    locationIds.length
      ? candidates
      : candidates.some((candidate) => candidate.rank === 0)
      ? candidates.filter((candidate) => candidate.rank === 0)
      : candidates
  ).slice(0, 500);
  const currentCategoryIds = new Set(
    narrowedCandidates
      .map((candidate) => candidate.currentCategoryId)
      .filter((id): id is string => id !== null)
  );
  const relevantCategories = [...categories]
    .sort(
      (left, right) =>
        Number(currentCategoryIds.has(right.id)) -
          Number(currentCategoryIds.has(left.id)) ||
        right.modelCount - left.modelCount
    )
    .slice(0, MAX_REORGANIZATION_CATEGORIES);
  const selectedCurrentLocationCounts = new Map<string, number>();
  for (const candidate of narrowedCandidates)
    for (const locationId of candidate.currentLocationIds)
      selectedCurrentLocationCounts.set(
        locationId,
        (selectedCurrentLocationCounts.get(locationId) ?? 0) + 1
      );
  const rankedByModel = new Map<string, RankedPlacementLocation[]>();
  for (const candidate of narrowedCandidates)
    rankedByModel.set(
      candidate.modelId,
      rankPlacementLocations({
        locations,
        productName: candidate.productName,
        categoryName: candidate.categoryName,
        categoryId: candidate.currentCategoryId,
        currentLocationIds: candidate.currentLocationIds,
        selectedCurrentLocationCounts,
        placementPressure,
      })
    );
  const proposalItems: Array<{
    modelId: string;
    productName: string;
    currentCategoryId: string | null;
    currentLocationId: string | null;
    categoryId: string | null;
    locationId: string | null;
    categoryConfidence: number;
    locationConfidence: number;
    reason: string;
    strength: PlacementStrength;
    alternatives: Array<{ locationId: string; score: number }>;
    failureReason: PlacementFailureReason | null;
  }> = [];
  const batches = [];
  const suggestionsByModelId = new Map<
    string,
    {
      suggestedCategoryId: string | null;
      categoryConfidence: number;
      suggestedLocationId: string | null;
      locationConfidence: number;
      reason: string;
      helperFailed: boolean;
    }
  >();
  const rankedLocationIdsSent = new Set<string>();
  const sentCandidateIdsByModel = new Map<string, Set<string>>();
  let validationRejectedCount = 0;
  let unrequestedModelsRejected = 0;
  for (
    let offset = 0;
    offset < narrowedCandidates.length;
    offset += MAX_REORGANIZATION_MODELS_PER_BATCH
  ) {
    const batch = narrowedCandidates.slice(
      offset,
      offset + MAX_REORGANIZATION_MODELS_PER_BATCH
    );
    const perModelAlternatives = batch.map((item) =>
      (rankedByModel.get(item.modelId) ?? [])
        .filter((location) => !item.currentLocationIds.includes(location.id))
        .slice(0, MAX_CANDIDATES_PER_MODEL)
    );
    const rankedLocationsById = new Map<string, RankedPlacementLocation>();
    for (let rank = 0; rank < MAX_CANDIDATES_PER_MODEL; rank++) {
      for (const alternatives of perModelAlternatives) {
        const location = alternatives[rank];
        if (location && !rankedLocationsById.has(location.id))
          rankedLocationsById.set(location.id, location);
        if (
          rankedLocationsById.size >= MAX_UNIQUE_CANDIDATE_LOCATIONS_PER_BATCH
        )
          break;
      }
      if (rankedLocationsById.size >= MAX_UNIQUE_CANDIDATE_LOCATIONS_PER_BATCH)
        break;
    }
    const rankedLocations = [...rankedLocationsById.values()];
    rankedLocations.forEach((location) =>
      rankedLocationIdsSent.add(location.id)
    );
    batch.forEach((item, index) => {
      sentCandidateIdsByModel.set(
        item.modelId,
        new Set(
          (perModelAlternatives[index] ?? [])
            .filter((location) => rankedLocationsById.has(location.id))
            .map((location) => location.id)
        )
      );
    });
    const request = {
      mode: "INVENTORY_REORGANIZATION" as const,
      schemaVersion: 1 as const,
      instruction: input.instruction,
      scope: {
        categoryIds: selectedModelIds.length ? [] : categoryIds,
        locationIds: selectedModelIds.length ? [] : locationIds,
      },
      items: batch.map((item) => ({
        modelId: item.modelId,
        productName: item.productName,
        manufacturer: item.manufacturer,
        shortDescription: item.shortDescription,
        currentCategoryId: item.currentCategoryId,
        currentLocationId: item.currentLocationId,
        quantity: item.quantity,
      })),
      categories: relevantCategories.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
      locations: rankedLocations.map(
        ({
          id,
          name,
          path,
          description,
          hierarchyDepth,
          categoryDistribution,
          modelCount,
          assetCount,
          unitCount,
          representativeConcepts,
        }) => ({
          id,
          name,
          path,
          description,
          hierarchyDepth,
          categoryAffinitySummary: [
            ...categoryDistribution
              .slice(0, 3)
              .map((entry) => `${entry.name}: ${entry.count}`),
            `${modelCount} models`,
            `${assetCount} assets`,
            `${unitCount} units`,
            assetCount === 0 ? "empty" : "occupied",
            `concepts: ${representativeConcepts.slice(0, 6).join(", ")}`,
          ]
            .join("; ")
            .slice(0, 500),
        })
      ),
    };
    const result = await requestImportHelperProposal(
      request as AnyImportHelperRequest
    );
    batches.push({
      categoriesSent: relevantCategories.length,
      locationsSent: rankedLocations.length,
      requestBytes: new TextEncoder().encode(JSON.stringify(request))
        .byteLength,
      result,
    });
    if (result.status === "ready" && "proposals" in result.proposal)
      for (const suggestion of result.proposal.proposals) {
        const current = batch.find(
          (item) => item.modelId === suggestion.modelId
        );
        if (!current) {
          unrequestedModelsRejected++;
          continue;
        }
        if (suggestionsByModelId.has(suggestion.modelId)) continue;
        suggestionsByModelId.set(suggestion.modelId, {
          suggestedCategoryId: suggestion.suggestedCategoryId,
          categoryConfidence: suggestion.categoryConfidence,
          suggestedLocationId: suggestion.suggestedLocationId,
          locationConfidence: suggestion.locationConfidence,
          reason: suggestion.reason,
          helperFailed: false,
        });
      }
    if (result.status === "manual")
      for (const item of batch)
        if (!suggestionsByModelId.has(item.modelId))
          suggestionsByModelId.set(item.modelId, {
            suggestedCategoryId: null,
            categoryConfidence: 0,
            suggestedLocationId: null,
            locationConfidence: 0,
            reason:
              "The helper was unavailable; alternatives are ranked from current Shelf evidence.",
            helperFailed: true,
          });
  }
  const categoryChangeRequested =
    /\b(category|categorize|reclassify|classification)\b/i.test(
      input.instruction
    );
  const reasonCounts: Record<PlacementFailureReason, number> = {
    NO_VALID_CANDIDATES: 0,
    CURRENT_LOCATION_BEST: 0,
    AMBIGUOUS: 0,
    HELPER_FAILED: 0,
    VALIDATION_REJECTED: 0,
  };
  for (const item of narrowedCandidates) {
    const ranked = rankedByModel.get(item.modelId) ?? [];
    const alternatives = ranked.filter(
      (location) => !item.currentLocationIds.includes(location.id)
    );
    const helperSuggestion = suggestionsByModelId.get(item.modelId);
    const helperLocationId = helperSuggestion?.suggestedLocationId ?? null;
    const helperCandidateIsAllowed = Boolean(
      helperLocationId &&
        alternatives.some(({ id }) => id === helperLocationId) &&
        sentCandidateIdsByModel.get(item.modelId)?.has(helperLocationId)
    );
    if (helperLocationId && !helperCandidateIsAllowed)
      validationRejectedCount++;
    const validHelperLocationId = helperCandidateIsAllowed
      ? helperLocationId
      : null;
    const suggestedLocation = validHelperLocationId
      ? alternatives.find(({ id }) => id === validHelperLocationId)!
      : alternatives[0];
    const currentBestScore = ranked
      .filter((location) => item.currentLocationIds.includes(location.id))
      .reduce((best, location) => Math.max(best, location.score), -Infinity);
    const currentBestRawScore = ranked
      .filter((location) => item.currentLocationIds.includes(location.id))
      .reduce((best, location) => Math.max(best, location.rawScore), -Infinity);
    const bestAlternativeRawScore = alternatives[0]?.rawScore ?? -Infinity;
    const currentStillBest =
      alternatives.length > 0 &&
      currentPlacementIsBest({
        placementPressure,
        currentScore: currentBestScore,
        bestAlternativeScore: alternatives[0]!.score,
        currentRawScore: currentBestRawScore,
        bestAlternativeRawScore,
      });
    const noAlternative = alternatives.length === 0;
    let strength: PlacementStrength;
    let failureReason: PlacementFailureReason | null = null;
    let reason =
      helperSuggestion?.reason ||
      "Ranked from current category affinity, related products, and location use.";
    if (currentStillBest) {
      strength = "KEEP_CURRENT";
      failureReason = "CURRENT_LOCATION_BEST";
      reason =
        "Current location has the strongest Shelf evidence. Ranked alternatives remain available for review.";
    } else if (noAlternative) {
      strength = item.currentLocationId ? "KEEP_CURRENT" : "UNRESOLVED";
      failureReason = helperSuggestion?.helperFailed
        ? "HELPER_FAILED"
        : "NO_VALID_CANDIDATES";
      reason = item.currentLocationId
        ? "No other valid Shelf locations matched this product."
        : "No valid existing Shelf destination was found.";
    } else if (suggestedLocation) {
      if (!helperCandidateIsAllowed) {
        strength = "POSSIBLE";
        failureReason = helperSuggestion?.helperFailed
          ? "HELPER_FAILED"
          : helperLocationId
          ? "VALIDATION_REJECTED"
          : null;
        reason = helperSuggestion?.helperFailed
          ? "The helper was unavailable; this possible option is ranked from current Shelf evidence."
          : helperLocationId
          ? "The helper destination was outside this product's validated candidate list; showing the best ranked Shelf alternative."
          : "Best ranked Shelf alternative based on category affinity, related products, and location use.";
      } else if ((helperSuggestion?.locationConfidence ?? 0) >= 0.8) {
        strength = "RECOMMENDED";
      } else if ((helperSuggestion?.locationConfidence ?? 0) >= 0.55) {
        strength = "SUGGESTED";
      } else {
        strength = "POSSIBLE";
      }
    } else {
      strength = "UNRESOLVED";
      failureReason = helperSuggestion?.helperFailed
        ? "HELPER_FAILED"
        : "NO_VALID_CANDIDATES";
    }
    if (failureReason) reasonCounts[failureReason]++;
    const selectedAlternativeIds = alternatives.slice(0, 3).map(({ id }) => id);
    if (
      suggestedLocation &&
      !selectedAlternativeIds.includes(suggestedLocation.id)
    )
      selectedAlternativeIds.unshift(suggestedLocation.id);
    const alternativesForReview = selectedAlternativeIds
      .slice(0, 3)
      .map((id) => {
        const match = alternatives.find((entry) => entry.id === id)!;
        return { locationId: match.id, score: match.score };
      });
    const suggestedCategoryId =
      categoryChangeRequested &&
      helperSuggestion?.suggestedCategoryId &&
      relevantCategories.some(
        (category) => category.id === helperSuggestion.suggestedCategoryId
      ) &&
      helperSuggestion.suggestedCategoryId !== item.currentCategoryId &&
      helperSuggestion.categoryConfidence >= 0.55
        ? helperSuggestion.suggestedCategoryId
        : null;
    if (
      categoryChangeRequested &&
      helperSuggestion?.suggestedCategoryId &&
      !relevantCategories.some(
        (category) => category.id === helperSuggestion.suggestedCategoryId
      )
    )
      validationRejectedCount++;
    proposalItems.push({
      modelId: item.modelId,
      productName: item.productName,
      currentCategoryId: item.currentCategoryId,
      currentLocationId: item.currentLocationId,
      categoryId: suggestedCategoryId,
      locationId:
        strength === "KEEP_CURRENT" || strength === "UNRESOLVED"
          ? null
          : suggestedLocation?.id ?? null,
      categoryConfidence: suggestedCategoryId
        ? helperSuggestion?.categoryConfidence ?? 0
        : 0,
      locationConfidence: suggestedLocation
        ? helperCandidateIsAllowed
          ? helperSuggestion?.locationConfidence ?? 0
          : Math.min(0.49, (suggestedLocation.score + 10) / 100)
        : 0,
      reason: (() => {
        const reference = resolutions.find(
          (resolution) => resolution.modelId === item.modelId
        )?.reference;
        const hint = reference?.currentLocationRef
          ? resolveTaskLocation(
              reference.currentLocationRef,
              snapshot.locations
            )
          : null;
        return (
          reason +
          ((hint && (!hint.id || !item.currentLocationIds.includes(hint.id))) ||
          (reference?.contextualQuantity !== undefined &&
            reference.contextualQuantity !== item.quantity)
            ? " Current location/quantity differs from the instruction; canonical Shelf state is shown."
            : "")
        );
      })(),
      strength,
      alternatives: alternativesForReview,
      failureReason,
    });
  }
  const diagnostics = {
    inventorySelectionMode: grounding.inventorySelectionMode,
    explicitInventoryRefCount: grounding.explicitInventoryRefCount,
    resolvedInventoryRefCount: grounding.resolvedInventoryRefCount,
    unresolvedInventoryRefCount: grounding.unresolvedInventoryRefCount,
    selectedInventoryIdCount: staffSelectedCount,
    scopedQueryModelCount:
      explicitMode || staffSelectedCount ? 0 : models.length,
    finalAnalyzedModelCount: narrowedCandidates.length,
    unrequestedModelsRejected,
    candidateLocationCount: locations.length,
    selectedModelCount: staffSelectedCount,
    modelsConsidered: models.length,
    modelsSentToClaude: narrowedCandidates.length,
    categoriesSent: batches.reduce(
      (sum, batch) => sum + batch.categoriesSent,
      0
    ),
    locationsSent: batches.reduce((sum, batch) => sum + batch.locationsSent, 0),
    candidateLocationCountBeforeRanking: locations.length,
    candidateLocationCountAfterRanking: rankedLocationIdsSent.size,
    batches: batches.length,
    locationsSentToClaude: batches.reduce(
      (sum, batch) => sum + batch.locationsSent,
      0
    ),
    placementPressure,
    recommendedCount: proposalItems.filter(
      (item) => item.strength === "RECOMMENDED"
    ).length,
    suggestedCount: proposalItems.filter(
      (item) => item.strength === "SUGGESTED" || item.strength === "POSSIBLE"
    ).length,
    keepCount: proposalItems.filter((item) => item.strength === "KEEP_CURRENT")
      .length,
    unresolvedCount: proposalItems.filter(
      (item) => item.strength === "UNRESOLVED"
    ).length,
    reasonCounts,
    requiresSelection: false,
    helperFailures: batches.filter((batch) => batch.result.status === "manual")
      .length,
    validationRejectedCount,
    requestBytes: batches.reduce((sum, batch) => sum + batch.requestBytes, 0),
    analysisScope: explicitMode
      ? resolutions
          .filter((ref) => ref.modelId)
          .map(
            (ref) =>
              ref.candidates.find((candidate) => candidate.id === ref.modelId)
                ?.name ?? ref.reference.name
          )
          .join(" · ")
      : selectedModelIds.length > 0
      ? `Exactly ${selectedModelIds.length} selected product model(s)`
      : [
          ...snapshot.categories
            .filter((category) => categoryIds.includes(category.id))
            .map(({ name }) => `Category: ${name}`),
          ...snapshot.locations
            .filter((location) => locationIds.includes(location.id))
            .map(({ path }) => `Location: ${path}`),
        ].join(" · ") ||
        "Organization inventory, with likely misplaced groups prioritized",
    durationMs: Date.now() - startedAt,
  };
  Logger.info({
    event: "ioio_inventory_organization_analysis",
    taskType: taskPlan.taskType,
    plannerUsed: plannerUsed ? "SHELF_TASK_PLAN" : "DETERMINISTIC_TASK_PLAN",
    fastPathUsed: !plannerUsed,
    capabilitiesRequested: taskPlan.steps.map((step) => step.capability),
    selectedModelIdsCount: selectedModelIds.length,
    referencesResolved: explicitMode
      ? grounding.resolvedInventoryRefCount
      : selectedModelIds.length || narrowedCandidates.length,
    referenceStatuses: resolutions.map(({ status }) => status),
    referencesUnresolved:
      validationRejectedCount + grounding.unresolvedInventoryRefCount,
    sourcesUsed: taskPlan.sources.map((source) => source.type),
    proposalOperationCount:
      diagnostics.recommendedCount + diagnostics.suggestedCount,
    ...diagnostics,
    analysisScope: explicitMode
      ? "Explicit product references"
      : diagnostics.analysisScope,
  });
  return {
    grounding,
    taskPlan,
    proposalItems,
    diagnostics,
    previewOnly: true,
  };
}
