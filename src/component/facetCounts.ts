import type { MutationCtx, QueryCtx } from "./_generated/server";

export const FACET_VALUE_READ_BUDGET = 200;

// Increment the count for one (collection, field, value), creating the row on
// first sight. Used by the write path when a doc gains a facet value.
export async function incrementFacet(
  ctx: MutationCtx,
  collection: string,
  field: string,
  value: string,
) {
  const row = await ctx.db
    .query("facetCounts")
    .withIndex("by_value", (q) =>
      q.eq("collection", collection).eq("field", field).eq("value", value),
    )
    .unique();
  if (row) await ctx.db.patch(row._id, { count: row.count + 1 });
  else await ctx.db.insert("facetCounts", { collection, field, value, count: 1 });
}

// Decrement the count for one (collection, field, value). Deletes the row when
// it reaches zero (no zero-count rows kept). Missing row -> safe no-op.
export async function decrementFacet(
  ctx: MutationCtx,
  collection: string,
  field: string,
  value: string,
) {
  const row = await ctx.db
    .query("facetCounts")
    .withIndex("by_value", (q) =>
      q.eq("collection", collection).eq("field", field).eq("value", value),
    )
    .unique();
  if (!row) return;
  if (row.count <= 1) await ctx.db.delete(row._id);
  else await ctx.db.patch(row._id, { count: row.count - 1 });
}

// Top `maxValues` (value, count) for a field, sorted count desc then value asc
// — identical ordering to the in-memory facet tally in search.ts. Bounded by
// the field's cardinality, not by the document count.
export async function readFacetCounts(
  ctx: QueryCtx,
  collection: string,
  field: string,
  maxValues: number,
): Promise<{ value: string; count: number }[]> {
  const rows = await ctx.db
    .query("facetCounts")
    .withIndex("by_field", (q) => q.eq("collection", collection).eq("field", field))
    .take(FACET_VALUE_READ_BUDGET);
  return rows
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .slice(0, Math.max(0, maxValues))
    .map((r) => ({ value: r.value, count: r.count }));
}

// Distinct values of a facet field (bounded by FACET_VALUE_READ_BUDGET), for
// driving the filtered-facet intersection.
export async function facetValuesForField(
  ctx: QueryCtx,
  collection: string,
  field: string,
): Promise<string[]> {
  const rows = await ctx.db
    .query("facetCounts")
    .withIndex("by_field", (q) => q.eq("collection", collection).eq("field", field))
    .take(FACET_VALUE_READ_BUDGET);
  return rows.map((r) => r.value);
}

// Delete all facetCounts rows for a collection (used by deleteCollection and by
// the backfill's clear-then-rebuild). by_field's prefix is [collection], so
// eq("collection", ...) enumerates every (field, value) row for the collection.
export async function clearCollectionFacets(
  ctx: MutationCtx,
  collection: string,
) {
  const rows = await ctx.db
    .query("facetCounts")
    .withIndex("by_field", (q) => q.eq("collection", collection))
    .collect();
  for (const r of rows) await ctx.db.delete(r._id);
}
