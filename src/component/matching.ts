import type { QueryCtx } from "./_generated/server";
import { trigrams } from "./tokenizer";
import { typoBudget, levenshtein } from "./fuzzy";

export const EXACT = 3;
export const PREFIX = 2;
export const TERM_CANDIDATE_BUDGET = 200;
// A typo at edit distance d scores 2 - 0.5*d (1 typo -> 1.5, 2 typos -> 1.0).
const typoScore = (d: number) => 2 - 0.5 * d;

// High code point used as an exclusive upper bound for a prefix range scan.
const HIGH = "￿";

// Returns a map of candidate term -> best match score and document frequency for one query token.
export async function candidateTermsForToken(
  ctx: QueryCtx,
  collection: string,
  token: string,
  isLast: boolean,
  budget: number = TERM_CANDIDATE_BUDGET,
): Promise<{
  candidates: Map<string, { score: number; docCount: number }>;
  truncated: boolean;
}> {
  const out = new Map<string, { score: number; docCount: number }>();
  let reads = 0;
  let truncated = false;
  const setBest = (term: string, score: number, docCount: number) => {
    const cur = out.get(term);
    if (cur === undefined || score > cur.score) out.set(term, { score, docCount });
  };
  const hasBudget = () => {
    if (reads < budget) return true;
    truncated = true;
    return false;
  };

  // 1. Exact
  const exact = await ctx.db
    .query("terms")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", token),
    )
    .unique();
  if (exact) setBest(token, EXACT, exact.docCount);

  // 2. Prefix (last token only)
  if (isLast) {
    const rows = ctx.db
      .query("terms")
      .withIndex("by_collection_term", (q) =>
        q.eq("collection", collection).gte("term", token).lt("term", token + HIGH),
      );
    for await (const r of rows) {
      if (!hasBudget()) break;
      reads++;
      setBest(r.term, PREFIX, r.docCount);
    }
  }

  // 3. Fuzzy (trigram candidates + bounded Levenshtein)
  const maxTypos = typoBudget(token.length);
  if (maxTypos > 0) {
    const grams = trigrams(token);
    const overlap = new Map<string, number>();
    for (const gram of grams) {
      const rows = ctx.db
        .query("trigrams")
        .withIndex("by_collection_gram", (q) =>
          q.eq("collection", collection).eq("gram", gram),
        );
      for await (const r of rows) {
        if (!hasBudget()) break;
        reads++;
        overlap.set(r.term, (overlap.get(r.term) ?? 0) + 1);
      }
      if (truncated) break;
    }
    const threshold = Math.max(1, grams.length - maxTypos * 3);
    for (const [term, count] of overlap) {
      if (count < threshold) continue;
      if (out.get(term)?.score === EXACT) continue;
      const d = levenshtein(token, term, maxTypos);
      if (d <= maxTypos) {
        const row = await ctx.db
          .query("terms")
          .withIndex("by_collection_term", (q) =>
            q.eq("collection", collection).eq("term", term),
          )
          .unique();
        setBest(term, typoScore(d), row?.docCount ?? 0);
      }
    }
  }

  return { candidates: out, truncated };
}
