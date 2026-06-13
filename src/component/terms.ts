import type { MutationCtx } from "./_generated/server";
import { trigrams } from "./tokenizer";

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
  await ctx.db.delete(row._id);
  const grams = await ctx.db
    .query("trigrams")
    .withIndex("by_collection_term", (q) =>
      q.eq("collection", collection).eq("term", term),
    )
    .collect();
  for (const g of grams) await ctx.db.delete(g._id);
}

// Apply the difference between a document's previous and current distinct terms.
export async function applyTermDiff(
  ctx: MutationCtx,
  collection: string,
  oldTerms: Set<string>,
  newTerms: Set<string>,
) {
  for (const term of newTerms) {
    if (!oldTerms.has(term)) await incTerm(ctx, collection, term);
  }
  for (const term of oldTerms) {
    if (!newTerms.has(term)) await decTerm(ctx, collection, term);
  }
}
