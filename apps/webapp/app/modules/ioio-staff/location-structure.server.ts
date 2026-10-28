import { z } from "zod";
import { db } from "~/database/db.server";
import { requestImportHelperProposal } from "~/modules/ioio-staff/import-helper-client.server";
import {
  LOCATION_STRUCTURE_SCHEMA_VERSION,
  type AnyImportHelperRequest,
} from "~/modules/ioio-staff/import-helper-contract.server";
import { createLocation } from "~/modules/location/service.server";

export type OrganizationLocation = {
  id: string;
  name: string;
  parentId: string | null;
  description: string | null;
};

export async function getOrganizationLocationChoices(organizationId: string) {
  const [locations, categories] = await Promise.all([
    db.location.findMany({
      where: { organizationId },
      select: { id: true, name: true, parentId: true, description: true },
    }),
    db.category.findMany({
      where: { organizationId },
      select: { id: true, name: true, description: true },
    }),
  ]);
  const { path } = makePaths(locations);
  return {
    locations: locations.map((location) => ({
      ...location,
      path: path(location.id),
    })),
    categories,
  };
}

export type StructureNode = {
  temporaryId: string;
  parentLocationId: string | null;
  parentTemporaryId: string | null;
  name: string;
  description: string | null;
  status: "CREATE" | "EXISTS" | "POSSIBLE_DUPLICATE";
  existingLocationId: string | null;
  possibleExistingMatches?: Array<{ id: string; name: string; path: string }>;
  possibleMatchKind?: "TYPO" | "AMBIGUOUS_EXACT";
  canCreateDespitePossibleMatch?: boolean;
};

export type LocationStructureProposal = {
  mode: "LOCATION_STRUCTURE";
  instruction: string;
  parentName: string | null;
  parentLocationId: string | null;
  parentCandidates: Array<{ id: string; name: string; path: string }>;
  unresolvedParent: boolean;
  parentResolution:
    | "MATCHED"
    | "AMBIGUOUS_MATCH"
    | "CREATE_PARENT"
    | "AMBIGUOUS_ROOT"
    | "UNRESOLVED";
  createMissingParent: boolean;
  nodes: StructureNode[];
  source: "DETERMINISTIC" | "AI";
};

export function classifyOrganizationRequest(
  instruction: string
): "LOCATION_STRUCTURE" | "INVENTORY_REORGANIZATION" {
  const text = instruction.toLowerCase();
  const movement =
    /\b(move|relocate|reorganize|better places?|wrong location|currently in|stored in the wrong)\b/.test(
      text
    );
  const structureVerb = /\b(create|add|make|build)\b/.test(text);
  const structureNoun =
    /\b(room|section|shelves?|drawers?|containers?|cabinets?|storage area)\b/.test(
      text
    );
  return structureVerb && structureNoun && !movement
    ? "LOCATION_STRUCTURE"
    : "INVENTORY_REORGANIZATION";
}

function parseCount(value: string): number | null {
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
  const count = Number(value) || words[value.toLowerCase()];
  return count && count > 0 && count <= 100 ? count : null;
}

type ParsedStructure = {
  parentName: string | null;
  descriptors: Array<{
    temporaryId: string;
    name: string;
    parentTemporaryId: string | null;
    description: string | null;
  }>;
};

