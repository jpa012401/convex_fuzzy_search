export type RankBy = { text?: number; fields?: { field: string; weight: number }[] };
export type SortKey = { field: string; order: "asc" | "desc" };

// Coerce a stored field to a number for sorting/ranking. A MISSING field or a
// non-numeric value yields 0 — so an absent numeric sort field orders as a zero
// (interleaved with real zeros), NOT last. encodeKey and evalTerms rely on this.
export function numField(stored: Record<string, unknown>, field: string): number {
  const v = Number(stored[field]);
  return Number.isNaN(v) ? 0 : v;
}

// The relevance score used for ordering: raw text_match, optionally blended with
// weighted numeric fields (Elasticsearch field_value_factor style).
export function orderingScore(
  textMatch: number,
  stored: Record<string, unknown>,
  rankBy: RankBy | undefined,
): number {
  if (!rankBy) return textMatch;
  let s = (rankBy.text ?? 1) * textMatch;
  for (const { field, weight } of rankBy.fields ?? []) {
    s += weight * numField(stored, field);
  }
  return s;
}

// Comparator over docIds. `_text_match` keys use the supplied ordering score;
// other keys use the stored field coerced to number. Default sort is score desc.
// Final tie-break is docId ascending for deterministic output.
export function compareMatches(
  a: string,
  b: string,
  ctx: {
    score: (id: string) => number;
    stored: (id: string) => Record<string, unknown>;
    sortBy?: SortKey[];
  },
): number {
  const keys: SortKey[] = ctx.sortBy ?? [{ field: "_text_match", order: "desc" }];
  for (const k of keys) {
    const va = k.field === "_text_match" ? ctx.score(a) : numField(ctx.stored(a), k.field);
    const vb = k.field === "_text_match" ? ctx.score(b) : numField(ctx.stored(b), k.field);
    if (va !== vb) return k.order === "asc" ? va - vb : vb - va;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
