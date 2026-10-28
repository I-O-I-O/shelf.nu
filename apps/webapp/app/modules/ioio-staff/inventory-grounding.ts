export type InventoryReference = {
  name: string;
  contextualQuantity?: number;
  currentLocationRef?: { name: string; withinRef?: { name: string } };
};
export type ProductResolution = {
  reference: InventoryReference;
  status: "EXACT" | "NORMALIZED" | "FUZZY_UNIQUE" | "AMBIGUOUS" | "NOT_FOUND";
  modelId: string | null;
  candidates: Array<{ id: string; name: string }>;
};
export const normalizeInventoryName = (text: string) =>
  text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
/** Canonical phrase matching is independent of instruction wording. Longest spans win. */
export function findMentionedProducts(
  instruction: string,
  catalog: Array<{ id: string; name: string }>
): InventoryReference[] {
  const text = ` ${normalizeInventoryName(instruction)} `;
  const spans: Array<{ start: number; end: number; name: string }> = [];
  for (const model of catalog) {
    const phrase = ` ${normalizeInventoryName(model.name)} `;
    let start = text.indexOf(phrase);
    while (start >= 0) {
      spans.push({ start, end: start + phrase.length, name: model.name });
      start = text.indexOf(phrase, start + 1);
    }
  }
  return [
    ...new Map(
      spans
        .filter(
          (span) =>
            !spans.some(
              (other) =>
                other.start <= span.start &&
                other.end >= span.end &&
                other.end - other.start > span.end - span.start
            )
        )
        .sort((a, b) => a.start - b.start)
        .map(({ name }) => [normalizeInventoryName(name), { name }])
    ).values(),
  ];
}
function distance(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 2) return Infinity;
  let prior = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        row[j - 1] + 1,
        prior[j] + 1,
        prior[j - 1] + Number(a[i - 1] !== b[j - 1])
      );
    if (Math.min(...row) > 2) return Infinity;
    prior = row;
  }
  return prior[b.length];
}
export function resolveInventoryReference(
  reference: InventoryReference,
  catalog: Array<{ id: string; name: string }>
): ProductResolution {
  const normalized = normalizeInventoryName(reference.name);
  // Case variants of the same canonical name still require review when duplicate models exist.
  const exact = catalog.filter(
    (model) => model.name.toLowerCase() === reference.name.trim().toLowerCase()
  );
  const matches = exact.length
    ? exact
    : catalog.filter(
        (model) => normalizeInventoryName(model.name) === normalized
      );
  if (matches.length)
    return {
      reference,
      status:
        matches.length > 1
          ? "AMBIGUOUS"
          : exact.length
          ? "EXACT"
          : "NORMALIZED",
      modelId: matches.length === 1 ? matches[0].id : null,
      candidates: matches,
    };
  const fuzzy =
    normalized.length >= 5
      ? catalog.filter(
          (model) =>
            distance(normalized, normalizeInventoryName(model.name)) <=
            Math.min(2, Math.max(1, Math.floor(normalized.length / 6)))
        )
      : [];
  if (!fuzzy.length) {
    const tokens = normalized.split(" ");
    const plausible =
      normalized.length >= 4
        ? catalog.filter((model) =>
            tokens.every((token) =>
              normalizeInventoryName(model.name).split(" ").includes(token)
            )
          )
        : [];
    if (plausible.length)
      return {
        reference,
        status: "AMBIGUOUS",
        modelId: null,
        candidates: plausible.slice(0, 20),
      };
  }
  return {
    reference,
    status:
      fuzzy.length === 1
        ? "FUZZY_UNIQUE"
        : fuzzy.length
        ? "AMBIGUOUS"
        : "NOT_FOUND",
    modelId: fuzzy.length === 1 ? fuzzy[0].id : null,
    candidates: fuzzy,
  };
}