export function parseDeterministicLocationStructure(
  instruction: string
): ParsedStructure | null {
  const text = instruction.trim();
  const sectionMatch = text.match(
    /\b(?:create|add|make|build)\s+sections?\s+([A-Z0-9]+)\s+(?:and|&)\s+(?:sections?\s+)?([A-Z0-9]+)\s+in\s+(?:the\s+)?(.+?)\s+with\s+(\d+|[a-z]+)\s+shel(?:f|ves)\s+each\b/i
  );
  if (sectionMatch) {
    const [, first, second, parentName, countText] = sectionMatch;
    const count = parseCount(countText!);
    if (!count) return null;
    const descriptors = [first!, second!].flatMap((label) => {
      const sectionId = `section-${label.toLowerCase()}`;
      return [
        {
          temporaryId: sectionId,
          name: `Section ${label}`,
          parentTemporaryId: null,
          description: `Storage section ${label}.`,
        },
        ...Array.from({ length: count }, (_, index) => ({
          temporaryId: `shelf-${label.toLowerCase()}${index + 1}`,
          name: `Shelf ${label}${index + 1}`,
          parentTemporaryId: sectionId,
          description: `Storage shelf in Section ${label}.`,
        })),
      ];
    });
    return {
      parentName: parentName!.trim().replace(/[.!?]+$/, ""),
      descriptors,
    };
  }

  const containerMatch = text.match(
    /\b(?:create|add|make|build)\s+(\d+|[a-z]+)\s+containers?\s+(?:to|under|in)\s+(.+?)\s*$/i
  );
  if (containerMatch) {
    const count = parseCount(containerMatch[1]!);
    if (!count) return null;
    const parentName = containerMatch[2]!.trim().replace(/[.!?]+$/, "");
    const prefix = parentName.match(
      /\b([A-Z]+\d+(?:[-.][A-Z0-9]+)*)\s*$/i
    )?.[1];
    return {
      parentName,
      descriptors: Array.from({ length: count }, (_, index) => ({
        temporaryId: `container-${index + 1}`,
        name: `Container ${prefix ? `${prefix}-` : ""}${index + 1}`,
        parentTemporaryId: null,
        description: `Container ${index + 1} in ${parentName}.`,
      })),
    };
  }

  const rangeMatch = text.match(
    /\b(?:create|add|make|build)\s+shelves?\s+([A-Z]+\d+)\s+through\s+([A-Z]+\d+)\s+under\s+(.+?)\s*$/i
  );
  if (rangeMatch) {
    const [, start, end, parentName] = rangeMatch;
    const startMatch = start!.match(/^([A-Z]+)(\d+)$/i)!;
    const endMatch = end!.match(/^([A-Z]+)(\d+)$/i)!;
    if (startMatch[1]!.toLowerCase() !== endMatch[1]!.toLowerCase())
      return null;
    const first = Number(startMatch[2]);
    const last = Number(endMatch[2]);
    if (last < first || last - first > 99) return null;
    return {
      parentName: parentName!.trim().replace(/[.!?]+$/, ""),
      descriptors: Array.from({ length: last - first + 1 }, (_, index) => ({
        temporaryId: `shelf-${index + first}`,
        name: `Shelf ${startMatch[1]}${index + first}`,
        parentTemporaryId: null,
        description: null,
      })),
    };
  }

  const genericMatch = text.match(
    /\b(?:create|add|make|build)\s+(?:a\s+)?(.+?)\s+section\s+with\s+(\d+|[a-z]+)\s+shelves?(?:\s+(?:in|under)\s+(?:the\s+)?(.+?))?[.!]?$/i
  );
  if (genericMatch) {
    const [, label, countText, parentName] = genericMatch;
    const count = parseCount(countText!);
    if (!count) return null;
    const sectionId = `section-${label!
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")}`;
    return {
      parentName: parentName?.trim() ?? null,
      descriptors: [
        {
          temporaryId: sectionId,
          name: `${label!.trim()} section`,
          parentTemporaryId: null,
          description: `${label!.trim()} storage section.`,
        },
        ...Array.from({ length: count }, (_, index) => ({
          temporaryId: `shelf-${index + 1}`,
          name: `Shelf ${index + 1}`,
          parentTemporaryId: sectionId,
          description: `Storage shelf in ${label!.trim()} section.`,
        })),
      ],
    };
  }
  return null;
}

function comparableName(name: string) {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeName(name: string) {
  return comparableName(name).replace(/\bseciton\b/g, "section");
}

function tokensNear(left: string, right: string) {
  if (left === right) return true;
  if (
    left.length < 5 ||
    right.length < 5 ||
    Math.abs(left.length - right.length) > 1
  )
    return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex++;
      rightIndex++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (left.length > right.length) leftIndex++;
    else if (right.length > left.length) rightIndex++;
    else {
      if (
        left[leftIndex] === right[rightIndex + 1] &&
        left[leftIndex + 1] === right[rightIndex]
      ) {
        leftIndex += 2;
        rightIndex += 2;
      } else {
        leftIndex++;
        rightIndex++;
      }
    }
  }
  if (leftIndex < left.length || rightIndex < right.length) edits++;
  return edits <= 1;
}

