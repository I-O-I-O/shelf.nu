import { parse } from "csv-parse/sync";

/** Source labels are evidence, not database IDs or authorization scope. */
export type InventorySourceFields = {
  sourceOrganization: string | null;
  sourceRoom: string | null;
  sourceStorageLocation: string;
  sourceItemName: string;
  quantity: number | null;
  quantityIsEstimated: boolean;
};
export type ExplicitInventorySourceRow = InventorySourceFields & {
  sourceRef: string;
  page: number;
  sourceText: string;
  description: string | null;
};
const BIN = /^[A-Z]\d{1,3}-\d{1,3}$/iu;
const label = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
const quantity = (value: string) => {
  const raw = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/u.test(raw)) return null;
  const count = Number(raw.replaceAll(",", ""));
  return count > 0 && count <= 1_000_000 ? count : null;
};

function sourceContext(line: string) {
  const lab =
    line.match(/^(?:lab|organization)\s*:\s*([^|,;]+)/iu) ??
    line.match(/^(IOIO\s+Lab)\b/iu);
  const room = /^(?:room\b|IOIO\s+Lab\b|lab\s*:|organization\s*:)/iu.test(line)
    ? line.match(/\broom\s*:?\s*([A-Z]\d{2,5})\b/iu)?.[1].toUpperCase()
    : undefined;
  return { organization: lab?.[1].trim(), room };
}

/** Unique document metadata is authoritative even when printed after a table. */
export function getInventoryDocumentContext(
  pages: readonly { text: string }[]
) {
  const contexts = pages.flatMap((page) =>
    page.text.split(/\r?\n/u).map((line) => sourceContext(line.trim()))
  );
  const organizations = [
    ...new Set(
      contexts.flatMap((context) =>
        context.organization ? [context.organization] : []
      )
    ),
  ];
  const rooms = [
    ...new Set(
      contexts.flatMap((context) => (context.room ? [context.room] : []))
    ),
  ];
  return {
    sourceOrganization: organizations.length === 1 ? organizations[0] : null,
    sourceRoom: rooms.length === 1 ? rooms[0] : null,
  };
}

/** Parse explicit inventory tables, not invoices or arbitrary numerical prose.
 * Supports delimited rows and PDF text layers with one table cell per line. */
export function parseExplicitInventorySources(
  pages: readonly { sourceRef: string; page: number; text: string }[]
): ExplicitInventorySourceRow[] {
  const rows: ExplicitInventorySourceRow[] = [];
  let { sourceOrganization, sourceRoom } = getInventoryDocumentContext(pages);
  let header: string[] | null = null;
  for (const page of pages) {
    const lines = page.text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const context = sourceContext(line);
      if (context.organization) sourceOrganization = context.organization;
      if (context.room) sourceRoom = context.room;
      const inline = line.match(
        /^(IOIO\s+Lab),\s*room\s*:?\s*([A-Z]\d{2,5}),\s*([A-Z]\d{1,3}-\d{1,3}),\s*(.+?),\s*estimated\s+quantity\s*:?\s*(\d+(?:,\d{3})*)\s*$/iu
      );
      if (inline) {
        rows.push({
          sourceRef: page.sourceRef,
          page: page.page,
          sourceText: line,
          sourceOrganization: inline[1],
          sourceRoom: inline[2].toUpperCase(),
          sourceStorageLocation: inline[3].toUpperCase(),
          sourceItemName: inline[4].trim(),
          quantity: quantity(inline[5]),
          quantityIsEstimated: true,
          description: null,
        });
        continue;
      }
      const delimiter = line.includes("|")
        ? "|"
        : line.includes("\t")
        ? "\t"
        : line.includes(",")
        ? ","
        : null;
      let cells: string[] = [];
      if (delimiter) {
        try {
          cells =
            (
              parse(line, {
                delimiter,
                trim: true,
                relax_quotes: true,
              }) as string[][]
            )[0] ?? [];
        } catch {
          continue;
        }
      }
      if (!delimiter && label(line) === "location") {
        const candidateHeader = lines.slice(index, index + 4).map(label);
        if (
          candidateHeader[1] === "item" &&
          ["quantity", "estimated quantity"].includes(candidateHeader[2]) &&
          candidateHeader[3] === "description"
        ) {
          header = candidateHeader;
          index += 3;
          continue;
        }
      }
      const normalized = cells.map(label);
      const isHeader =
        normalized.includes("location") &&
        normalized.some((cell) =>
          ["item", "item name", "product", "product name"].includes(cell)
        ) &&
        normalized.some((cell) =>
          ["quantity", "estimated quantity", "qty"].includes(cell)
        );
      if (isHeader) {
        header = normalized;
        continue;
      }
      if (
        /^location\s+item\s+(?:estimated\s+)?quantity\s+description$/iu.test(
          line
        )
      ) {
        header = [
          "location",
          "item",
          /estimated/iu.test(line) ? "estimated quantity" : "quantity",
          "description",
        ];
        continue;
      }
      let sourceText = line;
      if (
        !delimiter &&
        BIN.test(line) &&
        header?.length === 4 &&
        header[0] === "location" &&
        lines.slice(index + 1, index + 4).length === 3
      ) {
        cells = lines.slice(index, index + 4);
        if (!quantity(cells[2]) || BIN.test(cells[1]) || BIN.test(cells[3]))
          continue;
        sourceText = cells.join("\n");
        index += 3;
      }
      // Headerless tuples are accepted only with an explicit bin/name/count.
      const columns = header ?? ["location", "item", "quantity", "description"];
      const binIndex = columns.indexOf("location");
      const nameIndex = columns.findIndex((cell) =>
        ["item", "item name", "product", "product name"].includes(cell)
      );
      const countIndex = columns.findIndex((cell) =>
        ["quantity", "estimated quantity", "qty"].includes(cell)
      );
      const bin = cells[binIndex]?.toUpperCase();
      const name = cells[nameIndex]?.trim();
      if (!bin || !BIN.test(bin) || !name || cells[countIndex] === undefined)
        continue;
      const count =
        header && cells.length > header.length
          ? null
          : quantity(cells[countIndex]);
      if (!header && (count === null || (!sourceOrganization && !sourceRoom)))
        continue;
      const roomCell = cells[columns.indexOf("room")]?.trim();
      const labIndex = columns.findIndex((cell) =>
        ["lab", "organization"].includes(cell)
      );
      rows.push({
        sourceRef: page.sourceRef,
        page: page.page,
        sourceText,
        sourceOrganization: cells[labIndex]?.trim() || sourceOrganization,
        sourceRoom: roomCell
          ? /^(?:room\s*:?\s*)?[A-Z]\d{2,5}$/iu.test(roomCell)
            ? roomCell.replace(/^room\s*:?\s*/iu, "").toUpperCase()
            : null
          : sourceRoom,
        sourceStorageLocation: bin,
        sourceItemName: name,
        quantity: count,
        quantityIsEstimated: columns[countIndex] === "estimated quantity",
        description: cells[columns.indexOf("description")]?.trim() || null,
      });
    }
  }
  return rows;
}

