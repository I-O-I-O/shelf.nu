import { parse } from "csv-parse/sync";

export const SPREADSHEET_BATCH_SIZE = 30;
export const MISSING_FORMULA_VALUE = "[formula has no stored value]";
export function normalizeSpreadsheetHeader(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\-.:]+/g, " ")
    .replace(/\s+/g, " ");
}

/** Parse each possible delimiter with the CSV parser, including quoted fields. */
export function readSpreadsheetCsv(buffer: Buffer): string[][] {
  const candidates = [",", ";", "\t"].flatMap((delimiter) => {
    try {
      const rows = parse(buffer.toString("utf8"), {
        delimiter,
        bom: true,
        skip_empty_lines: false,
        relax_column_count: true,
        max_record_size: 100_000,
      }) as string[][];
      const widths = new Map<number, number>();
      for (const row of rows.slice(0, 50))
        if (row.length > 1)
          widths.set(row.length, (widths.get(row.length) ?? 0) + 1);
      return [{ rows, score: Math.max(0, ...widths.values()) }];
    } catch {
      return [];
    }
  });
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates[0]?.score)
    throw new Error("csv_parse_failed: No consistent delimited table found.");
  return candidates[0].rows;
}

export function detectSpreadsheetHeader(
  matrix: string[][],
  aliases: Record<string, string>
): { index: number; ambiguous: boolean } | null {
  const candidates = matrix
    .slice(0, 40)
    .flatMap((cells, index) => {
      const fields = cells
        .map((cell) => aliases[normalizeSpreadsheetHeader(cell)])
        .filter(Boolean);
      const unique = new Set(fields);
      if (
        !unique.has("title") &&
        !unique.has("sourceDescription") &&
        !unique.has("manufacturerPartNumber") &&
        !unique.has("supplierPartNumber")
      )
        return [];
      if (unique.size < 2) return [];
      const populatedBelow = matrix
        .slice(index + 1, index + 5)
        .filter((row) => row.some((cell) => cell.trim())).length;
      const quantityColumns = cells.flatMap((cell, column) =>
        /quantity/i.test(aliases[normalizeSpreadsheetHeader(cell)] ?? "")
          ? [column]
          : []
      );
      const typedValues = matrix
        .slice(index + 1, index + 5)
        .reduce(
          (count, row) =>
            count +
            quantityColumns.filter((column) =>
              /^\d+(?:[.,]0+)?$/.test(row[column]?.trim() ?? "")
            ).length,
          0
        );
      return [
        {
          index,
          score:
            unique.size * 4 +
            populatedBelow +
            typedValues -
            cells.filter((cell) => !cell.trim()).length * 0.2,
        },
      ];
    })
    .sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;
  return {
    index: candidates[0].index,
    ambiguous: Boolean(
      candidates[1] && candidates[0].score === candidates[1].score
    ),
  };
}

export function isSpreadsheetNonProduct(cells: string[], identity: string) {
  return (
    !cells.some((cell) => cell.trim()) ||
    /^(total|grand total|subtotal|vat(?:\s|$)|tax(?:\s|$)|freight|shipping|invoice|notes?\s*:)/i.test(
      identity.trim()
    )
  );
}
