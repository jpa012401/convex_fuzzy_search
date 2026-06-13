import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";

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
    storedFields: v.optional(
      v.union(v.literal("all"), v.array(v.string())),
    ),
  },
  handler: async (ctx, args) => {
    const existing = await loadCollection(ctx, args.name);
    if (existing !== null) {
      throw new Error(`Collection "${args.name}" already exists`);
    }
    await ctx.db.insert("collections", {
      name: args.name,
      searchFields: args.searchFields,
      storedFields: args.storedFields ?? "all",
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
    await ctx.db.delete(c._id);
  },
});
