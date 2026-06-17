import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

export async function loadDocumentByDocId(
  ctx: QueryCtx,
  collection: string,
  docId: string,
): Promise<Doc<"documents"> | null> {
  return await ctx.db
    .query("documents")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
}

export async function loadDocumentByDocKey(
  ctx: QueryCtx,
  collection: string,
  docKey: number,
): Promise<Doc<"documents"> | null> {
  return await ctx.db
    .query("documents")
    .withIndex("by_collection_docKey", (q) =>
      q.eq("collection", collection).eq("docKey", docKey),
    )
    .unique();
}

export async function ensureDocKey(
  ctx: MutationCtx,
  collection: string,
  docId: string,
): Promise<number> {
  const existing = await loadDocumentByDocId(ctx, collection, docId);
  if (existing) return existing.docKey;

  const counter = await ctx.db
    .query("docKeyCounters")
    .withIndex("by_collection", (q) => q.eq("collection", collection))
    .unique();

  if (counter) {
    const docKey = counter.nextDocKey;
    await ctx.db.patch(counter._id, { nextDocKey: docKey + 1 });
    return docKey;
  }

  await ctx.db.insert("docKeyCounters", { collection, nextDocKey: 1 });
  return 0;
}
