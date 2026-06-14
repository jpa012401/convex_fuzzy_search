import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { clearCollectionCount } from "./counters";
import { clearCollectionFacets } from "./facetCounts";
import { clearCollectionSort } from "./sortIndex";

export async function loadCollection(ctx: QueryCtx, name: string) {
  return await ctx.db
    .query("collections")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
}

export async function requireCollection(ctx: QueryCtx, name: string) {
  const c = await loadCollection(ctx, name);
  if (c === null) {
    throw new Error(`CollectionNotFound: "${name}"`);
  }
  return c;
}

export const createCollection = mutation({
  args: {
    name: v.string(),
    searchFields: v.array(v.string()),
    storedFields: v.optional(v.union(v.literal("all"), v.array(v.string()))),
    filterFields: v.optional(
      v.array(
        v.object({
          field: v.string(),
          type: v.union(v.literal("string"), v.literal("number")),
        }),
      ),
    ),
    facetFields: v.optional(v.array(v.string())),
    sortSpecs: v.optional(
      v.array(
        v.array(
          v.object({
            field: v.string(),
            order: v.union(v.literal("asc"), v.literal("desc")),
          }),
        ),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await loadCollection(ctx, args.name);
    if (existing !== null) {
      throw new Error(`Collection "${args.name}" already exists`);
    }
    const storedFields = args.storedFields ?? "all";
    if (storedFields !== "all") {
      const persisted = new Set(storedFields);
      for (const f of args.filterFields ?? []) {
        if (!persisted.has(f.field)) {
          throw new Error(
            `filterFields field "${f.field}" must be included in storedFields`,
          );
        }
      }
      for (const f of args.facetFields ?? []) {
        if (!persisted.has(f)) {
          throw new Error(
            `facetFields field "${f}" must be included in storedFields`,
          );
        }
      }
      for (const spec of args.sortSpecs ?? []) {
        for (const k of spec) {
          if (!persisted.has(k.field)) {
            throw new Error(
              `sortSpecs field "${k.field}" must be included in storedFields`,
            );
          }
        }
      }
    }
    await ctx.db.insert("collections", {
      name: args.name,
      searchFields: args.searchFields,
      storedFields,
      filterFields: args.filterFields,
      facetFields: args.facetFields,
      sortSpecs: args.sortSpecs,
    });
  },
});

export const getCollection = query({
  args: { name: v.string() },
  handler: async (ctx, args) => loadCollection(ctx, args.name),
});

export const deleteCollection = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const c = await requireCollection(ctx, args.name);
    for (const table of ["postings", "documents"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_collection_doc", (q) => q.eq("collection", args.name))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    // terms + trigrams are keyed by [collection, term], not [collection, docId]
    for (const table of ["terms", "trigrams"] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex("by_collection_term", (q) => q.eq("collection", args.name))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
    const filterRows = await ctx.db
      .query("filters")
      .withIndex("by_doc", (q) => q.eq("collection", args.name))
      .collect();
    for (const r of filterRows) await ctx.db.delete(r._id);
    await clearCollectionCount(ctx, args.name);
    await clearCollectionFacets(ctx, args.name);
    await clearCollectionSort(ctx, args.name, c.sortSpecs ?? []);
    await ctx.db.delete(c._id);
  },
});