function semanticAliases(query: string) {
  const normalized = normalizeName(query);
  const groups = [
    ["storage", "storeroom", "storage room", "storage area"],
    ["electronics", "electronics room", "electronics lab"],
    ["workshop", "work shop", "fabrication", "maker space", "makerspace"],
    ["lab", "laboratory", "laboratories"],
    ["main room", "main lab", "central room", "primary room"],
  ];
  return (
    groups.find((group) =>
      group.some((alias) => normalized.includes(normalizeName(alias)))
    ) ?? [query]
  );
}

function makePaths(locations: OrganizationLocation[]) {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const cache = new Map<string, string>();
  const path = (id: string): string => {
    if (cache.has(id)) return cache.get(id)!;
    const location = byId.get(id);
    if (!location) return "";
    const result = location.parentId
      ? `${path(location.parentId)} / ${location.name}`
      : location.name;
    cache.set(id, result);
    return result;
  };
  return { byId, path };
}

function resolveParent(
  locations: OrganizationLocation[],
  parentName: string | null,
  selectedParentId?: string
) {
  const { path } = makePaths(locations);
  const candidates = (matches: OrganizationLocation[]) =>
    matches.map((location) => ({
      id: location.id,
      name: location.name,
      path: path(location.id),
    }));
  if (!parentName)
    return {
      id: null,
      candidates: [],
      unresolved: false,
      resolution: "MATCHED" as const,
    };

  const pathLike =
    /[/>›]/.test(parentName) ||
    /\b(?:room|section|shelf|drawer|container|cabinet)\b.*\b(?:section|shelf|drawer|container|cabinet)\b/i.test(
      parentName
    );
  const exactPaths = () =>
    locations.filter(
      (location) =>
        normalizeName(path(location.id)) === normalizeName(parentName)
    );
  const selectMatch = (
    matches: OrganizationLocation[],
    allowPathNarrowing: boolean
  ) => {
    if (!matches.length) return null;
    let candidatesForTier = matches;
    if (allowPathNarrowing && pathLike) {
      const matchIds = new Set(matches.map(({ id }) => id));
      const pathMatches = exactPaths().filter(({ id }) => matchIds.has(id));
      if (pathMatches.length) candidatesForTier = pathMatches;
    }
    if (
      selectedParentId &&
      candidatesForTier.some(({ id }) => id === selectedParentId)
    )
      return {
        id: selectedParentId,
        candidates: candidates(candidatesForTier),
        unresolved: false,
        resolution: "MATCHED" as const,
      };
    return {
      id: candidatesForTier.length === 1 ? candidatesForTier[0]!.id : null,
      candidates: candidates(candidatesForTier),
      unresolved: candidatesForTier.length !== 1,
      resolution:
        candidatesForTier.length === 1
          ? ("MATCHED" as const)
          : ("AMBIGUOUS_MATCH" as const),
    };
  };
  const ownNameTiers = [
    locations.filter((location) => location.name.trim() === parentName.trim()),
    locations.filter(
      (location) =>
        location.name.trim().toLocaleLowerCase() ===
        parentName.trim().toLocaleLowerCase()
    ),
    locations.filter(
      (location) => normalizeName(location.name) === normalizeName(parentName)
    ),
  ];
  for (const matches of ownNameTiers) {
    const selected = selectMatch(matches, true);
    if (selected) return selected;
  }

  // Ancestor path text is not evidence that a descendant's own name matches.
  // Only compare full paths when the request itself carries hierarchy context.
  if (pathLike) {
    const pathMatch = selectMatch(exactPaths(), false);
    if (pathMatch) return pathMatch;
  }

  const genericTokens = new Set([
    "a",
    "an",
    "the",
    "room",
    "area",
    "location",
    "place",
    "storage",
  ]);
  const queryTokens = normalizeName(parentName)
    .split(" ")
    .filter((token) => !genericTokens.has(token));
  const tokenMatches = queryTokens.length
    ? locations.filter((location) => {
        const nameTokens = normalizeName(location.name).split(" ");
        return queryTokens.every((queryToken) =>
          nameTokens.some((nameToken) => tokensNear(queryToken, nameToken))
        );
      })
    : [];
  const tokenMatch = selectMatch(tokenMatches, false);
  if (tokenMatch) return tokenMatch;

  const semanticTerms = semanticAliases(parentName);
  const semanticMatches = locations.filter((location) => {
    const searchable = normalizeName(location.name);
    return semanticTerms.some((term) =>
      searchable.includes(normalizeName(term))
    );
  });
  const semanticMatch = selectMatch(semanticMatches, false);
  if (semanticMatch) return semanticMatch;

  const descriptionMatches = locations.filter((location) => {
    const searchable = normalizeName(location.description ?? "");
    return semanticTerms.some((term) =>
      searchable.includes(normalizeName(term))
    );
  });
  const descriptionMatch = selectMatch(descriptionMatches, false);
  if (descriptionMatch) return descriptionMatch;

  return {
    id: null,
    candidates: [],
    unresolved: true,
    resolution: "UNRESOLVED" as const,
  };
}

