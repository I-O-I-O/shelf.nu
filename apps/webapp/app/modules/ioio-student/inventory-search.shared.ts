export type FuzzyInventoryCandidate = {
  productId: string;
  name: string;
  score: number;
  assetIds: string[];
};

export type FuzzyInventoryResolution = {
  kind: "none" | "unique" | "ambiguous";
  matches: FuzzyInventoryCandidate[];
};

/** Group physical units under their canonical logical product and only accept
 * a typo match when its trigram score is credible and clearly ahead. */
export function resolveFuzzyInventoryCandidates(
  candidates: readonly FuzzyInventoryCandidate[],
  { minimumScore = 0.35, minimumLead = 0.08 } = {}
): FuzzyInventoryResolution {
  const grouped = new Map<string, FuzzyInventoryCandidate>();
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.score) || candidate.score < minimumScore) {
      continue;
    }
    const current = grouped.get(candidate.productId);
    if (current) {
      current.score = Math.max(current.score, candidate.score);
      current.assetIds = [
        ...new Set([...current.assetIds, ...candidate.assetIds]),
      ];
    } else {
      grouped.set(candidate.productId, {
        ...candidate,
        assetIds: [...new Set(candidate.assetIds)],
      });
    }
  }
  const matches = [...grouped.values()].sort(
    (left, right) =>
      right.score - left.score || left.name.localeCompare(right.name)
  );
  if (!matches.length) return { kind: "none", matches: [] };
  if (matches[1] && matches[0].score - matches[1].score < minimumLead) {
    return { kind: "ambiguous", matches: matches.slice(0, 3) };
  }
  return { kind: "unique", matches: [matches[0]] };
}
