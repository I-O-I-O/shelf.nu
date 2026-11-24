/** Small English inflection rules, not a product synonym dictionary. */
export function inventoryWordVariants(word: string): string[] {
  const value = word.toLowerCase();
  if (!/^[a-z]{4,}$/u.test(value)) return [value];
  let singular = value;
  if (/[^aeiou]ies$/u.test(value)) singular = `${value.slice(0, -3)}y`;
  else if (/(?:ches|shes|xes|zes|sses)$/u.test(value))
    singular = value.slice(0, -2);
  else if (/s$/u.test(value) && !/(?:ss|us|is)$/u.test(value))
    singular = value.slice(0, -1);
  const plural = /[^aeiou]y$/u.test(singular)
    ? `${singular.slice(0, -1)}ies`
    : /(?:ch|sh|x|z|ss)$/u.test(singular)
    ? `${singular}es`
    : `${singular}s`;
  return [...new Set([value, singular, plural])];
}

export function inventorySearchTokens(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Used for relevance only; stored names and identifiers are never rewritten. */
export function inventorySearchScore(text: string, query: string): number {
  const words = inventorySearchTokens(text);
  const terms = inventorySearchTokens(query).slice(0, 12);
  if (!terms.length) return 0;
  const normalized = words.join(" ");
  const phrase = terms.join(" ");
  if (normalized === phrase) return 500;
  if (` ${normalized} `.includes(` ${phrase} `)) return 400;
  if (terms.every((term) => words.includes(term))) return 300;
  if (
    terms.every((term) =>
      inventoryWordVariants(term).some((variant) => words.includes(variant))
    )
  )
    return 200;
  if (
    terms.every((term) =>
      inventoryWordVariants(term).some((variant) =>
        words.some((word) => word.includes(variant))
      )
    )
  )
    return 100;
  return 0;
}