function resolveDuplicates(
  locations: OrganizationLocation[],
  descriptors: ParsedStructure["descriptors"],
  rootParentId: string | null,
  path: (id: string) => string
) {
  const existingByTemp = new Map<string, string>();
  const nodes: StructureNode[] = [];
  for (const descriptor of descriptors) {
    const parentLocationId = descriptor.parentTemporaryId
      ? existingByTemp.get(descriptor.parentTemporaryId) ?? null
      : rootParentId;
    const exactMatches = locations.filter(
      (location) =>
        location.parentId === parentLocationId &&
        comparableName(location.name) === comparableName(descriptor.name)
    );
    const typoMatches = exactMatches.length
      ? []
      : locations.filter(
          (location) =>
            location.parentId === parentLocationId &&
            normalizeName(location.name) === normalizeName(descriptor.name)
        );
    const match = exactMatches.length === 1 ? exactMatches[0] : null;
    if (match) existingByTemp.set(descriptor.temporaryId, match.id);
    else
      existingByTemp.set(
        descriptor.temporaryId,
        `temporary:${descriptor.temporaryId}`
      );
    const possibleMatches =
      exactMatches.length > 1 ? exactMatches : typoMatches;
    nodes.push({
      ...descriptor,
      parentLocationId: descriptor.parentTemporaryId ? null : rootParentId,
      status: match
        ? "EXISTS"
        : possibleMatches.length
        ? "POSSIBLE_DUPLICATE"
        : "CREATE",
      existingLocationId: match?.id ?? null,
      ...(possibleMatches.length
        ? {
            possibleMatchKind:
              exactMatches.length > 1
                ? ("AMBIGUOUS_EXACT" as const)
                : ("TYPO" as const),
            canCreateDespitePossibleMatch: exactMatches.length === 0,
          }
        : {}),
      ...(possibleMatches.length
        ? {
            possibleExistingMatches: possibleMatches.map((possible) => ({
              id: possible.id,
              name: possible.name,
              path: path(possible.id),
            })),
          }
        : {}),
    });
  }
  return nodes;
}

