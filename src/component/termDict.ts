import type { MutationCtx, QueryCtx } from "./_generated/server";
import { trigrams } from "./tokenizer";
import { typoBudget, levenshtein } from "./fuzzy";

// ---------------------------------------------------------------------------
// Write-side: ref-counted vocabulary dictionary
// ---------------------------------------------------------------------------

async function loadTerm(ctx: MutationCtx, collection: string, term: string) {
  return await ctx.db
    .query("terms")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", term),
    )
    .unique();
}

async function incTerm(ctx: MutationCtx, collection: string, term: string) {
  const row = await loadTerm(ctx, collection, term);
  if (row) {
    await ctx.db.patch(row._id, { docCount: row.docCount + 1 });
    return;
  }
  await ctx.db.insert("terms", { collection, term, docCount: 1 });
  for (const gram of trigrams(term)) {
    await ctx.db.insert("trigrams", { collection, gram, term });
  }
}

async function decTerm(ctx: MutationCtx, collection: string, term: string) {
  const row = await loadTerm(ctx, collection, term);
  if (!row) return;
  if (row.docCount > 1) {
    await ctx.db.patch(row._id, { docCount: row.docCount - 1 });
    return;
  }
  // docCount reaches 0: remove the term row and all its trigram rows.
  await ctx.db.delete(row._id);
  const grams = await ctx.db
    .query("trigrams")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", term),
    )
    .collect();
  for (const g of grams) await ctx.db.delete(g._id);
}

/**
 * Delete one bounded batch of this collection's dictionary rows (terms + trigrams).
 * Returns true when BOTH tables are drained for the collection. Paged via .take()
 * so it never reads proportional to vocabulary size in one call.
 */
export async function clearCollectionTermsBatch(
  ctx: MutationCtx,
  collection: string,
  batchSize: number,
): Promise<boolean> {
  const terms = await ctx.db
    .query("terms")
    .withIndex("by_collection_term", (q) => q.eq("collection", collection))
    .take(batchSize);
  if (terms.length > 0) {
    for (const r of terms) await ctx.db.delete(r._id);
    return false;
  }
  const grams = await ctx.db
    .query("trigrams")
    .withIndex("by_collection_term", (q) => q.eq("collection", collection))
    .take(batchSize);
  if (grams.length > 0) {
    for (const r of grams) await ctx.db.delete(r._id);
    return false;
  }
  return true;
}

/**
 * Diff-maintain the vocabulary dictionary when a doc is inserted/updated/deleted.
 *
 * oldTerms: the set of unique tokens that were in the doc before this write.
 * newTerms: the set of unique tokens in the doc after this write.
 *
 * Call with (oldTerms=empty, newTerms=docTokens) on insert.
 * Call with (oldTerms=priorTokens, newTerms=docTokens) on update.
 * Call with (oldTerms=priorTokens, newTerms=empty) on delete.
 */
export async function applyTermDiff(
  ctx: MutationCtx,
  collection: string,
  oldTerms: Set<string>,
  newTerms: Set<string>,
): Promise<void> {
  for (const term of newTerms) {
    if (!oldTerms.has(term)) await incTerm(ctx, collection, term);
  }
  for (const term of oldTerms) {
    if (!newTerms.has(term)) await decTerm(ctx, collection, term);
  }
}

// ---------------------------------------------------------------------------
// Query-side: trigram-based typo correction, budget-capped at `budget` reads
// ---------------------------------------------------------------------------

/**
 * Suggest the best corpus terms that are within typoBudget edit-distance of
 * the given token. Returns [] when the token is too short to tolerate typos
 * (<=3 chars), or when no dictionary term is within budget.
 *
 * Results are sorted by Levenshtein distance ascending (closest match first).
 * Budget caps the total number of trigrams table rows read to avoid
 * accidentally scanning a large vocabulary.
 */
export async function suggestTerms(
  ctx: QueryCtx,
  collection: string,
  token: string,
  budget: number = 200,
): Promise<string[]> {
  const maxTypos = typoBudget(token.length);
  if (maxTypos === 0) return [];

  const grams = trigrams(token);
  if (grams.length === 0) return [];

  // Count how many trigrams of `token` each dictionary term shares.
  const overlap = new Map<string, number>();
  let reads = 0;

  outer: for (const gram of grams) {
    const rows = ctx.db
      .query("trigrams")
      .withIndex("by_collection_gram", (q) =>
        q.eq("collection", collection).eq("gram", gram),
      );
    for await (const r of rows) {
      reads++;
      overlap.set(r.term, (overlap.get(r.term) ?? 0) + 1);
      if (reads >= budget) break outer;
    }
  }

  // Filter candidates by minimum overlap threshold (trigram filter).
  // A term with k shared trigrams out of T(token) trigrams is a candidate when
  // k >= max(1, T(token) - maxTypos*3).
  const threshold = Math.max(1, grams.length - maxTypos * 3);

  // Verify each candidate with exact bounded Levenshtein.
  const results: Array<{ term: string; dist: number }> = [];
  for (const [term, count] of overlap) {
    if (count < threshold) continue;
    const d = levenshtein(token, term, maxTypos);
    if (d <= maxTypos) {
      results.push({ term, dist: d });
    }
  }

  // Sort by edit distance ascending (closest first), then lexicographic for
  // deterministic ties.
  results.sort((a, b) => a.dist - b.dist || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0));
  return results.map((r) => r.term);
}
