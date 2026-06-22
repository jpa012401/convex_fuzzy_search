import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Doc as ConvexDoc } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireCollection } from "./collections";
import { addDoc, removeDoc } from "./counters";
import { incrementFacet, decrementFacet } from "./facetCounts";
import { addSortEntry, removeSortEntry } from "./sortIndex";
import { projectToSlots } from "./searchWrite";
import { tokenize } from "./tokenizer";
import { applyTermDiff } from "./termDict";

type Doc = Record<string, unknown>;

// Per spec §6a: the bound is on ROW WRITES, not a magic doc count. Hybrid upsert
// writes ~1 searchDocs row + a few aggregate/facet ops per doc. Keep a generous
// per-slice write budget under the per-mutation write limit; chain the remainder.
const WRITES_PER_DOC = 12; // 1 searchDocs row + bounded facet/sort/aggregate ops headroom
const UPSERT_MANY_MAX_WRITES = 3000;
export const UPSERT_MANY_BATCH = Math.max(1, Math.floor(UPSERT_MANY_MAX_WRITES / WRITES_PER_DOC));

// Load the single searchDocs row for (collection, docId), or null.
async function loadSearchDoc(ctx: MutationCtx, collection: string, docId: string) {
  return await ctx.db
    .query("searchDocs")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
}

// Delete a doc's single searchDocs row and reverse the kept aggregate/facet-table
// ops. Returns whether a row existed and the set of vocabulary terms from the
// prior row (so callers can pass them to applyTermDiff).
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
  col: ConvexDoc<"collections">,
): Promise<{ existed: boolean; oldTerms: Set<string> }> {
  const existing = await loadSearchDoc(ctx, collection, docId);
  if (!existing) return { existed: false, oldTerms: new Set() };

  const stored = existing.stored as Record<string, unknown>;

  // Facet invariant (preserved from the prior write path): incrementFacet on
  // upsert stringifies the RAW input value; this decrement stringifies the
  // PROJECTED stored value. They net to zero only because every projection mode
  // preserves facet-field values identically — keep facet fields in any explicit
  // storedFields projection.
  for (const field of col.facetFields ?? []) {
    const raw = stored[field];
    if (raw === undefined || raw === null) continue;
    await decrementFacet(ctx, collection, field, String(raw));
  }

  for (const spec of col.sortSpecs ?? []) {
    await removeSortEntry(ctx, collection, spec, stored, docId);
  }

  // Collect the vocabulary terms from the existing row. text0 is the
  // concatenation of all searchFields — tokenizing it gives the full per-doc
  // term set without needing the raw doc.
  const oldTerms = new Set(tokenize(String(existing.text0 ?? "")));

  await ctx.db.delete(existing._id);
  return { existed: true, oldTerms };
}

async function upsertInternal(
  ctx: MutationCtx,
  collection: string,
  id: string,
  doc: Doc,
) {
  const col = await requireCollection(ctx, collection);
  const { existed, oldTerms } = await clearDoc(ctx, collection, id, col);

  // ONE searchDocs row via the pure slot projection (requires col.slotMap; F9
  // guarantees create/apply persisted it before any upsert).
  // Cast needed: SearchDocRow uses Partial<Record<SlotKey, string|number>> (union
  // for the shared SlotKey type) but the schema validator separates filt* (string)
  // from numF* (number). At runtime the projection always writes the correct type.
  const slots = projectToSlots(doc, col);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await ctx.db.insert("searchDocs", { collection, docId: id, ...slots } as any);

  // Facet counts on the facetCounts TABLE (F5) — stringify the RAW input value.
  for (const field of col.facetFields ?? []) {
    const raw = doc[field];
    if (raw === undefined || raw === null) continue;
    await incrementFacet(ctx, collection, field, String(raw));
  }

  // Sort aggregate entries from the (possibly projected) stored values, keyed by
  // the raw doc — addSortEntry encodes stored via numField, matching reads.
  for (const spec of col.sortSpecs ?? []) {
    await addSortEntry(ctx, collection, spec, doc, id);
  }

  // Maintain vocabulary dictionary. Compute newTerms from the searchFields text.
  // Tokenize each searchField value from the raw doc and union the results.
  const newTerms = new Set<string>();
  for (const field of col.searchFields) {
    const val = doc[field];
    if (typeof val === "string") {
      for (const tok of tokenize(val)) newTerms.add(tok);
    }
  }
  await applyTermDiff(ctx, collection, oldTerms, newTerms);

  if (!existed) await addDoc(ctx, collection, id);
}

export const upsert = mutation({
  args: { collection: v.string(), id: v.string(), doc: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await upsertInternal(ctx, args.collection, args.id, args.doc as Doc);
    return null;
  },
});

export const deleteDoc = mutation({
  args: { collection: v.string(), id: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const col = await requireCollection(ctx, args.collection);
    const { existed, oldTerms } = await clearDoc(ctx, args.collection, args.id, col);
    if (existed) {
      await applyTermDiff(ctx, args.collection, oldTerms, new Set());
      await removeDoc(ctx, args.collection, args.id);
    }
    return null;
  },
});

// Shared slice-process-and-chain helper used by both upsertMany and upsertManyChain.
// Processes up to UPSERT_MANY_BATCH docs and schedules the remainder via
// internal.write.upsertManyChain when more docs remain.
async function processUpsertSlice(
  ctx: MutationCtx,
  collection: string,
  docs: Array<{ id: string; doc: unknown }>,
): Promise<null> {
  const slice = docs.slice(0, UPSERT_MANY_BATCH);
  for (const { id, doc } of slice) {
    await upsertInternal(ctx, collection, id, doc as Doc);
  }
  const rest = docs.slice(UPSERT_MANY_BATCH);
  if (rest.length > 0) {
    await ctx.scheduler.runAfter(0, internal.write.upsertManyChain, {
      collection,
      docs: rest,
    });
  }
  return null;
}

export const upsertMany = mutation({
  args: {
    collection: v.string(),
    docs: v.array(v.object({ id: v.string(), doc: v.any() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collection);
    return processUpsertSlice(ctx, args.collection, args.docs);
  },
});

export const upsertManyChain = internalMutation({
  args: {
    collection: v.string(),
    docs: v.array(v.object({ id: v.string(), doc: v.any() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireCollection(ctx, args.collection);
    return processUpsertSlice(ctx, args.collection, args.docs);
  },
});

export { deleteDoc as delete };
