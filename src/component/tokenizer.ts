// Split on anything that is NOT a Unicode letter or number, lowercase each token.
// Shared by both indexing (write.ts) and querying (search.ts) so they can never
// disagree on tokenization.
const SEPARATORS = /[^\p{L}\p{N}]+/u;

export function tokenize(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  return text
    .toLowerCase()
    .split(SEPARATORS)
    .filter((t) => t.length > 0);
}

// Generate de-duplicated contiguous 3-grams of a term, preserving first-seen order.
// Terms shorter than 3 chars yield the whole term as a single gram. Shared by
// write-path indexing and query-time fuzzy candidate generation.
export function trigrams(term: string): string[] {
  if (typeof term !== "string" || term.length === 0) return [];
  if (term.length < 3) return [term];
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i + 3 <= term.length; i++) {
    const g = term.slice(i, i + 3);
    if (!seen.has(g)) {
      seen.add(g);
      out.push(g);
    }
  }
  return out;
}
