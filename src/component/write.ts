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
import { ensureDocKey, loadDocumentByDocId } from "./docKeys";
import {
  addPostingEntries,
  deleteDocTerms,
  loadDocTerms,
  removePostingEntries,
  upsertDocTerms,
} from "./postingChunks";
import type { DocTerm } from "./postingChunks";

type Doc = Record<string, unknown>;
export const MAX_UPSERT_MANY_BATCH = 50;

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

// Delete a doc's index rows + document row; return its distinct terms (pre-deletion).
async function clearDoc(
  ctx: MutationCtx,
  collection: string,
  docId: string,
  facetFields: string[],
  sortSpecs: SortKey[][],
  filterFields: { field: string; type: "string" | "number" }[],
): Promise<{ oldTerms: Set<string>; existed: boolean }> {
  // At most one filters row per declared filterField for this doc, so the read
  // is bounded by config, not by collection size.
  const filt = await ctx.db
    .query("filters")
    .withIndex("by_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .take(filterFields.length);
  for (const r of filt) await ctx.db.delete(r._id);

  const existing = await loadDocumentByDocId(ctx, collection, docId);
  const oldTermEntries = existing
    ? await loadDocTerms(ctx, collection, existing.docKey)
    : [];
  const oldTerms = new Set<string>(oldTermEntries.map((p) => p.term));
  if (existing) {
    await removePostingEntries(ctx, collection, existing.docKey, oldTermEntries);
    await deleteDocTerms(ctx, collection, existing.docKey);
    const stored = existing.stored as Record<string, unknown>;
    // Facet invariant: incrementFacet (on upsert) stringifies the RAW input
    // value; this decrement stringifies the PROJECTED stored value. They net to
    // zero only because every projection mode preserves facet-field values
    // identically — keep facet fields in any explicit storedFields projection.
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
  const docKey = await ensureDocKey(ctx, collection, id);
  const { oldTerms, existed } = await clearDoc(ctx, collection, id, col.facetFields ?? [], col.sortSpecs ?? [], col.filterFields ?? []);

  const newTerms = new Set<string>();
  const termEntries: DocTerm[] = [];
  for (const field of col.searchFields) {
    const value = doc[field];
    if (typeof value !== "string") continue;
    const counts = new Map<string, number>();
    for (const term of tokenize(value)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      newTerms.add(term);
    }
    for (const [term, tf] of counts) {
      termEntries.push({ term, field, tf });
    }
  }
  await addPostingEntries(ctx, collection, docKey, termEntries);
  await upsertDocTerms(ctx, collection, docKey, termEntries);

  await ctx.db.insert("documents", {
    collection,
    docId: id,
    docKey,
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
    const { oldTerms, existed } = await clearDoc(ctx, args.collection, args.id, col.facetFields ?? [], col.sortSpecs ?? [], col.filterFields ?? []);
    await applyTermDiff(ctx, args.collection, oldTerms, new Set());
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
