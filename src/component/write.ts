import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { applyTermDiff } from "./terms";

type Doc = Record<string, unknown>;

function project(doc: Doc, storedFields: "all" | string[]): Doc {
  if (storedFields === "all") return doc;
  const out: Doc = {};
  for (const f of storedFields) {
    if (f in doc) out[f] = doc[f];
  }
  return out;
}

// Delete a doc's postings + document row; return its distinct terms (pre-deletion).
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
): Promise<Set<string>> {
  const postings = await ctx.db
    .query("postings")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .collect();
  const oldTerms = new Set<string>(postings.map((p) => p.term));
  for (const p of postings) await ctx.db.delete(p._id);

  const existing = await ctx.db
    .query("documents")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
  if (existing) await ctx.db.delete(existing._id);

  return oldTerms;
}

async function upsertInternal(
  ctx: MutationCtx,
  collection: string,
  id: string,
  doc: Doc,
) {
  const col = await requireCollection(ctx, collection);
  const oldTerms = await clearDoc(ctx, collection, id);

  const newTerms = new Set<string>();
  for (const field of col.searchFields) {
    const value = doc[field];
    if (typeof value !== "string") continue;
    const counts = new Map<string, number>();
    for (const term of tokenize(value)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      newTerms.add(term);
    }
    for (const [term, tf] of counts) {
      await ctx.db.insert("postings", { collection, term, docId: id, field, tf });
    }
  }

  await ctx.db.insert("documents", {
    collection,
    docId: id,
    stored: project(doc, col.storedFields),
  });

  await applyTermDiff(ctx, collection, oldTerms, newTerms);
}

export const upsert = mutation({
  args: { collection: v.string(), id: v.string(), doc: v.any() },
  handler: async (ctx, args) =>
    upsertInternal(ctx, args.collection, args.id, args.doc as Doc),
});

export const deleteDoc = mutation({
  args: { collection: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collection);
    const oldTerms = await clearDoc(ctx, args.collection, args.id);
    await applyTermDiff(ctx, args.collection, oldTerms, new Set());
  },
});

export const upsertMany = mutation({
  args: {
    collection: v.string(),
    docs: v.array(v.object({ id: v.string(), doc: v.any() })),
  },
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collection);
    for (const { id, doc } of args.docs) {
      await upsertInternal(ctx, args.collection, id, doc as Doc);
    }
  },
});

export { deleteDoc as delete };
