import { z } from "zod";
import { db } from "~/database/db.server";
import { requestImportHelperProposal } from "~/modules/ioio-staff/import-helper-client.server";
import {
  ORGANIZATION_PLAN_SCHEMA_VERSION,
  type AnyImportHelperRequest,
} from "~/modules/ioio-staff/import-helper-contract.server";
import { createLocation } from "~/modules/location/service.server";
import { deleteLocation } from "~/modules/location/service.server";
import { Logger } from "~/utils/logger";

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
  reviewNote?: string;
};

export type BulkStructureSummary = {
  sectionsScanned: number;
  shelvesScanned: number;
  newShelves: number;
  existingTargetCount: number;
  newTargetCount: number;
  newTargetsUnderExistingShelves: number;
  totalNewLocations: number;
  targetLabel: "containers" | "drawers";
  emptySections: string[];
  alreadyCompleteShelves: string[];
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
  bulkSummary?: BulkStructureSummary;
  source: "DETERMINISTIC" | "AI";
  deletionReview?: {
    parentPath: string | null;
    sections: Array<{
      sectionName: string;
      requestedQuantity:
        | "ALL"
        | { mode: "COUNT"; count: number }
        | { numerator: number; denominator: number };
      total: number;
      selected: Array<{
        id: string;
        name: string;
        path: string;
        reason: string;
      }>;
      blocked: Array<{
        id: string;
        name: string;
        path: string;
        reason: string;
      }>;
    }>;
    totalSelected: number;
  };
  planError?: string;
};

