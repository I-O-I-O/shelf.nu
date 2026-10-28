import { db } from "~/database/db.server";
import { requestImportHelperProposal } from "~/modules/ioio-staff/import-helper-client.server";
import {
  MAX_REORGANIZATION_CATEGORIES,
  MAX_REORGANIZATION_LOCATIONS,
  MAX_REORGANIZATION_MODELS_PER_BATCH,
  type AnyImportHelperRequest,
} from "~/modules/ioio-staff/import-helper-contract.server";
import { Logger } from "~/utils/logger";

export type LocationSnapshot = {
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
            categoryId: true,
            assetLocations: {
              where: { organizationId, assetKitId: null },
              select: { locationId: true },
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
    if (asset.categoryId) {
      const map = categoryCountsByLocation.get(locationId) ?? new Map();
      map.set(asset.categoryId, (map.get(asset.categoryId) ?? 0) + 1);
      categoryCountsByLocation.set(locationId, map);
      const reverse = locationsByCategory.get(asset.categoryId) ?? new Map();
      reverse.set(locationId, (reverse.get(locationId) ?? 0) + 1);
      locationsByCategory.set(asset.categoryId, reverse);
    }
  }
  const catName = new Map(
    categories.map((category) => [category.id, category.name])
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
      childCount: locations.filter(
        (candidate) => candidate.parentId === location.id
      ).length,
      assignable: true,
      description: location.description,
      modelCount: modelIdsByLocation.get(location.id)?.size ?? 0,
      assetCount: assetsByLocation.get(location.id)?.size ?? 0,
      categoryDistribution: distribution,
      representativeConcepts: tokens(
        `${location.name} ${location.description ?? ""} ${distribution
          .map((entry) => entry.name)
          .join(" ")}`
      ),
    };
  });
  return {
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

export async function generateInventoryOrganizationProposal(input: {
  organizationId: string;
  instruction: string;
  categoryIds?: string[];
  locationIds?: string[];
}) {
  const startedAt = Date.now();
  const snapshot = await buildLocationIntelligenceSnapshot(
    input.organizationId
  );
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
  const models = await db.assetModel.findMany({
    where: {
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
    },
    orderBy: { name: "asc" },
    take: 500,
    select: {
      id: true,
      name: true,
      description: true,
      defaultCategoryId: true,
      assets: {
        where: { organizationId: input.organizationId },
        select: {
          categoryId: true,
          assetLocations: {
            where: { organizationId: input.organizationId, assetKitId: null },
            select: { locationId: true },
          },
        },
      },
    },
  });
  const categories = snapshot.categories.filter(
    (category) => !scopeCategories || scopeCategories.has(category.id)
  );
  const locations = snapshot.locations.filter(
    (location) =>
      location.assignable &&
      (!scopeLocations ||
        scopeLocations.has(location.id) ||
        (location.parentId && scopeLocations.has(location.parentId)))
  );
  const candidates = models
    .map((model) => {
      const assets = model.assets;
      const catCounts = new Map<string, number>();
      const locCounts = new Map<string, number>();
      for (const asset of assets) {
        if (asset.categoryId)
          catCounts.set(
            asset.categoryId,
            (catCounts.get(asset.categoryId) ?? 0) + 1
          );
        for (const placement of asset.assetLocations)
          locCounts.set(
            placement.locationId,
            (locCounts.get(placement.locationId) ?? 0) + 1
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
        quantity: assets.length,
        rank: suspicious ? 0 : 1,
      };
    })
    .sort(
      (a, b) => a.rank - b.rank || a.productName.localeCompare(b.productName)
    );
  const narrowedCandidates = (
    categoryIds.length || locationIds.length
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
  }> = [];
  const batches = [];
  for (
    let offset = 0;
    offset < narrowedCandidates.length;
    offset += MAX_REORGANIZATION_MODELS_PER_BATCH
  ) {
    const batch = narrowedCandidates.slice(
      offset,
      offset + MAX_REORGANIZATION_MODELS_PER_BATCH
    );
    const rankedLocations = locations
      .map((location) => ({
        ...location,
        score: batch.reduce(
          (score, item) =>
            score +
            (item.currentCategoryId &&
            location.categoryDistribution.some(
              (entry) => entry.categoryId === item.currentCategoryId
            )
              ? 4
              : 0) +
            (tokens(item.productName).some((token) =>
              location.representativeConcepts.includes(token)
            )
              ? 2
              : 0),
          0
        ),
      }))
      .sort((a, b) => b.score - a.score || b.hierarchyDepth - a.hierarchyDepth)
      .slice(0, MAX_REORGANIZATION_LOCATIONS);
    const request = {
      mode: "INVENTORY_REORGANIZATION" as const,
      schemaVersion: 1 as const,
      instruction: input.instruction,
      scope: { categoryIds, locationIds },
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
        }) => ({
          id,
          name,
          path,
          description,
          hierarchyDepth,
          categoryAffinitySummary: categoryDistribution
            .slice(0, 3)
            .map((entry) => `${entry.name}: ${entry.count}`)
            .join(", "),
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
        if (!current) continue;
        const categoryId =
          suggestion.categoryConfidence < 0.55 ||
          suggestion.suggestedCategoryId === current.currentCategoryId
            ? null
            : suggestion.suggestedCategoryId;
        const locationId =
          suggestion.locationConfidence < 0.55 ||
          suggestion.suggestedLocationId === current.currentLocationId
            ? null
            : suggestion.suggestedLocationId;
        if (categoryId || locationId)
          proposalItems.push({
            modelId: current.modelId,
            productName: current.productName,
            currentCategoryId: current.currentCategoryId,
            currentLocationId: current.currentLocationId,
            categoryId,
            locationId,
            categoryConfidence: suggestion.categoryConfidence,
            locationConfidence: suggestion.locationConfidence,
            reason: suggestion.reason,
          });
      }
  }
  const diagnostics = {
    modelsConsidered: models.length,
    modelsSentToClaude: narrowedCandidates.length,
    categoriesSent: batches.reduce(
      (sum, batch) => sum + batch.categoriesSent,
      0
    ),
    locationsSent: batches.reduce((sum, batch) => sum + batch.locationsSent, 0),
    batches: batches.length,
    helperFailures: batches.filter((batch) => batch.result.status === "manual")
      .length,
    requestBytes: batches.reduce((sum, batch) => sum + batch.requestBytes, 0),
    analysisScope:
      [
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
    ...diagnostics,
  });
  return { proposalItems, diagnostics, previewOnly: true };
}
