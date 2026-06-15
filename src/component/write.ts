import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc as ConvexDoc } from "./_generated/dataModel";
import { v } from "convex/values";
import { tokenize } from "./tokenizer";
import { requireCollection } from "./collections";
import { applyTermDiff } from "./terms";
import { addDoc, removeDoc } from "./counters";
import { incrementFacet, decrementFacet } from "./facetCounts";
import { addSortEntry, removeSortEntry } from "./sortIndex";
import type { SortKey } from "./ranking";
import { indexRelevantFields } from "./storedFields";

type Doc = Record<string, unknown>;

function project(doc: Doc, col: ConvexDoc<"collections">): Doc {
  const storedFields = col.storedFields;
  if (storedFields === "all") return doc;
  const keep = storedFields === "derived" ? indexRelevantFields(col) : storedFields;
  const out: Doc = {};
  for (const f of keep) {
    if (f in doc) out[f] = doc[f];
  }
  return out;
}

// Delete a doc's postings + document row; return its distinct terms (pre-deletion).
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
  facetFields: string[],
  sortSpecs: SortKey[][],
): Promise<{ oldTerms: Set<string>; existed: boolean }> {
  const postings = await ctx.db
    .query("postings")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .collect();
  const oldTerms = new Set<string>(postings.map((p) => p.term));
  for (const p of postings) await ctx.db.delete(p._id);

  const filt = await ctx.db
    .query("filters")
    .withIndex("by_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .collect();
  for (const r of filt) await ctx.db.delete(r._id);

  const existing = await ctx.db
    .query("documents")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
  if (existing) {
    const stored = existing.stored as Record<string, unknown>;
    for (const field of facetFields) {
      const raw = stored[field];
      if (raw === undefined || raw === null) continue;
      await decrementFacet(ctx, collection, field, String(raw));
    }
    for (const spec of sortSpecs) {
      await removeSortEntry(ctx, collection, spec, stored, docId);
    }
    await ctx.db.delete(existing._id);
  }

  return { oldTerms, existed: existing !== null };
}

async function upsertInternal(
  ctx: MutationCtx,
  collection: string,
  id: string,
  doc: Doc,
) {
  const col = await requireCollection(ctx, collection);
  const { oldTerms, existed } = await clearDoc(ctx, collection, id, col.facetFields ?? [], col.sortSpecs ?? []);

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
    stored: project(doc, col),
  });

  for (const f of col.filterFields ?? []) {
    const value = doc[f.field];
    if (value === undefined || value === null) continue;
    if (f.type === "string") {
      await ctx.db.insert("filters", {
        collection,
        field: f.field,
        docId: id,
        strVal: String(value),
      });
    } else {
      const num = Number(value);
      if (!Number.isNaN(num)) {
        await ctx.db.insert("filters", {
          collection,
          field: f.field,
          docId: id,
          numVal: num,
        });
      }
    }
  }

  for (const field of col.facetFields ?? []) {
    const raw = doc[field];
    if (raw === undefined || raw === null) continue;
    await incrementFacet(ctx, collection, field, String(raw));
  }

  for (const spec of col.sortSpecs ?? []) {
    await addSortEntry(ctx, collection, spec, doc, id);
  }

  await applyTermDiff(ctx, collection, oldTerms, newTerms);
  if (!existed) await addDoc(ctx, collection, id);
}

export const upsert = mutation({
  args: { collection: v.string(), id: v.string(), doc: v.any() },
  handler: async (ctx, args) =>
    upsertInternal(ctx, args.collection, args.id, args.doc as Doc),
});

export const deleteDoc = mutation({
  args: { collection: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    const col = await requireCollection(ctx, args.collection);
    const { oldTerms, existed } = await clearDoc(ctx, args.collection, args.id, col.facetFields ?? [], col.sortSpecs ?? []);
    await applyTermDiff(ctx, args.collection, oldTerms, new Set());
    if (existed) await removeDoc(ctx, args.collection, args.id);
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
