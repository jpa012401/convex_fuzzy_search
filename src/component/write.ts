import { mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc as ConvexDoc } from "./_generated/dataModel";
import { v } from "convex/values";
import { requireCollection } from "./collections";
import { addDoc, removeDoc } from "./counters";
import { incrementFacet, decrementFacet } from "./facetCounts";
import { addSortEntry, removeSortEntry } from "./sortIndex";
import { projectToSlots } from "./searchWrite";

type Doc = Record<string, unknown>;
export const MAX_UPSERT_MANY_BATCH = 50;

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
// ops. Returns whether a row existed (so callers know whether to addDoc/removeDoc).
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
  col: ConvexDoc<"collections">,
): Promise<{ existed: boolean }> {
  const existing = await loadSearchDoc(ctx, collection, docId);
  if (!existing) return { existed: false };

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

  await ctx.db.delete(existing._id);
  return { existed: true };
}

async function upsertInternal(
  ctx: MutationCtx,
  collection: string,
  id: string,
  doc: Doc,
) {
  const col = await requireCollection(ctx, collection);
  const { existed } = await clearDoc(ctx, collection, id, col);

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
    const { existed } = await clearDoc(ctx, args.collection, args.id, col);
    if (existed) await removeDoc(ctx, args.collection, args.id);
    return null;
  },
});

export const upsertMany = mutation({
  args: {
    collection: v.string(),
    docs: v.array(v.object({ id: v.string(), doc: v.any() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (args.docs.length > MAX_UPSERT_MANY_BATCH) {
      throw new Error(`upsertMany accepts at most ${MAX_UPSERT_MANY_BATCH} documents per call`);
    }
    await requireCollection(ctx, args.collection);
    for (const { id, doc } of args.docs) {
      await upsertInternal(ctx, args.collection, id, doc as Doc);
    }
    return null;
  },
});

export { deleteDoc as delete };