export function classifyOrganizationRequest(
  instruction: string
):
  | "LOCATION_STRUCTURE"
  | "INVENTORY_REORGANIZATION"
  | "MIXED_OR_ADVISORY"
  | "UNSUPPORTED" {
  const text = instruction.toLowerCase();
  const structureNoun =
    /\b(room|section|shelves?|drawers?|containers?|cabinets?|storage area|locations?)\b/.test(
      text
    );
  const structureVerb =
    /\b(create|add|make|build|ensure|remove|delete|clear|rename|merge|split|restructure)\b/.test(
      text
    );
  const inventoryNoun =
    /\b(items?|assets?|inventory|products?|electronics|boards?|sensors?|cables?)\b/.test(
      text
    );
  const inventoryVerb =
    /\b(move|relocate|reorganize|place|stored|placement|wrong location|better places?)\b/.test(
      text
    );
  const explicitStructureNoun =
    /\b(room|section|shelves?|drawers?|containers?|cabinets?|storage area)\b/.test(
      text
    );
  const destructiveStructureVerb =
    /\b(remove|delete|clear|rename|merge|split|create|add|make|build|ensure)\b/.test(
      text
    );
  const mixedIntent =
    /\b(layout|structure)\b/.test(text) && inventoryNoun && inventoryVerb;
  if (mixedIntent) return "MIXED_OR_ADVISORY";
  if (inventoryNoun && inventoryVerb && !destructiveStructureVerb)
    return "INVENTORY_REORGANIZATION";
  if (inventoryNoun && inventoryVerb && !explicitStructureNoun)
    return "INVENTORY_REORGANIZATION";
  if (structureNoun && structureVerb) {
    return inventoryNoun && inventoryVerb
      ? "MIXED_OR_ADVISORY"
      : "LOCATION_STRUCTURE";
  }
  if (inventoryNoun && inventoryVerb) return "INVENTORY_REORGANIZATION";
  if (structureNoun) return "LOCATION_STRUCTURE";
  return "UNSUPPORTED";
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

export type ParsedBulkLocationStructure = {
  parentName: string;
  sectionsThenShelves: boolean;
  count: number;
  itemType: "container" | "drawer";
  sectionShelfRule?: {
    sectionName: string | null;
    mode: "IF_NONE" | "ENSURE";
    shelfCount: number;
    childrenPerShelf?: { count: number; itemType: "container" | "drawer" };
  };
  ensureSectionShelves?: {
    count: number;
    childrenPerShelf: { count: number; itemType: "container" | "drawer" };
  };
  shelfCondition?: {
    mode: "IF_NONE" | "IF_FEWER_THAN";
    count: number;
    itemType: "container" | "drawer";
    threshold?: number;
  };
};

type StructurePlanNode = {
  key: string;
  name: string;
  existingLocationId?: string;
  parentExistingLocationId?: string | null;
  parentPlanKey?: string;
  status: "EXISTS" | "CREATE";
  description: string | null;
  reviewNote?: string;
};

export function parseDeterministicBulkLocationStructure(
  instruction: string
): ParsedBulkLocationStructure | null {
  const text = instruction.trim();
  const number = "(\\d+|[a-z]+)";
  const item = "(containers?|drawers?)";
  const ifShelfHasNoChildren = new RegExp(
    `^\\s*if\\s+(shelf\\s+[a-z0-9][a-z0-9 .-]*?)\\s+(?:doesn't\\s+have\\s+any|does\\s+not\\s+have\\s+any|has\\s+no)\\s+${item}\\s*,?\\s*(?:then\\s+)?(?:create|add|make|build)\\s+${number}\\s*\\.?\\s*$`,
    "i"
  ).exec(text);
  if (ifShelfHasNoChildren) {
    const count = parseCount(ifShelfHasNoChildren[3]!);
    if (!count) return null;
    const itemType = ifShelfHasNoChildren[2]!.toLowerCase().startsWith("drawer")
      ? "drawer"
      : "container";
    return {
      parentName: ifShelfHasNoChildren[1]!.trim(),
      sectionsThenShelves: false,
      count: 0,
      itemType,
      shelfCondition: { mode: "IF_NONE", count, itemType },
    };
  }

  const ifShelfHasFewerChildren = new RegExp(
    `^\\s*if\\s+(shelf\\s+[a-z0-9][a-z0-9 .-]*?)\\s+has\\s+fewer\\s+than\\s+${number}\\s+${item}\\s*,?\\s*(?:then\\s+)?(?:ensure|create|add|make|build)\\s+${number}\\s*(?:${item})?\\s*\\.?\\s*$`,
    "i"
  ).exec(text);
  if (ifShelfHasFewerChildren) {
    const threshold = parseCount(ifShelfHasFewerChildren[2]!);
    const count = parseCount(ifShelfHasFewerChildren[4]!);
    if (!threshold || !count) return null;
    const itemType = ifShelfHasFewerChildren[3]!
      .toLowerCase()
      .startsWith("drawer")
      ? "drawer"
      : "container";
    return {
      parentName: ifShelfHasFewerChildren[1]!.trim(),
      sectionsThenShelves: false,
      count: 0,
      itemType,
      shelfCondition: { mode: "IF_FEWER_THAN", count, itemType, threshold },
    };
  }

  const ifNoChildrenOnEachShelf = new RegExp(
    `^\\s*if\\s+(?:there\\s+are\\s+)?no\\s+${item}\\s+(?:on|in|under)\\s+(?:each|every)\\s+shelf(?:\\s+in\\s+(.+?))?\\s*,?\\s*(?:then\\s+)?(?:add|create|make|build)\\s+${number}\\s*\\.?\\s*$`,
    "i"
  ).exec(text);
  if (ifNoChildrenOnEachShelf) {
    const count = parseCount(ifNoChildrenOnEachShelf[3]!);
    if (!count) return null;
    const itemType = ifNoChildrenOnEachShelf[1]!
      .toLowerCase()
      .startsWith("drawer")
      ? "drawer"
      : "container";
    return {
      parentName: ifNoChildrenOnEachShelf[2]?.trim() ?? "",
      sectionsThenShelves: false,
      count: 0,
      itemType,
      shelfCondition: { mode: "IF_NONE", count, itemType },
    };
  }

  const ensureNamedShelves = new RegExp(
    `^\\s*ensure\\s+(?:the\\s+)?(section\\s+[a-z0-9]+)\\s+(?:has|have)\\s+${number}\\s+shelves?\\s*\\.?\\s*$`,
    "i"
  ).exec(text);
  if (ensureNamedShelves) {
    const count = parseCount(ensureNamedShelves[2]!);
    if (!count) return null;
    return {
      parentName: ensureNamedShelves[1]!.trim(),
      sectionsThenShelves: false,
      count: 0,
      itemType: "container",
      ensureSectionShelves: {
        count,
        childrenPerShelf: { count: 0, itemType: "container" },
      },
    };
  }
  const ensureEveryShelf = new RegExp(
    `\\bensure\\s+(?:every|each)\\s+shelf\\s+in\\s+(.+?)\\s+(?:has|have)\\s+${number}\\s+${item}\\b`,
    "i"
  ).exec(text);
  if (ensureEveryShelf) {
    const count = parseCount(ensureEveryShelf[2]!);
    if (!count) return null;
    return {
      parentName: ensureEveryShelf[1]!.trim().replace(/[.!?]+$/, ""),
      sectionsThenShelves: false,
      count,
      itemType: ensureEveryShelf[3]!.toLowerCase().startsWith("drawer")
        ? "drawer"
        : "container",
    };
  }

  const ensureNamedSection = new RegExp(
    `\\bensure\\s+(?:the\\s+)?(section\\s+[a-z0-9]+)\\s+(?:has|have)\\s+${number}\\s+shelves?\\s*(?:and\\s+)?(?:each|every)\\s+shelf\\s+(?:has|have)\\s+${number}\\s+${item}\\b`,
    "i"
  ).exec(text);
  if (ensureNamedSection) {
    const shelfCount = parseCount(ensureNamedSection[2]!);
    const childCount = parseCount(ensureNamedSection[3]!);
    if (!shelfCount || !childCount) return null;
    const childType = ensureNamedSection[4]!.toLowerCase().startsWith("drawer")
      ? "drawer"
      : "container";
    return {
      parentName: ensureNamedSection[1]!.trim(),
      sectionsThenShelves: false,
      count: 0,
      itemType: "container",
      ensureSectionShelves: {
        count: shelfCount,
        childrenPerShelf: { count: childCount, itemType: childType },
      },
    };
  }

  const everyEmptySection = new RegExp(
    `^(?:(?:for\\s+)?(?:each|every)\\s+section|if\\s+(?:a\\s+)?section)(?:\\s+in\\s+(.+?))?\\s+(?:with\\s+no|that\\s+has\\s+no|which\\s+has\\s+no|has\\s+no)\\s+shelves?\\s+(?:then\\s+)?(?:create|add|make|build)\\s+${number}\\s+shelves?\\s*(?:,?\\s*(?:(?:and|then)\\s+)?(?:add|put|create)\\s+${number}\\s+${item}\\s+(?:to|under|on)\\s+each)?\\s*[.!]?\\s*$`,
    "i"
  ).exec(text);
  if (everyEmptySection) {
    const shelfCount = parseCount(everyEmptySection[2]!);
    const childCount = everyEmptySection[3]
      ? parseCount(everyEmptySection[3])
      : undefined;
    if (!shelfCount || (everyEmptySection[3] && !childCount)) return null;
    const childType = everyEmptySection[4]?.toLowerCase().startsWith("drawer")
      ? "drawer"
      : "container";
    return {
      parentName: everyEmptySection[1]?.trim() ?? "",
      sectionsThenShelves: true,
      count: 0,
      itemType: childType,
      sectionShelfRule: {
        sectionName: null,
        mode: "IF_NONE",
        shelfCount,
        ...(childCount
          ? { childrenPerShelf: { count: childCount, itemType: childType } }
          : {}),
      },
    };
  }

  const baseText = text.split(/\bif\b/i, 1)[0]!.trim();
  const conditional = text.match(/\bif\b([\s\S]+)$/i)?.[1]?.trim();
  let base: ParsedBulkLocationStructure | null = null;
  const sectionShelf = new RegExp(
    `\\bfor\\s+(?:each|every)\\s+section\\s+in\\s+(?:the\\s+)?(.+?)\\s*,?\\s+for\\s+(?:each|every)\\s+shelf\\s+(?:create|add|make|build)\\s+${number}\\s+${item}\\b`,
    "i"
  ).exec(baseText);
  if (sectionShelf) {
    const count = parseCount(sectionShelf[2]!);
    if (!count) return null;
    base = {
      parentName: sectionShelf[1]!.trim().replace(/[.!?]+$/, ""),
      sectionsThenShelves: true,
      count,
      itemType: sectionShelf[3]!.toLowerCase().startsWith("drawer")
        ? "drawer"
        : "container",
    };
  }

  const shelfFirst = base
    ? null
    : new RegExp(
        `\\b(?:for\\s+)?(?:each|every)\\s+shelf\\s+in\\s+(?:the\\s+)?(.+?)\\s*,?\\s+(?:create|add|make|build)\\s+${number}\\s+${item}\\b`,
        "i"
      ).exec(baseText);
  if (shelfFirst) {
    const count = parseCount(shelfFirst[2]!);
    if (!count) return null;
    base = {
      parentName: shelfFirst[1]!.trim().replace(/[.!?]+$/, ""),
      sectionsThenShelves: false,
      count,
      itemType: shelfFirst[3]!.toLowerCase().startsWith("drawer")
        ? "drawer"
        : "container",
    };
  }

  const itemFirst = base
    ? null
    : new RegExp(
        `\\b(?:create|add|make|build)\\s+${number}\\s+${item}\\s+(?:under|to|for)\\s+(?:each|every)\\s+shelf\\s+in\\s+(?:the\\s+)?(.+?)\\s*$`,
        "i"
      ).exec(baseText);
  if (itemFirst) {
    const count = parseCount(itemFirst[1]!);
    if (!count) return null;
    base = {
      parentName: itemFirst[3]!.trim().replace(/[.!?]+$/, ""),
      sectionsThenShelves: false,
      count,
      itemType: itemFirst[2]!.toLowerCase().startsWith("drawer")
        ? "drawer"
        : "container",
    };
  }

  if (base && !conditional) return base;

  const conditionPatterns = [
    new RegExp(
      `^(?:the\\s+)?(section\\s+[a-z0-9]+|a\\s+section)\\s+(?:doesn't\\s+have\\s+any|does\\s+not\\s+have\\s+any|has\\s+no)\\s+shelves?\\s+(?:then\\s+)?(?:create|add|make|build)\\s+${number}\\s*(?:shelves?)?\\s*(?:and\\s+(?:for\\s+each\\s+(?:one|shelf)|each)\\s+(?:create|add|make|build)\\s+${number}\\s+${item})?\\s*[.!]?\\s*$`,
      "i"
    ),
    new RegExp(
      `^(?:the\\s+)?(section\\s+[a-z0-9]+|a\\s+section)\\s+(?:doesn't\\s+have\\s+any|does\\s+not\\s+have\\s+any|has\\s+no)\\s+shelves?\\s+(?:then\\s+)?(?:create|add|make|build)\\s+${number}\\s+shelves?\\s*,?\\s*(?:(?:and|then)\\s+)?(?:add|put|create)\\s+${number}\\s+${item}\\s+(?:to|under|on)\\s+each\\b\\s*[.!]?\\s*$`,
      "i"
    ),
  ];
  if (conditional) {
    for (const pattern of conditionPatterns) {
      const match = pattern.exec(conditional);
      if (!match) continue;
      const sectionName = /^a\s+section$/i.test(match[1]!)
        ? null
        : match[1]!.trim();
      const shelfCount = parseCount(match[2]!);
      const childCount = match[3] ? parseCount(match[3]) : undefined;
      const childTypeMatch = match[4];
      if (!shelfCount || (match[3] && !childCount)) continue;
      const rule = {
        sectionName,
        mode: "IF_NONE" as const,
        shelfCount,
        ...(childCount && childTypeMatch
          ? {
              childrenPerShelf: {
                count: childCount,
                itemType: childTypeMatch.toLowerCase().startsWith("drawer")
                  ? ("drawer" as const)
                  : ("container" as const),
              },
            }
          : {}),
      };
      if (base) return { ...base, sectionShelfRule: rule };
      return {
        parentName: sectionName ?? "",
        sectionsThenShelves: false,
        count: 0,
        itemType: childTypeMatch?.toLowerCase().startsWith("drawer")
          ? "drawer"
          : "container",
        sectionShelfRule: rule,
      };
    }
  }

  const ensureRule = text.match(
    /^\s*ensure\s+(?:the\s+)?(section\s+[a-z0-9]+)\s+(?:has|have)\s+(\d+|[a-z]+)\s+shelves?\s*(?:and\s+)?(?:put|add|create)\s+(\d+|[a-z]+)\s+(containers?|drawers?)\s+(?:on|under|in)\s+each\s+shelf\s*$/i
  );
  if (ensureRule) {
    const shelfCount = parseCount(ensureRule[2]!);
    const childCount = parseCount(ensureRule[3]!);
    if (!shelfCount || !childCount) return null;
    const childType = ensureRule[4]!.toLowerCase().startsWith("drawer")
      ? "drawer"
      : "container";
    return {
      parentName: ensureRule[1]!.trim(),
      sectionsThenShelves: false,
      count: shelfCount,
      itemType: "container",
      sectionShelfRule: {
        sectionName: ensureRule[1]!.trim(),
        mode: "ENSURE",
        shelfCount,
        childrenPerShelf: { count: childCount, itemType: childType },
      },
      ensureSectionShelves: {
        count: shelfCount,
        childrenPerShelf: { count: childCount, itemType: childType },
      },
    };
  }

  return base;
}

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

function locationChildren(locations: OrganizationLocation[]) {
  const children = new Map<string, OrganizationLocation[]>();
  for (const location of locations) {
    if (!location.parentId) continue;
    const siblings = children.get(location.parentId) ?? [];
    siblings.push(location);
    children.set(location.parentId, siblings);
  }
  for (const siblings of children.values())
    siblings.sort((a, b) => a.name.localeCompare(b.name));
  return children;
}

function isSectionLocation(location: OrganizationLocation) {
  return /^sec(?:tion|iton)\b/i.test(location.name);
}

function isShelfLocation(location: OrganizationLocation) {
  return /^shelf\b/i.test(location.name);
}

function expandBulkStructure(
  locations: OrganizationLocation[],
  parent: OrganizationLocation,
  parsed: ParsedBulkLocationStructure,
  path: (id: string) => string
) {
  const children = locationChildren(locations);
  const parentIsSection = isSectionLocation(parent);
  const sections = parentIsSection
    ? [parent]
    : (children.get(parent.id) ?? []).filter(isSectionLocation);
  const plan: StructurePlanNode[] = [];
  const emptySections: string[] = [];
  const alreadyCompleteShelves: string[] = [];
  let shelvesScanned = 0;
  let newShelves = 0;
  let existingTargetCount = 0;
  let newTargetCount = 0;
  let newTargetsUnderExistingShelves = 0;

  const keyFor = (location: OrganizationLocation) => "existing-" + location.id;
  const addPlan = (node: StructurePlanNode) => {
    plan.push(node);
  };
  const addExisting = (
    location: OrganizationLocation,
    parentLocationId: string | null,
    parentPlanKey?: string,
    reviewNote?: string
  ) => {
    addPlan({
      key: keyFor(location),
      name: location.name,
      existingLocationId: location.id,
      parentExistingLocationId: parentLocationId,
      ...(parentPlanKey ? { parentPlanKey } : {}),
      status: "EXISTS",
      description: location.description,
      ...(reviewNote ? { reviewNote } : {}),
    });
  };
  const targetNames = (
    shelfName: string,
    count: number,
    itemType: "container" | "drawer"
  ) => {
    const suffix = shelfName.match(
      /^shelf\s+([a-z0-9]+(?:[-.][a-z0-9]+)*)$/i
    )?.[1];
    const title = itemType === "drawer" ? "Drawer" : "Container";
    return {
      title,
      names: Array.from(
        { length: count },
        (_, index) =>
          title +
          " " +
          (suffix ? suffix + "-" : shelfName.trim() + "-") +
          (index + 1)
      ),
      reviewNote: suffix
        ? undefined
        : "Could not identify a numbered shelf suffix; review these names based on " +
          shelfName +
          ".",
    };
  };
  const addChildren = ({
    shelfName,
    shelfKey,
    shelfExistingId,
    count,
    itemType,
    existingChildren,
  }: {
    shelfName: string;
    shelfKey: string;
    shelfExistingId?: string;
    count: number;
    itemType: "container" | "drawer";
    existingChildren: OrganizationLocation[];
  }) => {
    const { title, names, reviewNote } = targetNames(
      shelfName,
      count,
      itemType
    );
    const handled = new Set<string>();
    let missing = 0;
    for (const [index, name] of names.entries()) {
      const matches = existingChildren.filter(
        (candidate) => comparableName(candidate.name) === comparableName(name)
      );
      const existing = matches.length === 1 ? matches[0] : undefined;
      if (existing) {
        handled.add(existing.id);
        existingTargetCount++;
      } else if (matches.length === 0) {
        missing++;
        newTargetCount++;
        if (shelfExistingId) newTargetsUnderExistingShelves++;
      }
      addPlan({
        key: "bulk-" + shelfKey + "-" + itemType + "-" + (index + 1),
        name,
        ...(existing ? { existingLocationId: existing.id } : {}),
        parentPlanKey: shelfKey,
        status: existing || matches.length > 1 ? "EXISTS" : "CREATE",
        description: title + " " + (index + 1) + " under " + shelfName + ".",
        ...(matches.length > 1
          ? {
              reviewNote:
                "Multiple exact existing matches for " +
                name +
                "; review before creating.",
            }
          : reviewNote
          ? { reviewNote }
          : {}),
      });
    }
    if (missing === 0 && shelfExistingId)
      alreadyCompleteShelves.push(path(shelfExistingId));
    for (const child of existingChildren) {
      if (
        child.name.toLowerCase().startsWith(title.toLowerCase()) &&
        !handled.has(child.id) &&
        !names.some(
          (name) => comparableName(name) === comparableName(child.name)
        )
      ) {
        addExisting(
          child,
          null,
          shelfKey,
          "Existing sibling; it does not satisfy a numbered target."
        );
      }
    }
  };

  if (parsed.shelfCondition && isShelfLocation(parent)) {
    addExisting(parent, parent.parentId);
    const itemPattern =
      parsed.shelfCondition.itemType === "drawer"
        ? /^drawer\b/i
        : /^container\b/i;
    const existingTargets = (children.get(parent.id) ?? []).filter((location) =>
      itemPattern.test(location.name)
    );
    const conditionMet =
      parsed.shelfCondition.mode === "IF_NONE"
        ? existingTargets.length === 0
        : existingTargets.length < (parsed.shelfCondition.threshold ?? 0);
    if (conditionMet) {
      addChildren({
        shelfName: parent.name,
        shelfKey: keyFor(parent),
        shelfExistingId: parent.id,
        count: parsed.shelfCondition.count,
        itemType: parsed.shelfCondition.itemType,
        existingChildren: existingTargets,
      });
    } else {
      existingTargetCount = existingTargets.length;
    }
    const nodes: StructureNode[] = plan.map((node) => ({
      temporaryId: node.key,
      parentLocationId: node.parentExistingLocationId ?? null,
      parentTemporaryId: node.parentPlanKey ?? null,
      name: node.name,
      description: node.description,
      status: node.status,
      existingLocationId: node.existingLocationId ?? null,
      ...(node.reviewNote ? { reviewNote: node.reviewNote } : {}),
    }));
    return {
      nodes,
      bulkSummary: {
        sectionsScanned: 0,
        shelvesScanned: 1,
        newShelves: 0,
        existingTargetCount,
        newTargetCount,
        newTargetsUnderExistingShelves: newTargetCount,
        totalNewLocations: newTargetCount,
        targetLabel:
          parsed.shelfCondition.itemType === "drawer"
            ? "drawers"
            : "containers",
        emptySections: [],
        alreadyCompleteShelves: newTargetCount === 0 ? [path(parent.id)] : [],
      } satisfies BulkStructureSummary,
    };
  }

  const rule = parsed.sectionShelfRule;
  const ensure = parsed.ensureSectionShelves;
  const selectedSections = rule?.sectionName
    ? sections.filter(
        (section) =>
          normalizeName(section.name) === normalizeName(rule.sectionName!)
      )
    : sections;

  for (const section of sections) {
    const scopedRoot = section.id === parent.id;
    const sectionKey = keyFor(section);
    const currentShelves = (children.get(section.id) ?? []).filter(
      isShelfLocation
    );
    const appliesRule = selectedSections.some(({ id }) => id === section.id);
    const shouldCreateForCondition =
      appliesRule && rule?.mode === "IF_NONE" && currentShelves.length === 0;
    const desiredCount =
      appliesRule && rule?.mode === "ENSURE"
        ? rule.shelfCount
        : appliesRule && ensure
        ? ensure.count
        : shouldCreateForCondition
        ? rule!.shelfCount
        : 0;
    const generatedNames =
      desiredCount > 0
        ? Array.from({ length: desiredCount }, (_, index) => {
            const sectionLabel = section.name
              .replace(/^section\s+/i, "")
              .trim();
            return "Shelf " + sectionLabel + (index + 1);
          })
        : [];
    const currentByName = new Map(
      currentShelves.map((shelf) => [comparableName(shelf.name), shelf])
    );
    let targetShelves = [...currentShelves];
    if (shouldCreateForCondition) {
      targetShelves = generatedNames.map((name, index) => ({
        id: "planned:" + section.id + ":" + (index + 1),
        name,
        parentId: section.id,
        description: "Storage shelf in " + section.name + ".",
      }));
    } else if (desiredCount > 0) {
      targetShelves = generatedNames.map(
        (name, index) =>
          currentByName.get(comparableName(name)) ?? {
            id: "planned:" + section.id + ":" + (index + 1),
            name,
            parentId: section.id,
            description: "Storage shelf in " + section.name + ".",
          }
      );
    }

    if (!scopedRoot)
      addExisting(
        section,
        parent.id,
        undefined,
        currentShelves.length === 0 && targetShelves.length === 0
          ? "No shelves found — nothing to create."
          : undefined
      );
    if (currentShelves.length === 0 && targetShelves.length === 0)
      emptySections.push(section.name);

    shelvesScanned += currentShelves.length;
    for (const shelf of targetShelves) {
      const existing = !shelf.id.startsWith("planned:");
      const shelfKey = existing
        ? keyFor(shelf)
        : "planned-" + section.id + "-" + shelf.name;
      if (existing) {
        addExisting(
          shelf,
          scopedRoot ? section.id : null,
          scopedRoot ? undefined : sectionKey
        );
      } else {
        addPlan({
          key: shelfKey,
          name: shelf.name,
          parentExistingLocationId: scopedRoot ? section.id : null,
          ...(!scopedRoot ? { parentPlanKey: sectionKey } : {}),
          status: "CREATE",
          description: shelf.description,
        });
        newShelves++;
      }

      const childRule =
        (existing && parsed.count > 0
          ? { count: parsed.count, itemType: parsed.itemType }
          : undefined) ??
        (desiredCount > 0
          ? rule?.childrenPerShelf ?? ensure?.childrenPerShelf
          : undefined);
      if (existing && parsed.shelfCondition) {
        const matchingChildren = (children.get(shelf.id) ?? []).filter(
          (location) =>
            parsed.shelfCondition!.itemType === "drawer"
              ? /^drawer\b/i.test(location.name)
              : /^container\b/i.test(location.name)
        );
        const conditionMet =
          parsed.shelfCondition.mode === "IF_NONE"
            ? matchingChildren.length === 0
            : matchingChildren.length < (parsed.shelfCondition.threshold ?? 0);
        if (conditionMet) {
          addChildren({
            shelfName: shelf.name,
            shelfKey,
            shelfExistingId: shelf.id,
            count: parsed.shelfCondition.count,
            itemType: parsed.shelfCondition.itemType,
            existingChildren: [],
          });
        } else {
          existingTargetCount += matchingChildren.length;
        }
        continue;
      }
      if (!childRule) continue;
      const existingChildren = existing
        ? (children.get(shelf.id) ?? []).filter((location) =>
            childRule.itemType === "drawer"
              ? /^drawer\b/i.test(location.name)
              : /^container\b/i.test(location.name)
          )
        : [];
      addChildren({
        shelfName: shelf.name,
        shelfKey,
        ...(existing ? { shelfExistingId: shelf.id } : {}),
        count: childRule.count,
        itemType: childRule.itemType,
        existingChildren,
      });
    }
  }

  const nodes: StructureNode[] = plan.map((node) => ({
    temporaryId: node.key,
    parentLocationId: node.parentExistingLocationId ?? null,
    parentTemporaryId: node.parentPlanKey ?? null,
    name: node.name,
    description: node.description,
    status: node.status,
    existingLocationId: node.existingLocationId ?? null,
    ...(node.reviewNote ? { reviewNote: node.reviewNote } : {}),
  }));
  return {
    nodes,
    bulkSummary: {
      sectionsScanned: sections.length,
      shelvesScanned,
      newShelves,
      existingTargetCount,
      newTargetCount,
      newTargetsUnderExistingShelves,
      totalNewLocations: newShelves + newTargetCount,
      targetLabel:
        rule?.childrenPerShelf?.itemType === "drawer" ||
        ensure?.childrenPerShelf.itemType === "drawer" ||
        parsed.itemType === "drawer"
          ? ("drawers" as const)
          : ("containers" as const),
      emptySections,
      alreadyCompleteShelves,
    } satisfies BulkStructureSummary,
  };
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
  const parsedBulk = parseDeterministicBulkLocationStructure(input.instruction);
  if (parsedBulk) {
    const { path, byId } = makePaths(locations);
    const roots = locations.filter((location) => location.parentId === null);
    const parent = parsedBulk.parentName
      ? resolveParent(locations, parsedBulk.parentName, input.selectedParentId)
      : input.selectedParentId
      ? (() => {
          const selected = locations.find(
            ({ id }) => id === input.selectedParentId
          );
          return selected
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
                resolution: "MATCHED" as const,
              }
            : {
                id: null,
                candidates: [],
                unresolved: true,
                resolution: "UNRESOLVED" as const,
              };
        })()
      : roots.length === 1
      ? resolveParent(locations, null, roots[0]!.id)
      : {
          id: null,
          candidates: roots.map((location) => ({
            id: location.id,
            name: location.name,
            path: path(location.id),
          })),
          unresolved: true,
          resolution: "AMBIGUOUS_ROOT" as const,
        };
    const resolvedParent = parent.id ? byId.get(parent.id) : undefined;
    if (resolvedParent && !parent.unresolved) {
      const expanded = expandBulkStructure(
        locations,
        resolvedParent,
        parsedBulk,
        path
      );
      return {
        mode: "LOCATION_STRUCTURE" as const,
        instruction: input.instruction,
        parentName: parsedBulk.parentName,
        parentLocationId: resolvedParent.id,
        parentCandidates: parent.candidates,
        unresolvedParent: false,
        parentResolution: "MATCHED" as const,
        createMissingParent: false,
        ...expanded,
        source: "DETERMINISTIC" as const,
      };
    }
    const choices =
      parent.candidates.length > 0
        ? parent.candidates
        : (roots.length > 0 ? roots : locations)
            .slice(0, 20)
            .map((location) => ({
              id: location.id,
              name: location.name,
              path: path(location.id),
            }));
    return {
      mode: "LOCATION_STRUCTURE" as const,
      instruction: input.instruction,
      parentName: parsedBulk.parentName,
      parentLocationId: null,
      parentCandidates: choices,
      unresolvedParent: true,
      parentResolution:
        parent.resolution === "AMBIGUOUS_MATCH"
          ? ("AMBIGUOUS_MATCH" as const)
          : roots.length > 1
          ? ("AMBIGUOUS_ROOT" as const)
          : ("UNRESOLVED" as const),
      createMissingParent: false,
      nodes: [],
      bulkSummary: {
        sectionsScanned: 0,
        shelvesScanned: 0,
        newShelves: 0,
        existingTargetCount: 0,
        newTargetCount: 0,
        newTargetsUnderExistingShelves: 0,
        totalNewLocations: 0,
        targetLabel:
          parsedBulk.itemType === "drawer" ? "drawers" : "containers",
        emptySections: [],
        alreadyCompleteShelves: [],
      },
      source: "DETERMINISTIC" as const,
    };
  }
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
    mode: "ORGANIZATION_PLAN" as const,
    schemaVersion: ORGANIZATION_PLAN_SCHEMA_VERSION,
    instruction: input.instruction,
    locationContext: relevant.map((location) => ({
      name: location.name,
      path: path(location.id),
      childSummary: `${
        locations.filter((entry) => entry.parentId === location.id).length
      } direct children`,
    })),
  };
  const result = await requestImportHelperProposal(
    request as AnyImportHelperRequest
  );
  if (result.status !== "ready" || !("domain" in result.proposal)) {
    const roots = locations.filter((location) => location.parentId === null);
    const fallbackLocations = (roots.length ? roots : locations).slice(0, 20);
    const fallbackCandidates = fallbackLocations.map((location) => ({
      id: location.id,
      name: location.name,
      path: path(location.id),
    }));
    Logger.warn({
      event: "ioio_location_structure_helper_fallback",
      locationCandidateCount: fallbackCandidates.length,
      resolvedRootCount: roots.length,
      structureMode: "LOCATION_STRUCTURE",
      deterministicMatchAttempted: true,
      helperProposalReady: false,
    });
    return {
      mode: "LOCATION_STRUCTURE" as const,
      instruction: input.instruction,
      parentName: null,
      parentLocationId: null,
      parentCandidates: fallbackCandidates,
      unresolvedParent: true,
      parentResolution:
        roots.length > 1
          ? ("AMBIGUOUS_ROOT" as const)
          : ("UNRESOLVED" as const),
      createMissingParent: false,
      nodes: [],
      source: "AI" as const,
      helperUnavailable: true,
      planError:
        "Could not interpret the structure request. No inventory analysis was performed.",
    };
  }
  if (result.proposal.domain !== "LOCATION_STRUCTURE") {
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
      planError:
        "Could not interpret the structure request. No inventory analysis was performed.",
    };
  }
  const allCreateOperations = result.proposal.operations.every(
    (operation) => operation.operation === "CREATE_LOCATION"
  );
  const allDeleteChildOperations = result.proposal.operations.every(
    (operation) => operation.operation === "DELETE_CHILDREN"
  );
  if (
    !result.proposal.operations.length ||
    (!allCreateOperations && !allDeleteChildOperations) ||
    (allDeleteChildOperations &&
      result.proposal.operations.some(
        (operation) =>
          operation.operation === "DELETE_CHILDREN" &&
          operation.childTypeHint !== "container" &&
          operation.childTypeHint !== "drawer"
      ))
  ) {
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
      planError:
        "This request includes structure operations that need a separate supported review. No changes or inventory analysis were performed.",
    };
  }
  const createOps = result.proposal.operations.filter(
    (op) => op.operation === "CREATE_LOCATION"
  );
  if (createOps.length) {
    const { path: locationPath } = makePaths(locations);
    const descriptors: ParsedStructure["descriptors"] = [];
    const helperToPlan = new Map<string, string>();
    let rootParentId: string | null = null;
    for (const [index, operation] of createOps.entries()) {
      let parentTemporaryId: string | null = null;
      if (operation.parentTemporaryId) {
        parentTemporaryId =
          helperToPlan.get(operation.parentTemporaryId) ?? null;
        if (!parentTemporaryId) {
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
            planError: "The proposed parent dependency could not be resolved.",
          };
        }
      } else if (operation.parentRef) {
        const targetName = normalizeName(operation.parentRef.name);
        const parents = locations.filter(
          (location) =>
            normalizeName(location.name) === targetName &&
            (!operation.parentRef!.ancestorName ||
              normalizeName(locationPath(location.id)).includes(
                normalizeName(operation.parentRef!.ancestorName!)
              ))
        );
        if (
          parents.length !== 1 ||
          (rootParentId && rootParentId !== parents[0]?.id)
        ) {
          return {
            mode: "LOCATION_STRUCTURE" as const,
            instruction: input.instruction,
            parentName: operation.parentRef.name,
            parentLocationId: null,
            parentCandidates: parents.map((location) => ({
              id: location.id,
              name: location.name,
              path: locationPath(location.id),
            })),
            unresolvedParent: true,
            parentResolution: "AMBIGUOUS_MATCH" as const,
            createMissingParent: false,
            nodes: [],
            source: "AI" as const,
            planError: parents.length
              ? "Choose the intended parent location to continue."
              : "The requested parent location could not be resolved.",
          };
        }
        rootParentId = parents[0]!.id;
      }
      const planKey = `plan-${index}`;
      helperToPlan.set(operation.temporaryId, planKey);
      descriptors.push({
        temporaryId: planKey,
        name: operation.name,
        parentTemporaryId,
        description: operation.description,
      });
    }
    return {
      mode: "LOCATION_STRUCTURE" as const,
      instruction: input.instruction,
      parentName: null,
      parentLocationId: rootParentId,
      parentCandidates: rootParentId
        ? [
            {
              id: rootParentId,
              name: locations.find(({ id }) => id === rootParentId)!.name,
              path: locationPath(rootParentId),
            },
          ]
        : [],
      unresolvedParent: !rootParentId,
      parentResolution: rootParentId
        ? ("MATCHED" as const)
        : ("UNRESOLVED" as const),
      createMissingParent: false,
      nodes: resolveDuplicates(
        locations,
        descriptors,
        rootParentId,
        locationPath
      ),
      source: "AI" as const,
    };
  }
  const deletionOps = result.proposal.operations.filter(
    (op) => op.operation === "DELETE_CHILDREN"
  );
  if (deletionOps.length) {
    const childrenByParent = new Map<string, typeof locations>();
    for (const location of locations) {
      if (!location.parentId) continue;
      childrenByParent.set(location.parentId, [
        ...(childrenByParent.get(location.parentId) ?? []),
        location,
      ]);
    }
    const resolvedOps = deletionOps.map((op) => {
      const targetName = normalizeName(op.targetRef.name);
      const matching = locations.filter(
        (location) =>
          normalizeName(location.name) === targetName &&
          (!op.targetRef.ancestorName ||
            normalizeName(path(location.id)).includes(
              normalizeName(op.targetRef.ancestorName)
            ))
      );
      return { op, matching };
    });
    const sectionIds = [
      ...new Set(
        resolvedOps.flatMap(({ matching }) => matching.map(({ id }) => id))
      ),
    ];
    const shelves = locations.filter(
      (location) =>
        location.parentId &&
        sectionIds.includes(location.parentId) &&
        /^shelf\b/i.test(location.name)
    );
    const shelfIds = shelves.map(({ id }) => id);
    const containers = locations.filter(
      (location) =>
        location.parentId &&
        shelfIds.includes(location.parentId) &&
        deletionOps.some((op) =>
          op.childTypeHint === "container"
            ? /^container\b/i.test(location.name)
            : op.childTypeHint === "drawer"
            ? /^drawer\b/i.test(location.name)
            : false
        )
    );
    const candidateIds = containers.map(({ id }) => id);
    const [assetRows, kitRows] = candidateIds.length
      ? await Promise.all([
          db.assetLocation.findMany({
            where: {
              organizationId: input.organizationId,
              locationId: { in: candidateIds },
            },
            select: { locationId: true, quantity: true },
          }),
          db.kit.findMany({
            where: {
              organizationId: input.organizationId,
              locationId: { in: candidateIds },
            },
            select: { locationId: true },
          }),
        ])
      : [[], []];
    const { path: locationPath } = makePaths(locations);
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    const sections = resolvedOps.flatMap(({ op, matching }) =>
      matching.map((section) => {
        const sectionContainers = containers.filter((container) =>
          shelves.some(
            (shelf) =>
              shelf.id === container.parentId && shelf.parentId === section.id
          )
        );
        const ordered = sectionContainers
          .map((location) => {
            const assigned = assetRows.filter(
              (row) => row.locationId === location.id
            );
            const kits = kitRows.filter(
              (row) => row.locationId === location.id
            ).length;
            const childCount = (childrenByParent.get(location.id) ?? []).length;
            const occupied = assigned.length > 0 || kits > 0 || childCount > 0;
            const reason = assigned.length
              ? `contains ${assigned.length} asset placement(s)`
              : kits
              ? `contains ${kits} kit(s)`
              : childCount
              ? `contains ${childCount} child location(s)`
              : "empty container; safe to remove";
            return { location, occupied, reason };
          })
          .sort(
            (a, b) =>
              Number(a.occupied) - Number(b.occupied) ||
              collator.compare(a.location.name, b.location.name) ||
              a.location.id.localeCompare(b.location.id)
          );
        const total = ordered.length;
        const quantity =
          op.quantity.mode === "ALL"
            ? ("ALL" as const)
            : op.quantity.mode === "FRACTION"
            ? {
                numerator: op.quantity.numerator,
                denominator: op.quantity.denominator,
              }
            : { mode: "COUNT" as const, count: op.quantity.count };
        const wanted =
          op.quantity.mode === "ALL"
            ? total
            : op.quantity.mode === "COUNT"
            ? Math.min(total, op.quantity.count)
            : Math.floor(
                (total * op.quantity.numerator) / op.quantity.denominator
              );
        let remaining = wanted;
        const selected = ordered
          .filter((item) => {
            if (item.occupied || remaining <= 0) return false;
            remaining--;
            return true;
          })
          .map(({ location, reason }) => ({
            id: location.id,
            name: location.name,
            path: locationPath(location.id),
            reason,
          }));
        const blocked = ordered
          .filter(({ occupied }) => occupied)
          .map(({ location, reason }) => ({
            id: location.id,
            name: location.name,
            path: locationPath(location.id),
            reason: `BLOCKED — ${reason}`,
          }));
        return {
          sectionName: section.name,
          requestedQuantity: quantity,
          total,
          selected,
          blocked,
        };
      })
    );
    const unresolved =
      sections.length !== deletionOps.length ||
      resolvedOps.some(({ matching }) => matching.length !== 1);
    if (unresolved) {
      return {
        mode: "LOCATION_STRUCTURE" as const,
        instruction: input.instruction,
        parentName: null,
        parentLocationId: null,
        parentCandidates: locations
          .filter((location) => /section/i.test(location.name))
          .slice(0, 20)
          .map((location) => ({
            id: location.id,
            name: location.name,
            path: locationPath(location.id),
          })),
        unresolvedParent: true,
        parentResolution: "AMBIGUOUS_MATCH" as const,
        createMissingParent: false,
        nodes: [],
        source: "AI" as const,
        planError:
          "One or more section references need staff review because they are missing or ambiguous.",
      };
    }
    return {
      mode: "LOCATION_STRUCTURE" as const,
      instruction: input.instruction,
      parentName: null,
      parentLocationId: null,
      parentCandidates: [],
      unresolvedParent: false,
      parentResolution: "MATCHED" as const,
      createMissingParent: false,
      nodes: [],
      source: "AI" as const,
      deletionReview: {
        parentPath: (() => {
          const ancestor = deletionOps[0]?.targetRef.ancestorName;
          const parent = ancestor
            ? locations.find(
                (location) =>
                  normalizeName(location.name) === normalizeName(ancestor)
              )
            : undefined;
          return parent ? locationPath(parent.id) : null;
        })(),
        sections,
        totalSelected: sections.reduce(
          (sum, section) => sum + section.selected.length,
          0
        ),
      },
    };
  }
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
    planError:
      "This structure operation is not available in the current review flow. No changes were made.",
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
    status: "CREATED" | "EXISTS" | "FAILED" | "BLOCKED";
    error?: string;
  }> = [];
  const resultByTemporaryId = new Map<
    string,
    { name: string; status: "CREATED" | "EXISTS" | "FAILED" | "BLOCKED" }
  >();
  const recordResult = (
    node: (typeof proposal.nodes)[number],
    result: (typeof results)[number]
  ) => {
    results.push(result);
    resultByTemporaryId.set(node.temporaryId, {
      name: node.name,
      status: result.status,
    });
  };
  const pathState = makePaths(locations);
  const { path } = pathState;
  for (const node of proposal.nodes) {
    const parentId = node.parentTemporaryId
      ? resolved.get(node.parentTemporaryId)
      : node.parentLocationId ?? proposal.parentLocationId;
    if (node.parentTemporaryId && !parentId) {
      const failedParent = resultByTemporaryId.get(node.parentTemporaryId);
      recordResult(node, {
        name: node.name,
        path: node.name,
        status: "BLOCKED",
        error: failedParent
          ? "Blocked because parent " +
            failedParent.name +
            " " +
            failedParent.status.toLowerCase() +
            "."
          : "Blocked because the proposed parent is unresolved.",
      });
      continue;
    }
    if (
      parentId &&
      !locations.some(({ id }) => id === parentId) &&
      ![...resolved.values()].includes(parentId)
    ) {
      recordResult(node, {
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
      recordResult(node, {
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
      recordResult(node, {
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
        recordResult(node, {
          name: node.name,
          path: `${parentId ? path(parentId) : ""}${parentId ? " / " : ""}${
            node.name
          }`,
          status: "EXISTS",
        });
        continue;
      }
      recordResult(node, {
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
      recordResult(node, {
        name: node.name,
        path: `${parentId ? path(parentId) : ""}${parentId ? " / " : ""}${
          node.name
        }`,
        status: "CREATED",
      });
    } catch (cause) {
      recordResult(node, {
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
    blockedCount: results.filter(({ status }) => status === "BLOCKED").length,
  };
}

export async function deleteApprovedStructureContainers(input: {
  organizationId: string;
  locationIds: string[];
}) {
  const ids = [...new Set(input.locationIds)];
  if (ids.length > 100)
    throw new Error("Review at most 100 locations per action.");
  const locations = await db.location.findMany({
    where: { organizationId: input.organizationId },
    select: { id: true, name: true, parentId: true, description: true },
  });
  const byId = new Map(locations.map((location) => [location.id, location]));
  const eligible = ids.filter((id) => {
    const container = byId.get(id);
    const shelf = container?.parentId
      ? byId.get(container.parentId)
      : undefined;
    const section = shelf?.parentId ? byId.get(shelf.parentId) : undefined;
    return Boolean(
      container &&
        /^(container|drawer)\b/i.test(container.name) &&
        shelf &&
        /^shelf\b/i.test(shelf.name) &&
        section &&
        /^section\b/i.test(section.name)
    );
  });
  if (eligible.length !== ids.length)
    throw new Error(
      "One or more selected locations are no longer valid containers in this organization."
    );
  const results: Array<{
    id: string;
    status: "DELETED" | "FAILED";
    error?: string;
  }> = [];
  for (const id of eligible) {
    try {
      await deleteLocation({ id, organizationId: input.organizationId });
      results.push({ id, status: "DELETED" });
    } catch (cause) {
      results.push({
        id,
        status: "FAILED",
        error:
          cause instanceof Error
            ? cause.message
            : "Location could not be deleted.",
      });
    }
  }
  return results;
}
