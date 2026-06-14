import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { addDoc } from "./counters";

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
