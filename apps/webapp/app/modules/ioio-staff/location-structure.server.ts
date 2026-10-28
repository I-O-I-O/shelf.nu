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
  status: "CREATE" | "EXISTS";
  existingLocationId: string | null;
};

export type LocationStructureProposal = {
  mode: "LOCATION_STRUCTURE";
  instruction: string;
  parentName: string | null;
  parentLocationId: string | null;
  parentCandidates: Array<{ id: string; name: string; path: string }>;
  unresolvedParent: boolean;
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
    /\b(?:create|add|make|build)\s+sections?\s+([A-Z0-9]+)\s+(?:and|&)\s+(?:sections?\s+)?([A-Z0-9]+)\s+in\s+(?:the\s+)?(.+?)\s+with\s+(\d+|[a-z]+)\s+shelves?\s+each\b/i
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

function normalizeName(name: string) {
  return name.trim().toLocaleLowerCase();
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
  if (selectedParentId) {
    const selected = locations.find(({ id }) => id === selectedParentId);
    return {
      id: selected?.id ?? null,
      candidates: selected
        ? [{ id: selected.id, name: selected.name, path: path(selected.id) }]
        : [],
      unresolved: !selected,
    };
  }
  if (!parentName) return { id: null, candidates: [], unresolved: false };
  const matches = locations.filter(
    (location) =>
      normalizeName(location.name) === normalizeName(parentName) ||
      normalizeName(path(location.id)) === normalizeName(parentName)
  );
  return {
    id: matches.length === 1 ? matches[0]!.id : null,
    candidates: matches.map((location) => ({
      id: location.id,
      name: location.name,
      path: path(location.id),
    })),
    unresolved: matches.length !== 1,
  };
}

function resolveDuplicates(
  locations: OrganizationLocation[],
  descriptors: ParsedStructure["descriptors"],
  rootParentId: string | null
) {
  const existingByTemp = new Map<string, string>();
  const nodes: StructureNode[] = [];
  for (const descriptor of descriptors) {
    const parentLocationId = descriptor.parentTemporaryId
      ? existingByTemp.get(descriptor.parentTemporaryId) ?? null
      : rootParentId;
    const match = locations.find(
      (location) =>
        location.parentId === parentLocationId &&
        normalizeName(location.name) === normalizeName(descriptor.name)
    );
    if (match) existingByTemp.set(descriptor.temporaryId, match.id);
    else
      existingByTemp.set(
        descriptor.temporaryId,
        `temporary:${descriptor.temporaryId}`
      );
    nodes.push({
      ...descriptor,
      parentLocationId: descriptor.parentTemporaryId ? null : rootParentId,
      status: match ? "EXISTS" : "CREATE",
      existingLocationId: match?.id ?? null,
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
    const parent = resolveParent(
      locations,
      parsed.parentName,
      input.selectedParentId
    );
    return {
      mode: "LOCATION_STRUCTURE" as const,
      instruction: input.instruction,
      parentName: parsed.parentName,
      parentLocationId: parent.id,
      parentCandidates: parent.candidates,
      unresolvedParent: parent.unresolved,
      nodes: parent.unresolved
        ? []
        : resolveDuplicates(locations, parsed.descriptors, parent.id),
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
    ? resolveParent(locations, null, input.selectedParentId)
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
  const nodes = resolveDuplicates(locations, proposals, parent.id);
  return {
    mode: "LOCATION_STRUCTURE" as const,
    instruction: input.instruction,
    parentName: null,
    parentLocationId: parent.id,
    parentCandidates: parent.candidates,
    unresolvedParent: parent.unresolved,
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
            status: z.enum(["CREATE", "EXISTS"]),
            existingLocationId: z.string().nullable(),
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
        normalizeName(location.name) === normalizeName(node.name)
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
