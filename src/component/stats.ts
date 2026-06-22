import { query } from "./_generated/server";
import { v } from "convex/values";
import { requireCollection } from "./collections";
import { collectionCount } from "./counters";
import { FACET_VALUE_READ_BUDGET } from "./facetCounts";
import { canonicalSpecId, sortSpecCount } from "./sortIndex";
import { statsResultValidator } from "./schema";

// Index-health snapshot for a collection. Reads the live counts maintained in
// the aggregate/counter components so a consumer can validate that every index
// is fully populated: for a healthy, fully-backfilled collection every
// `facets[].total` and every `sortSpecs[].count` should equal `out_of`.
export const stats = query({
  args: { collection: v.string() },
  returns: statsResultValidator,
  handler: async (ctx, args) => {
    const col = await requireCollection(ctx, args.collection);

    // Document counter (the @convex-dev/aggregate docCount component).
    const out_of = await collectionCount(ctx, args.collection);

    // Facet counters (the facetCounts table) — distinct values + summed count
    // per declared facet field. `total` is the number of documents that have a
    // value for that field; it should equal out_of when every doc has the field
    // and the facet backfill has run.
    const facets: { field: string; distinctValues: number; total: number; truncated: boolean }[] = [];
    for (const field of col.facetFields ?? []) {
      const rows = await ctx.db
        .query("facetCounts")
        .withIndex("by_field", (q) =>
          q.eq("collection", args.collection).eq("field", field),
        )
        .take(FACET_VALUE_READ_BUDGET + 1);
      const truncated = rows.length > FACET_VALUE_READ_BUDGET;
      const countedRows = rows.slice(0, FACET_VALUE_READ_BUDGET);
      let total = 0;
      for (const r of countedRows) total += r.count;
      facets.push({ field, distinctValues: countedRows.length, total, truncated });
    }

    // Sort index (the @convex-dev/aggregate sortIndex component) — entry count
    // per declared spec. Each should equal out_of once the sort backfill ran.
    const sortSpecs: { specId: string; count: number }[] = [];
    for (const spec of col.sortSpecs ?? []) {
      const specId = canonicalSpecId(spec);
      sortSpecs.push({
        specId,
        count: await sortSpecCount(ctx, args.collection, specId),
      });
    }

    return { out_of, facets, sortSpecs };
  },
});
