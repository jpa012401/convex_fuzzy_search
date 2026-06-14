import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { addDoc } from "./counters";
import { requireCollection } from "./collections";
import { incrementFacet, clearCollectionFacets } from "./facetCounts";
import { addSortEntry } from "./sortIndex";

// Backfill the doc counter for a collection, one bounded page at a time.
// Returns the next cursor (null when done). Idempotent (addDoc uses
// insertIfDoesNotExist), so safe to re-run. For deployments that indexed
// documents before the S1 counter existed.
//
// Note: paginate() is not available inside a Convex component, so we page
// manually over the by_collection_doc index using the last docId as the
// cursor. docId is the second key of that index, so rows for a collection
// come back in docId order and `gt("docId", cursor)` resumes after the page.
export const backfillCounterPage = mutation({
  args: {
    collection: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batch: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batch = args.batch ?? 200;
    const after = args.cursor ?? null;
    const page = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) =>
        after === null
          ? q.eq("collection", args.collection)
          : q.eq("collection", args.collection).gt("docId", after),
      )
      .take(batch + 1);

    const rows = page.slice(0, batch);
    for (const d of rows) await addDoc(ctx, args.collection, d.docId);

    const done = page.length <= batch;
    const cursor = done ? null : rows[rows.length - 1].docId;
    return { cursor, done };
  },
});

// Backfill (rebuild) the `filters` index rows for a collection, one bounded
// page at a time. Re-derives each doc's filter rows from its `stored` snapshot
// using the collection's `filterFields`. Idempotent: clears the doc's existing
// filter rows then re-inserts, so safe to re-run. For deployments that indexed
// documents before the S2 filter index existed (the write path now maintains
// these rows automatically). Same manual cursor paging as backfillCounterPage.
export const backfillFiltersPage = mutation({
  args: {
    collection: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batch: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const col = await requireCollection(ctx, args.collection);
    const batch = args.batch ?? 200;
    const cursor = args.cursor ?? null;
    const page = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) =>
        cursor === null
          ? q.eq("collection", args.collection)
          : q.eq("collection", args.collection).gt("docId", cursor),
      )
      .take(batch + 1);
    const rows = page.slice(0, batch);
    for (const d of rows) {
      const existing = await ctx.db
        .query("filters")
        .withIndex("by_doc", (q) =>
          q.eq("collection", args.collection).eq("docId", d.docId),
        )
        .collect();
      for (const r of existing) await ctx.db.delete(r._id);
      const stored = d.stored as Record<string, unknown>;
      for (const f of col.filterFields ?? []) {
        const value = stored[f.field];
        if (value === undefined || value === null) continue;
        if (f.type === "string") {
          await ctx.db.insert("filters", {
            collection: args.collection,
            field: f.field,
            docId: d.docId,
            strVal: String(value),
          });
        } else {
          const num = Number(value);
          if (!Number.isNaN(num)) {
            await ctx.db.insert("filters", {
              collection: args.collection,
              field: f.field,
              docId: d.docId,
              numVal: num,
            });
          }
        }
      }
    }
    const done = page.length <= batch;
    return { cursor: done ? null : rows[rows.length - 1].docId, done };
  },
});

// Backfill (rebuild) the `facetCounts` rows for a collection, one bounded page
// at a time. Re-derives each doc's declared facet values from its `stored`
// snapshot and increments the counters. Idempotent via clear-then-rebuild: on
// the first page (cursor === null) it clears the collection's existing facet
// rows, so a full run from the start is safe to repeat. For deployments that
// indexed documents before the S3 facet counters existed (the write path now
// maintains these automatically). Same manual cursor paging as the others.
export const backfillFacetCountsPage = mutation({
  args: {
    collection: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batch: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const col = await requireCollection(ctx, args.collection);
    const batch = args.batch ?? 100;
    const cursor = args.cursor ?? null;
    // First page clears existing counts so the whole run is idempotent.
    if (cursor === null) await clearCollectionFacets(ctx, args.collection);
    const page = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) =>
        cursor === null
          ? q.eq("collection", args.collection)
          : q.eq("collection", args.collection).gt("docId", cursor),
      )
      .take(batch + 1);
    const rows = page.slice(0, batch);
    for (const d of rows) {
      const stored = d.stored as Record<string, unknown>;
      for (const field of col.facetFields ?? []) {
        const raw = stored[field];
        if (raw === undefined || raw === null) continue;
        await incrementFacet(ctx, args.collection, field, String(raw));
      }
    }
    const done = page.length <= batch;
    return { cursor: done ? null : rows[rows.length - 1].docId, done };
  },
});

// Backfill (rebuild) the sort-index entries for a collection, one bounded page
// at a time. Re-derives each doc's composite key per declared sortSpec from its
// `stored` snapshot and inserts it. Idempotent by construction
// (insertIfDoesNotExist with a deterministic key), so safe to re-run; no
// clear-then-rebuild needed. For deployments that indexed documents before the
// S4 sort index existed (the write path now maintains entries automatically).
// Same manual cursor paging as the other backfills.
export const backfillSortIndexPage = mutation({
  args: {
    collection: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batch: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const col = await requireCollection(ctx, args.collection);
    const batch = args.batch ?? 100;
    const cursor = args.cursor ?? null;
    const page = await ctx.db
      .query("documents")
      .withIndex("by_collection_doc", (q) =>
        cursor === null
          ? q.eq("collection", args.collection)
          : q.eq("collection", args.collection).gt("docId", cursor),
      )
      .take(batch + 1);
    const rows = page.slice(0, batch);
    for (const d of rows) {
      const stored = d.stored as Record<string, unknown>;
      for (const spec of col.sortSpecs ?? []) {
        await addSortEntry(ctx, args.collection, spec, stored, d.docId);
      }
    }
    const done = page.length <= batch;
    return { cursor: done ? null : rows[rows.length - 1].docId, done };
  },
});
