import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { Logger } from "~/utils/logger";
import { sanitizeConversationContent } from "./conversation.shared";
import { requireStudentRead } from "./route.server";
import type { StudentAsset, StudentLocation } from "./service.server";
import {
  getMyStudentLoans,
  getStudentAsset,
  getStudentAssets,
  findStudentAssetFuzzyMatches,
  getStudentKits,
  getStudentLocations,
} from "./service.server";

export const IOIO_READ_ONLY_TOOL_NAMES = [
  "search_inventory",
  "get_item",
  "get_location",
  "get_location_contents",
  "get_kit_status",
  "get_my_loans",
] as const;

export type IoioReadOnlyToolName = (typeof IOIO_READ_ONLY_TOOL_NAMES)[number];

export type IoioToolDefinition = {
  name: IoioReadOnlyToolName;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
};

/**
 * This is intentionally the complete tool surface sent to Claude. Keep this
 * list explicit: no database, filesystem, HTTP, or arbitrary function tool is
 * ever exposed to the provider.
 */
export const IOIO_READ_ONLY_TOOLS: IoioToolDefinition[] = [
  {
    name: "search_inventory",
    description:
      "Search the current user's Shelf workspace inventory by item name, Shelf ID, or category. Use this for item availability and location questions.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Item name or Shelf ID" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "get_item",
    description:
      "Get one organization-scoped Shelf inventory record by its internal ID or sequential Shelf ID.",
    input_schema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Shelf asset ID" },
      },
      required: ["item_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_location",
    description:
      "Get one read-only Shelf location and its parent/child hierarchy by name or ID.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Location name or ID" },
      },
      required: ["location"],
      additionalProperties: false,
    },
  },
  {
    name: "get_location_contents",
    description:
      "List the organization inventory in a Shelf location, including descendant locations.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Location name or ID" },
      },
      required: ["location"],
      additionalProperties: false,
    },
  },
  {
    name: "get_kit_status",
    description:
      "Get a read-only Shelf kit's status, location, QR IDs, and known contents by name or ID, or list all kits when no kit is specified.",
    input_schema: {
      type: "object",
      properties: {
        kit: {
          type: "string",
          description: "Optional kit name or ID; omit to list all kits",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_my_loans",
    description:
      "Get only the signed-in user's own Shelf bookings and loaned assets. Never use this to answer questions about another person.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

const textInput = z.string().trim().min(1).max(160);
const searchInventoryInput = z.object({ query: textInput }).strict();
const itemInput = z.object({ item_id: textInput }).strict();
const locationInput = z.object({ location: textInput }).strict();
const kitInput = z.object({ kit: textInput.optional() }).strict();
const emptyInput = z.object({}).strict();

function safeAsset(asset: StudentAsset) {
  return {
    id: asset.id,
    shelfId: asset.sequentialId,
    title: asset.title,
    type: asset.type,
    category: asset.category?.name ?? null,
    quantity: asset.quantity,
    availableQuantity: asset.availableQuantity,
    availableToBook: asset.availableToBook,
    status: asset.status,
    locations: asset.locations,
    kits: asset.kits,
    qrIds: asset.qrIds,
  };
}

function flattenLocations(
  locations: StudentLocation[],
  parentPath: string[] = []
): Array<{ location: StudentLocation; path: string[] }> {
  return locations.flatMap((location) => {
    const path = [...parentPath, location.name];
    return [{ location, path }, ...flattenLocations(location.children, path)];
  });
}

function findLocation(locations: StudentLocation[], value: string) {
  const normalized = value.toLowerCase();
  return flattenLocations(locations).find(
    ({ location }) =>
      location.id === value || location.name.toLowerCase() === normalized
  );
}

function safeLocation(location: StudentLocation, path: string[]) {
  return {
    id: location.id,
    name: location.name,
    path,
    parentId: location.parentId,
    directAssetCount: location.assetCount,
    children: location.children.map((child) => ({
      id: child.id,
      name: child.name,
      directAssetCount: child.assetCount,
    })),
  };
}

function safeKit(kit: Awaited<ReturnType<typeof getStudentKits>>[number]) {
  return {
    id: kit.id,
    name: kit.name,
    status: kit.status,
    availableToBook: kit.availableToBook,
    location: kit.location,
    qrIds: kit.qrCodes.map((qr) => qr.id),
    contents: kit.assetKits.map(({ quantity, asset }) => ({
      quantity,
      id: asset.id,
      title: asset.title,
      type: asset.type,
      totalQuantity: asset.quantity,
    })),
  };
}

function toolError(message: string) {
  return { ok: false as const, error: message };
}

type ToolRequestContext = Pick<LoaderFunctionArgs, "context" | "request"> & {
  /** Internal Ollama path: keep resolved rows server-side for aggregation/UI. */
  includePresentationAssets?: boolean;
  requestId?: string;
};

/**
 * Execute one and only one of the explicit read-only tools. Authorization is
 * repeated here rather than trusted from the caller so a future MCP adapter
 * cannot accidentally execute a tool without the current Shelf session.
 */
export async function executeIoioReadOnlyTool(
  name: string,
  input: unknown,
  {
    context,
    request,
    includePresentationAssets = false,
    requestId,
  }: ToolRequestContext
) {
  const startedAt = Date.now();
  const sessionUserId = context.getSession().userId;
  let organizationId: string | undefined;
  let diagnosticSearchQuery: string | undefined;
  let diagnosticMatchNames: string[] = [];
  let diagnosticMatchCount: number | undefined;
  let diagnosticMatchType: "exact" | "fuzzy" | "ambiguous" | "none" = "none";

  try {
    const auth = await requireStudentRead({ context, request });
    organizationId = auth.organizationId;

    let result: unknown;
    switch (name) {
      case "search_inventory": {
        const { query } = searchInventoryInput.parse(input);
        diagnosticSearchQuery = sanitizeConversationContent(query).slice(
          0,
          160
        );
        const assets = await getStudentAssets({ organizationId, query });
        if (assets.length) {
          diagnosticMatchType = "exact";
          diagnosticMatchCount = assets.length;
          diagnosticMatchNames = assets
            .slice(0, 12)
            .map(({ title }) => title.slice(0, 120));
          result = {
            ok: true,
            matchType: "exact",
            assets: assets.slice(0, 20).map(safeAsset),
            ...(includePresentationAssets
              ? { presentationAssets: assets }
              : {}),
          };
          break;
        }

        const fuzzy = await findStudentAssetFuzzyMatches({
          organizationId,
          query,
        });
        if (fuzzy.kind === "ambiguous") {
          diagnosticMatchType = "ambiguous";
          diagnosticMatchCount = fuzzy.matches.length;
          diagnosticMatchNames = fuzzy.matches.map(({ name }) => name);
          result = {
            ok: true,
            matchType: "ambiguous",
            assets: [],
            suggestions: fuzzy.matches.map(({ name }) => name),
          };
          break;
        }
        if (fuzzy.kind === "unique") {
          const match = fuzzy.matches[0];
          const fuzzyAssets = (
            await Promise.all(
              match.assetIds.map((assetId) =>
                getStudentAsset({
                  organizationId: auth.organizationId,
                  assetId,
                })
              )
            )
          ).filter((asset): asset is StudentAsset => asset !== null);
          diagnosticMatchType = "fuzzy";
          diagnosticMatchCount = fuzzyAssets.length;
          diagnosticMatchNames = [match.name];
          result = {
            ok: true,
            matchType: "fuzzy",
            matchedName: match.name,
            assets: fuzzyAssets.slice(0, 20).map(safeAsset),
            ...(includePresentationAssets
              ? { presentationAssets: fuzzyAssets }
              : {}),
          };
          break;
        }
        diagnosticMatchType = "none";
        diagnosticMatchCount = 0;
        result = { ok: true, matchType: "none", assets: [] };
        break;
      }
      case "get_item": {
        const { item_id } = itemInput.parse(input);
        const exactAsset = await getStudentAsset({
          organizationId,
          assetId: item_id,
        });
        const asset =
          exactAsset ??
          (await getStudentAssets({ organizationId, query: item_id })).find(
            (candidate) =>
              candidate.id === item_id || candidate.sequentialId === item_id
          );
        result = asset
          ? { ok: true, asset: safeAsset(asset) }
          : toolError("No matching Shelf inventory record was found.");
        break;
      }
      case "get_location": {
        const { location } = locationInput.parse(input);
        const locations = await getStudentLocations({ organizationId });
        const match = findLocation(locations, location);
        result = match
          ? { ok: true, location: safeLocation(match.location, match.path) }
          : toolError("No matching Shelf location was found.");
        break;
      }
      case "get_location_contents": {
        const { location } = locationInput.parse(input);
        const locations = await getStudentLocations({ organizationId });
        const match = findLocation(locations, location);
        result = match
          ? {
              ok: true,
              location: safeLocation(match.location, match.path),
              assets: (
                await getStudentAssets({
                  organizationId,
                  locationId: match.location.id,
                })
              )
                .slice(0, 50)
                .map(safeAsset),
            }
          : toolError("No matching Shelf location was found.");
        break;
      }
      case "get_kit_status": {
        const { kit: kitValue } = kitInput.parse(input);
        const kits = await getStudentKits({ organizationId });
        if (!kitValue) {
          result = { ok: true, kits: kits.map(safeKit) };
          break;
        }
        const normalized = kitValue.toLowerCase();
        const kit = kits.find(
          (candidate) =>
            candidate.id === kitValue ||
            candidate.name.toLowerCase() === normalized
        );
        result = kit
          ? { ok: true, kit: safeKit(kit) }
          : toolError("No matching Shelf kit was found.");
        break;
      }
      case "get_my_loans": {
        emptyInput.parse(input);
        const loans = await getMyStudentLoans({
          organizationId,
          userId: auth.userId,
        });
        result = {
          ok: true,
          loans: loans.map((loan) => ({
            id: loan.id,
            name: loan.name,
            status: loan.status,
            from: loan.from,
            to: loan.to,
            assets: loan.bookingAssets.map(
              ({ id: bookingAssetId, quantity, asset }) => ({
                bookingAssetId,
                quantity,
                id: asset.id,
                title: asset.title,
              })
            ),
          })),
        };
        break;
      }
      default:
        result = toolError("This tool is not available.");
    }

    Logger.info({
      event: "ioio_read_only_tool",
      requestId,
      tool: name,
      userId: sessionUserId,
      organizationId,
      success: true,
      durationMs: Date.now() - startedAt,
      ...(process.env.NODE_ENV !== "production" && name === "search_inventory"
        ? {
            searchQuery: diagnosticSearchQuery,
            matchCount: diagnosticMatchCount,
            matchedNames: diagnosticMatchNames,
            matchType: diagnosticMatchType,
          }
        : {}),
    });
    return result;
  } catch (cause) {
    Logger.warn({
      event: "ioio_read_only_tool",
      requestId,
      tool: name,
      userId: sessionUserId,
      organizationId,
      success: false,
      durationMs: Date.now() - startedAt,
      error: cause instanceof Error ? cause.name : "UnknownError",
    });
    throw cause;
  }
}
