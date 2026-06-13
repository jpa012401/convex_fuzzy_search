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