export async function buildLocationStructureProposal(input: {
  organizationId: string;
  instruction: string;
  selectedParentId?: string;
}) {
  const locations = await db.location.findMany({
    where: { organizationId: input.organizationId },
    select: { id: true, name: true, parentId: true, description: true },
  });
  const parsed = parseDeterministicLocationStructure(input.instruction);
  if (parsed) {
    const { path } = makePaths(locations);
    const parent = resolveParent(
      locations,
      parsed.parentName,
      input.selectedParentId
    );
    if (!parent.unresolved) {
      return {
        mode: "LOCATION_STRUCTURE" as const,
        instruction: input.instruction,
        parentName: parsed.parentName,
        parentLocationId: parent.id,
        parentCandidates: parent.candidates,
        unresolvedParent: false,
        parentResolution: "MATCHED" as const,
        createMissingParent: false,
        nodes: resolveDuplicates(
          locations,
          parsed.descriptors,
          parent.id,
          path
        ),
        source: "DETERMINISTIC" as const,
      };
    }

    if (parent.resolution === "AMBIGUOUS_MATCH") {
      return {
        mode: "LOCATION_STRUCTURE" as const,
        instruction: input.instruction,
        parentName: parsed.parentName,
        parentLocationId: null,
        parentCandidates: parent.candidates,
        unresolvedParent: true,
        parentResolution: "AMBIGUOUS_MATCH" as const,
        createMissingParent: false,
        nodes: [],
        source: "DETERMINISTIC" as const,
      };
    }

    const roots = locations.filter((location) => location.parentId === null);
    const selectedRoot = input.selectedParentId
      ? roots.find((root) => root.id === input.selectedParentId) ??
        (roots.length === 0
          ? locations.find((location) => location.id === input.selectedParentId)
          : undefined)
      : undefined;
    const createUnder = selectedRoot ?? (roots.length === 1 ? roots[0] : null);
    if (createUnder && parsed.parentName) {
      const missingParentId = `requested-parent-${normalizeName(
        parsed.parentName
      ).replace(/\s+/g, "-")}`;
      const descriptors: ParsedStructure["descriptors"] = [
        {
          temporaryId: missingParentId,
          name: parsed.parentName,
          parentTemporaryId: null,
          description: `New location created as the requested parent for ${parsed.parentName}.`,
        },
        ...parsed.descriptors.map((descriptor) => ({
          ...descriptor,
          parentTemporaryId: descriptor.parentTemporaryId ?? missingParentId,
        })),
      ];
      return {
        mode: "LOCATION_STRUCTURE" as const,
        instruction: input.instruction,
        parentName: parsed.parentName,
        parentLocationId: createUnder.id,
        parentCandidates: [
          {
            id: createUnder.id,
            name: createUnder.name,
            path: path(createUnder.id),
          },
        ],
        unresolvedParent: false,
        parentResolution: "CREATE_PARENT" as const,
        createMissingParent: true,
        nodes: resolveDuplicates(locations, descriptors, createUnder.id, path),
        source: "DETERMINISTIC" as const,
      };
    }

    const choices = roots.length ? roots : locations;
    return {
      mode: "LOCATION_STRUCTURE" as const,
      instruction: input.instruction,
      parentName: parsed.parentName,
      parentLocationId: null,
      parentCandidates: choices.map((location) => ({
        id: location.id,
        name: location.name,
        path: path(location.id),
      })),
      unresolvedParent: true,
      parentResolution: "AMBIGUOUS_ROOT" as const,
      createMissingParent: true,
      nodes: [],
      source: "DETERMINISTIC" as const,
    };
  }

  const { path } = makePaths(locations);
  const words = new Set(
    input.instruction.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
  );
  const relevant = locations
    .map((location) => ({
      location,
      score: [...words].filter((word) =>
        `${location.name} ${location.description ?? ""} ${path(location.id)}`
          .toLowerCase()
          .includes(word)
      ).length,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 100)
    .map(({ location }) => location);
  const request = {
    mode: "LOCATION_STRUCTURE" as const,
    schemaVersion: LOCATION_STRUCTURE_SCHEMA_VERSION,
    instruction: input.instruction,
    existingLocations: relevant.map((location) => ({
      ...location,
      path: path(location.id),
    })),
  };
  const result = await requestImportHelperProposal(
    request as AnyImportHelperRequest
  );
  if (result.status !== "ready" || !("operations" in result.proposal))
    return {
      mode: "LOCATION_STRUCTURE" as const,
      instruction: input.instruction,
      parentName: null,
      parentLocationId: null,
      parentCandidates: [],
      unresolvedParent: true,
      parentResolution: "UNRESOLVED" as const,
      createMissingParent: false,
      nodes: [],
      source: "AI" as const,
      helperUnavailable: true,
    };
  const proposals = result.proposal.operations.map((operation) => ({
    temporaryId: operation.temporaryId,
    name: operation.name,
    parentTemporaryId: operation.parentTemporaryId,
    description: operation.description,
  }));
  const rootIds = [
    ...new Set(
      result.proposal.operations
        .map((op) => op.parentLocationId)
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const unresolvedRoot = result.proposal.operations.some(
    (op) => !op.parentTemporaryId && !op.parentLocationId
  );
  const rootId = rootIds.length === 1 ? rootIds[0]! : null;
  const parent = input.selectedParentId
    ? (() => {
        const selected = locations.find(
          ({ id }) => id === input.selectedParentId
        );
        return selected && rootIds.includes(selected.id)
          ? {
              id: selected.id,
              candidates: [
                {
                  id: selected.id,
                  name: selected.name,
                  path: path(selected.id),
                },
              ],
              unresolved: false,
            }
          : { id: null, candidates: [], unresolved: true };
      })()
    : rootIds.length > 1
    ? {
        id: null,
        candidates: rootIds.flatMap((id) => {
          const location = locations.find((entry) => entry.id === id);
          return location ? [{ id, name: location.name, path: path(id) }] : [];
        }),
        unresolved: true,
      }
    : rootId
    ? resolveParent(locations, null, rootId)
    : { id: null, candidates: [], unresolved: unresolvedRoot };
  const nodes = resolveDuplicates(locations, proposals, parent.id, path);
  return {
    mode: "LOCATION_STRUCTURE" as const,
    instruction: input.instruction,
    parentName: null,
    parentLocationId: parent.id,
    parentCandidates: parent.candidates,
    unresolvedParent: parent.unresolved,
    parentResolution: parent.unresolved
      ? ("AMBIGUOUS_ROOT" as const)
      : ("MATCHED" as const),
    createMissingParent: false,
    nodes,
    source: "AI" as const,
  };
}

const structurePayloadSchema = z
  .object({
    mode: z.literal("LOCATION_STRUCTURE"),
    instruction: z.string().min(1).max(2_000),
    parentLocationId: z.string().nullable(),
    nodes: z
      .array(
        z
          .object({
            temporaryId: z.string().min(1).max(200),
            parentLocationId: z.string().nullable(),
            parentTemporaryId: z.string().nullable(),
            name: z.string().trim().min(1).max(300),
            description: z.string().max(500).nullable(),
            status: z.enum(["CREATE", "EXISTS", "REVIEW"]),
            existingLocationId: z.string().nullable(),
            confirmedPossibleDuplicate: z.boolean().default(false),
          })
          .strict()
      )
      .max(100),
  })
  .strict()
  .superRefine((proposal, context) => {
    const seen = new Set<string>();
    const siblings = new Set<string>();
    for (const [index, node] of proposal.nodes.entries()) {
      if (node.status === "REVIEW")
        context.addIssue({
          code: "custom",
          message:
            "Resolve possible existing location matches before creating.",
          path: ["nodes", index, "status"],
        });
      if (seen.has(node.temporaryId))
        context.addIssue({
          code: "custom",
          message: "Duplicate proposal node ID",
          path: ["nodes", index, "temporaryId"],
        });
      if (node.parentTemporaryId && !seen.has(node.parentTemporaryId))
        context.addIssue({
          code: "custom",
          message: "Parent proposal node must appear first",
          path: ["nodes", index, "parentTemporaryId"],
        });
      const parent =
        node.parentTemporaryId ??
        node.parentLocationId ??
        proposal.parentLocationId ??
        "root";
      const key = `${parent}\0${normalizeName(node.name)}`;
      if (siblings.has(key))
        context.addIssue({
          code: "custom",
          message: "Duplicate sibling location name",
          path: ["nodes", index, "name"],
        });
      siblings.add(key);
      seen.add(node.temporaryId);
    }
  });

export async function createLocationStructure(input: {
  organizationId: string;
  userId: string;
  proposalInput: unknown;
}) {
  const proposal = structurePayloadSchema.parse(input.proposalInput);
  const locations = await db.location.findMany({
    where: { organizationId: input.organizationId },
    select: { id: true, name: true, parentId: true, description: true },
  });
  if (
    proposal.parentLocationId &&
    !locations.some(({ id }) => id === proposal.parentLocationId)
  )
    throw new Error(
      "The selected parent location is no longer available in this organization."
    );
  const resolved = new Map<string, string>();
  const results: Array<{
    name: string;
    path: string;
    status: "CREATED" | "EXISTS" | "FAILED";
    error?: string;
  }> = [];
  const pathState = makePaths(locations);
  const { path } = pathState;
  for (const node of proposal.nodes) {
    const parentId = node.parentTemporaryId
      ? resolved.get(node.parentTemporaryId)
      : node.parentLocationId ?? proposal.parentLocationId;
    if (node.parentTemporaryId && !parentId) {
      results.push({
        name: node.name,
        path: node.name,
        status: "FAILED",
        error: "Proposed parent was not created.",
      });
      continue;
    }
    if (
      parentId &&
      !locations.some(({ id }) => id === parentId) &&
      ![...resolved.values()].includes(parentId)
    ) {
      results.push({
        name: node.name,
        path: node.name,
        status: "FAILED",
        error: "Parent is not part of this organization.",
      });
      continue;
    }
    const duplicate = locations.find(
      (location) =>
        location.parentId === (parentId ?? null) &&
        comparableName(location.name) === comparableName(node.name)
    );
    if (duplicate) {
      resolved.set(node.temporaryId, duplicate.id);
      results.push({
        name: node.name,
        path: `${parentId ? path(parentId) : ""}${parentId ? " / " : ""}${
          node.name
        }`,
        status: "EXISTS",
      });
      continue;
    }
    const typoMatches = locations.filter(
      (location) =>
        location.parentId === (parentId ?? null) &&
        normalizeName(location.name) === normalizeName(node.name) &&
        comparableName(location.name) !== comparableName(node.name)
    );
    if (typoMatches.length && !node.confirmedPossibleDuplicate) {
      results.push({
        name: node.name,
        path: `${parentId ? path(parentId) : ""}${parentId ? " / " : ""}${
          node.name
        }`,
        status: "FAILED",
        error: `Possible existing match: ${typoMatches
          .map(({ name }) => name)
          .join(", ")}. Review this match before creating.`,
      });
      continue;
    }
    if (node.status === "EXISTS" && node.existingLocationId) {
      const existing = locations.find(
        (location) =>
          location.id === node.existingLocationId &&
          location.parentId === (parentId ?? null)
      );
      if (existing) {
        resolved.set(node.temporaryId, existing.id);
        results.push({
          name: node.name,
          path: `${parentId ? path(parentId) : ""}${parentId ? " / " : ""}${
            node.name
          }`,
          status: "EXISTS",
        });
        continue;
      }
      results.push({
        name: node.name,
        path: node.name,
        status: "FAILED",
        error:
          "The selected existing location is no longer available under this parent.",
      });
      continue;
    }
    try {
      const created = await createLocation({
        name: node.name,
        description: node.description ?? "",
        address: "",
        userId: input.userId,
        organizationId: input.organizationId,
        parentId,
      });
      const newLocation = {
        id: created.id,
        name: created.name,
        parentId: created.parentId,
        description: created.description,
      };
      locations.push(newLocation);
      pathState.byId.set(created.id, newLocation);
      resolved.set(node.temporaryId, created.id);
      results.push({
        name: node.name,
        path: `${parentId ? path(parentId) : ""}${parentId ? " / " : ""}${
          node.name
        }`,
        status: "CREATED",
      });
    } catch (cause) {
      results.push({
        name: node.name,
        path: node.name,
        status: "FAILED",
        error:
          cause instanceof Error ? cause.message : "Location creation failed.",
      });
    }
  }
  return {
    results,
    createdCount: results.filter(({ status }) => status === "CREATED").length,
    existingCount: results.filter(({ status }) => status === "EXISTS").length,
    failedCount: results.filter(({ status }) => status === "FAILED").length,
  };
}
