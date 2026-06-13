import type { QueryCtx } from "./_generated/server";
import { trigrams } from "./tokenizer";
import { typoBudget, levenshtein } from "./fuzzy";

export const EXACT = 3;
export const PREFIX = 2;
// A typo at edit distance d scores 2 - 0.5*d (1 typo -> 1.5, 2 typos -> 1.0).
const typoScore = (d: number) => 2 - 0.5 * d;

// High code point used as an exclusive upper bound for a prefix range scan.
const HIGH = "￿";

// Returns a map of candidate term -> best match score for one query token.
export async function candidateTermsForToken(
  ctx: QueryCtx,
  collection: string,
  token: string,
  isLast: boolean,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const setBest = (term: string, score: number) => {
    const cur = out.get(term);
    if (cur === undefined || score > cur) out.set(term, score);
  };

  // 1. Exact
  const exact = await ctx.db
    .query("terms")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", token),
    )
    .unique();
  if (exact) setBest(token, EXACT);

  // 2. Prefix (last token only)
  if (isLast) {
    const rows = await ctx.db
      .query("terms")
      .withIndex("by_collection_term", (q) =>
        q.eq("collection", collection).gte("term", token).lt("term", token + HIGH),
      )
      .collect();
    for (const r of rows) setBest(r.term, PREFIX);
  }

  // 3. Fuzzy (trigram candidates + bounded Levenshtein)
  const budget = typoBudget(token.length);
  if (budget > 0) {
    const grams = trigrams(token);
    const overlap = new Map<string, number>();
    for (const gram of grams) {
      const rows = await ctx.db
        .query("trigrams")
        .withIndex("by_collection_gram", (q) =>
          q.eq("collection", collection).eq("gram", gram),
        )
        .collect();
      for (const r of rows) overlap.set(r.term, (overlap.get(r.term) ?? 0) + 1);
    }
    const threshold = Math.max(1, grams.length - budget * 3);
    for (const [term, count] of overlap) {
      if (count < threshold) continue;
      if (out.get(term) === EXACT) continue;
      const d = levenshtein(token, term, budget);
      if (d <= budget) setBest(term, typoScore(d));
    }
  }

  return out;
}