/** Resolve only the explicitly named bin, constrained by its room ancestor.
 * Missing/duplicate bins remain unresolved; never substitute the room itself. */
export function resolveExplicitInventoryLocation<
  T extends {
    id: string;
    name: string;
    parentId: string | null;
    operational?: boolean;
  },
>(
  source: Pick<InventorySourceFields, "sourceRoom" | "sourceStorageLocation">,
  locations: readonly T[]
): { location: T; roomLocationId: string | null } | null {
  const byId = new Map(locations.map((location) => [location.id, location]));
  const matches = locations
    .filter(
      (location) =>
        !location.operational &&
        location.name
          .trim()
          .toUpperCase()
          .replace(/^(?:CONTAINER|BIN)\s+/u, "") ===
          source.sourceStorageLocation.trim().toUpperCase()
    )
    .flatMap<{ location: T; roomLocationId: string | null }>((location) => {
      let parent = location.parentId ? byId.get(location.parentId) : undefined;
      const seen = new Set([location.id]);
      while (parent && !seen.has(parent.id)) {
        seen.add(parent.id);
        if (
          source.sourceRoom &&
          parent.name
            .toUpperCase()
            .split(/[^A-Z0-9]+/u)
            .includes(source.sourceRoom.toUpperCase())
        )
          return [{ location, roomLocationId: parent.id }];
        parent = parent.parentId ? byId.get(parent.parentId) : undefined;
      }
      return source.sourceRoom ? [] : [{ location, roomLocationId: null }];
    });
  return matches.length === 1 ? matches[0] : null;
}

/** A page-wide quote or repeated bin is ambiguous, not a row-order join. */
export function matchExplicitInventorySource(
  evidence: readonly { sourceRef: string; text: string }[],
  sources: readonly ExplicitInventorySourceRow[]
) {
  const matches = sources.filter((source) =>
    evidence.some((quote) => {
      if (quote.sourceRef !== source.sourceRef) return false;
      const bins: string[] =
        quote.text.toUpperCase().match(/\b[A-Z]\d{1,3}-\d{1,3}\b/gu) ?? [];
      return bins.length
        ? bins.includes(source.sourceStorageLocation)
        : quote.text.includes(source.sourceItemName);
    })
  );
  return matches.length === 1 ? matches[0] : null;
}
